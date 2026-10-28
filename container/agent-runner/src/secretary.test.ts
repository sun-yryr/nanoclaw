import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, reminderTimes, type Item } from '../../skills/secretary/ledger.ts';
import { ApiError, syncMail, syncCalendar, synchronize, type Request } from '../../skills/secretary/google.ts';
import {
  installTask,
  scheduleReminders,
  notify,
  reconcileNotifications,
  remind,
  type Transport,
} from '../../skills/secretary/runtime.ts';
import { decide, gate } from '../../skills/secretary/cli.ts';

const dirs: string[] = [];
const dbs: Ledger[] = [];
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'secretary-test-'));
  dirs.push(dir);
  const l = new Ledger(join(dir, 'ledger.db'));
  dbs.push(l);
  l.configure({ account: 'test@example.com', calendars: ['primary'], destination: 'general', timezone: 'Asia/Tokyo' });
  return l;
}
afterEach(() => {
  for (const l of dbs.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true });
});
const item = (extra: Partial<Item> = {}): Item => ({
  id: 'report',
  title: 'Report',
  source: 'https://example.com/mail',
  evidence: 'due date in message',
  state: 'todo',
  due: '2026-10-25T08:00:00.000Z',
  dateOnly: false,
  timezone: 'Asia/Tokyo',
  revision: 0,
  ...extra,
});
function fakeTransport() {
  const sent: { id: string; text: string }[] = [];
  const receipts = new Map<string, 'confirmed' | 'failed'>();
  const io: Transport = {
    sessionId: 'session-1',
    async send(id, destination, text) {
      expect(destination).toBe('general');
      sent.push({ id, text });
    },
    async receipt(id) {
      return receipts.get(id) ?? null;
    },
    async exists(id) {
      return sent.some((s) => s.id === id);
    },
    async close() {},
  };
  return { io, sent, receipts };
}
function tasks() {
  let rows: any[] = [];
  const calls: string[] = [];
  return {
    calls,
    rows: () => rows,
    call: async (verb: string, args: any) => {
      calls.push(verb);
      if (verb === 'list') return rows;
      if (verb === 'create') {
        const r = { series_id: `${args.name}-abcd`, status: 'pending', ...args };
        rows.push(r);
        return r;
      }
      if (verb === 'cancel') rows = rows.filter((r) => r.series_id !== args.id);
      return {};
    },
  };
}

describe('secretary deadlines and durable state', () => {
  test('timestamps, local date reminders, DST and expired deadlines', () => {
    expect(reminderTimes(item(), '2026-10-20T00:00:00.000Z')).toEqual([
      '2026-10-24T08:00:00.000Z',
      '2026-10-25T06:00:00.000Z',
    ]);
    expect(reminderTimes(item({ due: '2026-10-25', dateOnly: true }), '2026-10-20T00:00:00.000Z')).toEqual([
      '2026-10-24T00:00:00.000Z',
      '2026-10-25T00:00:00.000Z',
    ]);
    expect(
      reminderTimes(
        item({ due: '2026-11-01', dateOnly: true, timezone: 'America/New_York' }),
        '2026-10-20T00:00:00.000Z',
      ),
    ).toEqual(['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z']);
    expect(reminderTimes(item(), '2026-10-25T07:00:00.000Z')).toEqual(['2026-10-25T07:00:00.000Z']);
    expect(reminderTimes(item(), '2026-10-26T00:00:00.000Z')).toEqual([]);
  });
  test('revision conflicts and date validation; completion invalidates prior reminders', () => {
    const l = ledger();
    l.putItem(item(), 0, '2026-10-20T00:00:00.000Z');
    expect(() => l.putItem(item(), 0)).toThrow('Revision conflict');
    expect(() => l.putItem(item({ due: '2026-02-30', dateOnly: true }), 1)).toThrow();
    const r = l.db.query('SELECT id FROM reminders LIMIT 1').get() as any;
    l.putItem(item({ state: 'done' }), 1);
    expect(l.reminder(r.id)).toBeNull();
    expect(l.db.query('SELECT count(*) AS n FROM history').get()).toEqual({ n: 2 });
  });
  test('ordinary edits retain reminders; rescheduling cancels old tasks', async () => {
    const l = ledger(),
      t = tasks();
    l.putItem(item(), 0, '2026-10-20T00:00:00.000Z');
    await scheduleReminders(l, t.call);
    const initial = t.rows().map((r) => r.series_id);
    l.putItem(item({ title: 'New title' }), 1);
    await scheduleReminders(l, t.call);
    expect(t.rows().map((r) => r.series_id)).toEqual(initial);
    l.putItem(item({ due: '2026-10-27T08:00:00.000Z' }), 2, '2026-10-20T00:00:00.000Z');
    await scheduleReminders(l, t.call);
    expect(t.rows().length).toBe(2);
    expect(t.calls.filter((x) => x === 'cancel').length).toBe(2);
  });
  test('reinstallation updates one task; ambiguous creation never blindly clones', async () => {
    const l = ledger(),
      t = tasks();
    await installTask(l, t.call);
    await installTask(l, t.call);
    expect(t.calls.filter((x) => x === 'create').length).toBe(1);
    expect(t.rows()[0].script).toContain('gate');
    expect(t.rows()[0].recurrence).toBe('0 * * * *');
    const other = ledger();
    other.set('hourly.intent', 'uncertain');
    await expect(installTask(other, tasks().call)).rejects.toThrow('uncertain');
  });
  test('source acknowledgments and decisions are version-bound; bootstrap is quiet', () => {
    const l = ledger();
    l.ingest('gmail:one', 'v1', {}, true);
    const result = decide(l, {
      id: 'gmail:one',
      version: 'v1',
      classification: 'urgent',
      summary: 'test',
      reason: 'deadline',
      notificationText: 'alert',
    });
    expect(result.classification).toBe('review');
    expect(l.inbox()).toHaveLength(0);
    l.ingest('gmail:one', 'v2', {});
    expect(l.inbox()).toHaveLength(1);
    expect(() => decide(l, { id: 'gmail:one', version: 'v1', classification: 'record', summary: 'old' })).toThrow(
      'Source changed',
    );
  });
});

