import { describe, expect, it, vi } from 'vitest';
import { GuiManager, type GuiTransport } from './manager.js';
import { validGuiRequest, type GuiRequest, type GuiOperation } from './protocol.js';
let sequence = 0;
const request = (operation: GuiOperation, now = Date.now()): GuiRequest => ({
  action: 'gui_request',
  requestId: `r-${++sequence}`,
  deadline: now + 20_000,
  operation,
});
function fixture() {
  let now = Date.now();
  const transport: GuiTransport = {
    observe: vi.fn(async () => ({ data: 'AA==', mediaType: 'image/jpeg' as const, width: 1280, height: 800 })),
    act: vi.fn(async () => {}),
  };
  const manager = new GuiManager(
    async () => transport,
    () => now,
  );
  return {
    manager,
    transport,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function acquire(m: GuiManager, session = 's1', group = 'g1') {
  const r = await m.request(group, session, request({ kind: 'acquire', owner: session }));
  if (!r.ok || !r.lease) throw new Error('Expected lease');
  return r.lease;
}
describe('persistent desktop leases', () => {
  it('allows one holder across sessions, and releases without destroying the transport', async () => {
    const f = fixture();
    const lease = await acquire(f.manager);
    expect(await f.manager.request('g1', 's2', request({ kind: 'acquire', owner: 's2' }))).toEqual({
      ok: false,
      code: 'busy',
    });
    expect(await f.manager.request('g1', 's1', request({ kind: 'release', lease }))).toEqual({ ok: true });
    await acquire(f.manager, 's2');
    expect(f.transport.act).not.toHaveBeenCalled();
  });
  it('rejects another session or group using a leaked lease', async () => {
    const f = fixture();
    const lease = await acquire(f.manager);
    for (const [group, session] of [
      ['g1', 's2'],
      ['g2', 's1'],
    ])
      expect(await f.manager.request(group, session, request({ kind: 'observe', lease }))).toEqual({
        ok: false,
        code: 'expired',
      });
  });
  it('requires a fresh observation for every write and never replays duplicate requests', async () => {
    const f = fixture();
    const lease = await acquire(f.manager);
    const seen = await f.manager.request('g1', 's1', request({ kind: 'observe', lease }));
    if (!seen.ok || !seen.screen) throw new Error();
    const input = request({
      kind: 'act',
      lease,
      observation: seen.screen.observation,
      input: { kind: 'click', x: 20, y: 30 },
    });
    expect(await f.manager.request('g1', 's1', input)).toEqual({ ok: true });
    expect(await f.manager.request('g1', 's1', input)).toEqual({ ok: true });
    expect(f.transport.act).toHaveBeenCalledTimes(1);
    expect(await f.manager.request('g1', 's1', { ...input, requestId: 'other' })).toEqual({
      ok: false,
      code: 'expired',
    });
  });
  it('expires operation rights, retaining the same desktop for a subsequent worker', async () => {
    const f = fixture();
    const old = await acquire(f.manager);
    f.advance(340_000);
    expect(await f.manager.request('g1', 's1', request({ kind: 'observe', lease: old }, f.now()))).toEqual({
      ok: false,
      code: 'expired',
    });
    expect(await f.manager.request('g1', 's2', request({ kind: 'acquire', owner: 'new' }, f.now()))).toMatchObject({
      ok: true,
    });
  });
  it('rejects coordinates outside the actual screen and stale observations', async () => {
    const f = fixture();
    const lease = await acquire(f.manager);
    const seen = await f.manager.request('g1', 's1', request({ kind: 'observe', lease }));
    if (!seen.ok || !seen.screen) throw new Error();
    expect(
      await f.manager.request(
        'g1',
        's1',
        request({ kind: 'act', lease, observation: seen.screen.observation, input: { kind: 'click', x: 1280, y: 2 } }),
      ),
    ).toEqual({ ok: false, code: 'invalid' });
    f.advance(61_000);
    expect(
      await f.manager.request(
        'g1',
        's1',
        request(
          { kind: 'act', lease, observation: seen.screen.observation, input: { kind: 'type', text: 'sample' } },
          f.now(),
        ),
      ),
    ).toEqual({ ok: false, code: 'expired' });
  });
  it('does not accept an old lease after host restart', async () => {
    const f = fixture();
    const old = await acquire(f.manager);
    const restarted = new GuiManager(async () => f.transport);
    expect(await restarted.request('g1', 's1', request({ kind: 'release', lease: old }))).toEqual({
      ok: false,
      code: 'expired',
    });
    await acquire(restarted);
  });
  it('does not free the desktop while an aborted input has not settled', async () => {
    const f = fixture();
    const lease = await acquire(f.manager);
    const seen = await f.manager.request('g1', 's1', request({ kind: 'observe', lease }));
    if (!seen.ok || !seen.screen) throw new Error();
    let finish!: () => void;
    vi.mocked(f.transport.act).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.manager.request(
      'g1',
      's1',
      request({ kind: 'act', lease, observation: seen.screen.observation, input: { kind: 'key', keys: ['enter'] } }),
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    let released = false;
    const release = f.manager.request('g1', 's1', request({ kind: 'release', lease })).then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(released).toBe(false);
    finish();
    await pending;
    await release;
  });
  it('validates deadlines, text bounds and action types at the host boundary', () => {
    expect(validGuiRequest(request({ kind: 'acquire', owner: 'worker' }))).toBe(true);
    expect(validGuiRequest({ ...request({ kind: 'acquire', owner: 'worker' }), deadline: Date.now() - 1 })).toBe(false);
    expect(
      validGuiRequest(
        request({ kind: 'act', lease: 'lease', observation: 'seen', input: { kind: 'type', text: 'x'.repeat(8001) } }),
      ),
    ).toBe(false);
    expect(
      validGuiRequest(
        request({ kind: 'act', lease: 'lease', observation: 'seen', input: { kind: 'click', x: NaN, y: 2 } }),
      ),
    ).toBe(false);
  });
  it('rejects malformed operation values without throwing at the delivery boundary', () => {
    for (const operation of [null, false, 12, 'observe', [], ['lease']])
      expect(validGuiRequest({ ...request({ kind: 'acquire', owner: 'worker' }), operation })).toBe(false);
  });
});
it('pauses the whole group and invalidates the old lease before human control', async () => {
  const f = fixture();
  const old = await acquire(f.manager);
  await f.manager.pause('g1');
  expect(await f.manager.request('g1', 's2', request({ kind: 'acquire', owner: 's2' }))).toEqual({
    ok: false,
    code: 'unavailable',
  });
  f.manager.resume('g1');
  const next = await acquire(f.manager, 's2');
  expect(next).not.toBe(old);
  expect(await f.manager.request('g1', 's1', request({ kind: 'observe', lease: old }))).toEqual({
    ok: false,
    code: 'expired',
  });
});
it('host shutdown revokes input without deleting the desktop transport', async () => {
  const f = fixture();
  await acquire(f.manager);
  await f.manager.stop();
  expect(await f.manager.request('g1', 's1', request({ kind: 'acquire', owner: 'worker' }))).toEqual({
    ok: false,
    code: 'unavailable',
  });
  expect(f.transport.act).not.toHaveBeenCalled();
});
