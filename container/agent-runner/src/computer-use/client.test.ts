import { expect, it } from 'bun:test';
import { createComputerSession, type GuiSend } from './client.js';
import type { GuiOperation } from './protocol.generated.js';
const context = { agentId: 'test', iteration: 1 };
it('returns native image content, consumes observations and only releases rights on close', async () => {
  const calls: GuiOperation[] = [];
  const send: GuiSend = async (op) => {
    calls.push(op);
    if (op.kind === 'acquire') return { ok: true, lease: 'lease' };
    if (op.kind === 'observe')
      return { ok: true, screen: { data: 'AA==', mediaType: 'image/png', width: 10, height: 10, observation: 'seen' } };
    return { ok: true };
  };
  const computer = createComputerSession('worker', send);
  const [observe, act] = computer.tools;
  await computer.start(new AbortController().signal);
  const parts = await observe!.execute({}, context);
  expect(parts).toContainEqual({ type: 'image', data: 'AA==', mediaType: 'image/png' });
  await act!.execute({ kind: 'click', x: 2, y: 3 }, context);
  await expect(act!.execute({ kind: 'type', text: 'sample' }, context)).rejects.toThrow('gui_observe');
  await computer.close();
  expect(calls.map((c) => c.kind)).toEqual(['acquire', 'observe', 'act', 'release']);
  await expect(observe!.execute({}, context)).rejects.toThrow('inactive');
});
it('reacquires the same persistent desktop on resumed execution, using a fresh observation', async () => {
  let acquired = 0;
  const send: GuiSend = async (op) =>
    op.kind === 'acquire' ? { ok: true, lease: `lease-${++acquired}` } : { ok: true };
  const c = createComputerSession('worker', send);
  await c.start(new AbortController().signal);
  await c.close();
  await c.start(new AbortController().signal);
  await expect(c.tools[1]!.execute({ kind: 'click', x: 1, y: 1 }, context)).rejects.toThrow('gui_observe');
  expect(acquired).toBe(2);
  await c.close();
});
it('rejects oversized images and honors worker cancellation', async () => {
  const controller = new AbortController();
  const c = createComputerSession('worker', async (op) =>
    op.kind === 'acquire'
      ? { ok: true, lease: 'lease' }
      : {
          ok: true,
          screen: { data: 'A'.repeat(800_000), mediaType: 'image/png', width: 10, height: 10, observation: 'seen' },
        },
  );
  await c.start(controller.signal);
  await expect(c.tools[0]!.execute({}, context)).rejects.toThrow('Invalid GUI image');
  controller.abort();
  await expect(c.tools[0]!.execute({}, context)).rejects.toThrow();
  await c.close();
});
it('invalidates the previous observation when a fresh observation fails', async () => {
  let observations = 0;
  const c = createComputerSession('worker', async (op) => {
    if (op.kind === 'acquire') return { ok: true, lease: 'lease' };
    if (op.kind === 'observe') {
      if (++observations > 1) return { ok: false, code: 'unavailable' };
      return { ok: true, screen: { data: 'AA==', mediaType: 'image/png', width: 10, height: 10, observation: 'seen' } };
    }
    return { ok: true };
  });
  await c.start(new AbortController().signal);
  try {
    await c.tools[0]!.execute({}, context);
    await expect(c.tools[0]!.execute({}, context)).rejects.toThrow('observation unavailable');
    await expect(c.tools[1]!.execute({ kind: 'click', x: 2, y: 3 }, context)).rejects.toThrow('gui_observe');
  } finally {
    await c.close();
  }
});