describe('Google differential sync recovery', () => {
  test('initial Gmail snapshot pins cursor before fetching; read flags do not retrigger', async () => {
    const l = ledger();
    let unread = true;
    const get: Request = async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/profile')) return { historyId: '100' };
      if (u.pathname.endsWith('/messages')) return { messages: [{ id: 'm1' }] };
      if (u.pathname.endsWith('/history'))
        return { historyId: '110', history: [{ labelsRemoved: [{ message: { id: 'm1' } }] }] };
      return { id: 'm1', threadId: 't1', labelIds: unread ? ['INBOX', 'UNREAD'] : ['INBOX'], snippet: 'hello' };
    };
    expect(await syncMail(l, get, Date.now() + 1000)).toBe(true);
    expect(l.get('mail.cursor')).toBe('100');
    const row = l.inbox()[0] as any;
    l.ack(row.id, row.version);
    unread = false;
    await syncMail(l, get, Date.now() + 1000);
    expect(l.inbox()).toHaveLength(0);
    expect(l.get('mail.cursor')).toBe('110');
  });
  test('failed message fetch leaves cursor unchanged and replays durable scan', async () => {
    const l = ledger();
    l.set('mail.cursor', '100');
    let fails = true;
    const get: Request = async (url) => {
      if (url.includes('/history?'))
        return { historyId: '200', history: [{ messagesAdded: [{ message: { id: 'new' } }] }] };
      if (fails) throw new ApiError(503, 'gmail');
      return { id: 'new', threadId: 't2', snippet: 'new request' };
    };
    await expect(syncMail(l, get, Date.now() + 1000)).rejects.toThrow();
    expect(l.get('mail.cursor')).toBe('100');
    fails = false;
    await syncMail(l, get, Date.now() + 1000);
    expect(l.get('mail.cursor')).toBe('200');
    expect(l.inbox()).toHaveLength(1);
  });
  test('expired Gmail history falls back without treating recovery as first bootstrap', async () => {
    const l = ledger();
    l.set('mail.cursor', 'old');
    l.set('mail.initialized', true);
    const get: Request = async (url) => {
      if (url.includes('/history?')) throw new ApiError(404, 'gmail');
      if (url.endsWith('/profile')) return { historyId: '300' };
      if (new URL(url).pathname.endsWith('/messages')) return { messages: [{ id: 'recover' }] };
      return { id: 'recover', threadId: 't', snippet: 'recover' };
    };
    await syncMail(l, get, Date.now() + 1000);
    expect(l.get('mail.cursor')).toBe('300');
    expect((l.inbox()[0] as any).bootstrap).toBe(0);
  });
  test('Calendar 410 resync and cancellation keep existing source pending', async () => {
    const l = ledger();
    l.set('calendar:primary.cursor', 'old');
    l.set('calendar:primary.initialized', true);
    l.ingest('calendar:primary:event', 'v1', { status: 'confirmed' });
    l.ack('calendar:primary:event', 'v1');
    const get: Request = async (url) => {
      if (new URL(url).searchParams.has('syncToken')) throw new ApiError(410, 'calendar');
      return { nextSyncToken: 'fresh', items: [{ id: 'event', status: 'cancelled' }] };
    };
    await syncCalendar(l, 'primary', get, Date.now() + 1000);
    expect(l.get('calendar:primary.cursor')).toBe('fresh');
    expect(JSON.parse((l.inbox()[0] as any).payload).status).toBe('cancelled');
  });
  test('authentication error exposes health rather than reporting no changes', async () => {
    const l = ledger();
    await synchronize(
      l,
      async () => {
        throw new ApiError(401, 'google');
      },
      1000,
    );
    expect(l.get<any>('health:gmail').failures).toBe(1);
    expect(l.get('alert:gmail')).toBeDefined();
  });
});

describe('delivery accounting', () => {
  test('crash/uncertainty preserves prepared state; receipt reconciles instead of resending', async () => {
    const l = ledger(),
      t = fakeTransport();
    t.io.send = async (id) => {
      t.sent.push({ id, text: 'test' });
      throw new Error('interrupted');
    };
    await expect(notify(l, 'one', 'test', t.io)).rejects.toThrow('interrupted');
    expect((l.db.query('SELECT status FROM notifications').get() as any).status).toBe('prepared');
    t.receipts.set(t.sent[0].id, 'confirmed');
    await notify(l, 'one', 'test', t.io);
    expect(t.sent).toHaveLength(1);
    expect((l.db.query('SELECT status FROM notifications').get() as any).status).toBe('confirmed');
  });
  test('failed receipt is not success; foreign session cannot confirm it', async () => {
    const l = ledger(),
      t = fakeTransport();
    const id = 'secretary-' + (await import('../../skills/secretary/ledger.ts')).hash('two');
    t.receipts.set(id, 'failed');
    expect(await notify(l, 'two', 'test', t.io)).toEqual({ status: 'failed' });
    t.io.sessionId = 'different';
    t.receipts.set(id, 'confirmed');
    await reconcileNotifications(l, t.io);
    expect((l.db.query('SELECT status FROM notifications').get() as any).status).toBe('failed');
  });
  test('late reminder collapses elapsed points and a cancelled task is silent', async () => {
    const l = ledger(),
      t = fakeTransport();
    l.putItem(item(), 0, '2026-10-20T00:00:00.000Z');
    const rows = l.db.query('SELECT id FROM reminders ORDER BY at').all() as any[];
    expect(await remind(l, rows[0].id, t.io, '2026-10-25T07:00:00.000Z')).toEqual({ skipped: true });
    l.putItem(item({ state: 'cancelled' }), 1);
    expect(await remind(l, rows[1].id, t.io)).toEqual({ skipped: true });
    expect(t.sent).toHaveLength(0);
  });
});

describe('installed skill wiring', () => {
  test('payload exactly matches the installed runtime', () => {
    const base = new URL('../../skills/secretary/', import.meta.url);
    const payload = new URL('../../../.claude/skills/add-secretary/payload/secretary/', import.meta.url);
    for (const name of readdirSync(base))
      expect(readFileSync(new URL(name, base), 'utf8')).toBe(readFileSync(new URL(name, payload), 'utf8'));
  });
  test('real pre-task script runner handles a disabled secretary without a model call', async () => {
    const l = ledger();
    l.set('disabled', true);
    const file = l.db.filename;
    const cli = new URL('../../skills/secretary/cli.ts', import.meta.url).pathname;
    const { runScript } = await import('./scheduling/task-script.ts');
    const dir = join(file, '..');
    const result = await runScript(`SECRETARY_DIR='${dir}' bun '${cli}' gate`, 'secretary-integration', 2000);
    expect(result).toEqual({ wakeAgent: false });
  });
});

describe('one-shot stale task gate', () => {
  test('completed reminders do not wake the model', async () => {
    const l = ledger();
    l.putItem(item(), 0, '2026-10-20T00:00:00.000Z');
    const r = l.db.query('SELECT id FROM reminders LIMIT 1').get() as any;
    l.putItem(item({ state: 'done' }), 1);
    const { dispatch } = await import('../../skills/secretary/cli.ts');
    expect(await dispatch(l, 'reminder-gate', r.id)).toEqual({ wakeAgent: false });
  });
});

describe('bounded processing and email parsing', () => {
  test('batch rolls back items and reminders when any source decision is stale', async () => {
    const l = ledger();
    l.ingest('gmail:one', 'v2', {});
    const cli = new URL('../../skills/secretary/cli.ts', import.meta.url).pathname;
    const p = Bun.spawn(['bun', cli, 'batch'], {
      env: { ...process.env, SECRETARY_DIR: join(l.db.filename, '..') },
      stdin: new Blob([
        JSON.stringify({
          items: [{ expectedRevision: 0, item: item() }],
          decisions: [{ id: 'gmail:one', version: 'v1', classification: 'record', summary: 'stale' }],
        }),
      ]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(await p.exited).toBe(1);
    expect(l.items()).toHaveLength(0);
    expect(l.db.query('SELECT count(*) AS n FROM reminders').get()).toEqual({ n: 0 });
    expect(l.inbox()).toHaveLength(1);
  });
  test('quiet hourly gate skips model, but saved unprocessed data wakes it', async () => {
    const l = ledger();
    l.set('review', l.reviewSlot());
    const get: Request = async (url) => {
      if (url.endsWith('/profile')) return { historyId: '1' };
      if (url.includes('/gmail/')) return { historyId: '1' };
      return { items: [], nextSyncToken: '1' };
    };
    expect((await gate(l, get)).wakeAgent).toBe(false);
    l.ingest('gmail:new', 'v1', {});
    expect((await gate(l, get)).wakeAgent).toBe(true);
  });
  test('HTML-only email retains deadline text and excludes executable markup', async () => {
    const l = ledger();
    const get: Request = async (url) => {
      if (url.endsWith('/profile')) return { historyId: '1' };
      if (new URL(url).pathname.endsWith('/messages')) return { messages: [{ id: 'html' }] };
      return {
        id: 'html',
        threadId: 'thread',
        payload: {
          mimeType: 'text/html',
          body: {
            data: Buffer.from('<style>bad</style><p>期限: 10月25日 &amp; 確認</p><script>danger()</script>').toString(
              'base64url',
            ),
          },
        },
      };
    };
    await syncMail(l, get, Date.now() + 1000);
    const payload = JSON.parse((l.inbox()[0] as any).payload);
    expect(payload.text).toContain('10月25日 & 確認');
    expect(payload.text).not.toContain('danger');
  });
});

describe('reaction feedback', () => {
  test('ratings do not acknowledge notifications; eyes can be revoked without completing items', async () => {
    const { notificationFeedback } = await import('../../skills/secretary/feedback.ts');
    const l = ledger();
    l.putItem(item(), 0, '2026-10-22T00:00:00.000Z');
    l.db
      .query('INSERT INTO notifications VALUES (?,?,?,?,?,?)')
      .run('review:slot', 'Report', 'confirmed', 'answer-1', 'session-1', '2026-10-22T00:00:00.000Z');
    const reaction = (meaning: string, active = 1) => ({
      message_id: 'answer-1',
      user_id: 'discord:owner',
      emoji: meaning,
      meaning,
      active,
      updated_at: '2026-10-22T00:00:00.000Z',
      body: 'Report',
    });
    const quality = notificationFeedback(l, [reaction('good_answer'), reaction('bad_answer')])[0];
    expect(quality.seen).toBe(false);
    expect(quality.acknowledged).toBe(false);
    expect(quality.ratings).toHaveLength(2);
    expect(notificationFeedback(l, [reaction('seen')])[0].seenBy).toEqual(['discord:owner']);
    expect(notificationFeedback(l, [reaction('seen', 0)])).toEqual([]);
    expect(l.items()[0].state).toBe('todo');
    // Reading an earlier notification must not cancel or suppress a due deadline reminder.
    const reminder = l.db.query("SELECT id,at FROM reminders WHERE status='pending' ORDER BY at LIMIT 1").get() as any;
    const { io, sent, receipts } = fakeTransport();
    const { hash } = await import('../../skills/secretary/ledger.ts');
    receipts.set(`secretary-${hash(`reminder:${reminder.id}`)}`, 'confirmed');
    await remind(l, reminder.id, io, reminder.at);
    expect(sent).toHaveLength(1);
  });
  test('secretary context and runtime instructions stay wired to persistent feedback', () => {
    const cli = readFileSync(new URL('../../skills/secretary/cli.ts', import.meta.url), 'utf8');
    const instructions = readFileSync(new URL('../../skills/secretary/SKILL.md', import.meta.url), 'utf8');
    expect(cli).toContain('await fetchFeedback()');
    expect(cli).toContain('notificationFeedback(ledger');
    expect(instructions).toContain('Never cancel deadline reminders');
  });
});
