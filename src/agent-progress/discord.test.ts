import crypto from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/connection.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import * as sessionManager from '../session-manager.js';
import type { MailboxSession } from '../mailbox/index.js';
import { runMigrations } from '../db/migrations/index.js';
import { DiscordProgress, progressMessage } from './discord.js';
import { getProgressCard, saveProgressCard, snapshotOf } from './store.js';
import { parseProgressSnapshot, safeProgressTitle, type ProgressSnapshot, type TaskState } from './model.js';

let clock = Date.UTC(2026, 9, 13);
let controllers: DiscordProgress[] = [];
let calls: Array<{ url: string; method: string; body: Record<string, unknown>; authorization: string | null }> = [];
let response:
  | ((url: string, method: string, body: Record<string, unknown>) => Response | Promise<Response>)
  | undefined;
let receipt = 900;
const fetchMock = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(input),
    method = init?.method ?? 'GET',
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  calls.push({ url, method, body, authorization: new Headers(init?.headers).get('Authorization') });
  if (response) return response(url, method, body);
  return method === 'POST' && url.includes('/channels/')
    ? Response.json({ id: String(receipt++), channel_id: '300', author: { id: '700', bot: true } })
    : new Response(null, { status: 204 });
}) as typeof fetch;
function controller(extra: Partial<ConstructorParameters<typeof DiscordProgress>[0]> = {}) {
  const c = new DiscordProgress({
    botToken: 'test-placeholder',
    applicationId: '700',
    instance: 'discord',
    fetch: fetchMock,
    now: () => clock,
    validateRoute: async () => true,
    isRunActive: async () => true,
    authorize: async () => true,
    ...extra,
  });
  controllers.push(c);
  return c;
}
const state = (change: Partial<ProgressSnapshot> = {}): ProgressSnapshot => ({
  version: 1,
  runId: crypto.randomUUID(),
  revision: 1,
  state: 'running',
  phase: 'working',
  batches: [],
  tasks: [],
  ...change,
});
const content = (snapshot: ProgressSnapshot) => ({
  snapshot,
  route: { sessionId: 'session', agentGroupId: 'ag', messagingGroupId: 'mg', inReplyTo: 'in' },
});
const deliver = (c: DiscordProgress, s: ProgressSnapshot) => c.deliver('discord:200:300', null, content(s));
const flush = async (ms = 0) => {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
};
const click = (runId: string, messageId: string, op = 'e', change: Record<string, unknown> = {}) => ({
  type: 3,
  id: '123',
  token: 'synthetic-interaction-token',
  application_id: '700',
  channel_id: '300',
  guild_id: '200',
  data: { custom_id: `ncp:1:${runId}:${op}` },
  message: { id: messageId, author: { id: '700', bot: true } },
  member: { user: { id: '800' } as { id: string; bot?: boolean } },
  ...change,
});
const edits = () => calls.filter((c) => c.method === 'PATCH');
const posts = () => calls.filter((c) => c.url.includes('/channels/') && c.method === 'POST');
beforeEach(async () => {
  vi.useFakeTimers();
  clock = Date.UTC(2026, 9, 13);
  controllers = [];
  calls = [];
  response = undefined;
  receipt = 900;
  const db = await initTestDb();
  await runMigrations(db);
});
afterEach(async () => {
  for (const c of controllers) await c.stop();
  vi.useRealTimers();
  await closeDb();
});

it('creates one V2 message and updates it; terminal is compact and does not reopen from stale events', async () => {
  const c = controller(),
    s = state();
  await deliver(c, s);
  await flush();
  expect(posts()).toHaveLength(1);
  expect(posts()[0]!.body.flags).toBe(32768);
  expect(posts()[0]!.body).not.toHaveProperty('content');
  expect(posts()[0]!.body).not.toHaveProperty('embeds');
  expect(posts()[0]!.body.allowed_mentions).toEqual({ parse: [], replied_user: false });
  await deliver(c, { ...s, revision: 2, phase: 'delegating' });
  await deliver(c, { ...s, revision: 3, state: 'completed' });
  await flush();
  expect(posts()).toHaveLength(1);
  expect(edits()).toHaveLength(1);
  const row = (await getProgressCard(s.runId))!;
  expect(row.expanded).toBe(0);
  expect(JSON.stringify(edits()[0]!.body)).toContain('詳細を表示');
  await deliver(c, { ...s, revision: 99 });
  await flush(1500);
  expect(snapshotOf((await getProgressCard(s.runId))!).state).toBe('completed');
});
it('coalesces running updates and prioritizes the terminal snapshot', async () => {
  const c = controller(),
    s = state();
  await deliver(c, s);
  await flush();
  for (let revision = 2; revision < 20; revision++) await deliver(c, { ...s, revision });
  await flush(100);
  expect(edits()).toHaveLength(0);
  await deliver(c, { ...s, revision: 20, state: 'failed' });
  await flush();
  expect(edits()).toHaveLength(1);
  expect(JSON.stringify(edits()[0]!.body)).toContain('失敗');
});
it('public rendering strips raw fields and preserves specific parent-authored titles', async () => {
  const batchId = crypto.randomUUID(),
    taskId = crypto.randomUUID();
  const parsed = parseProgressSnapshot({
    ...state(),
    secret: 'PRIVATE',
    batches: [{ id: batchId, ordinal: 1, state: 'running', objective: 'PRIVATE' }],
    tasks: [
      {
        id: taskId,
        batchId,
        ordinal: 1,
        state: 'running',
        title: '公式カレンダーで対象の収集日を確認',
        input: 'PRIVATE',
        result: 'PRIVATE',
        systemPrompt: 'PRIVATE',
      },
    ],
  });
  expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
  expect(parsed.tasks[0]!.title).toBe('公式カレンダーで対象の収集日を確認');
  await deliver(controller(), parsed);
  await flush();
  expect(JSON.stringify(progressMessage((await getProgressCard(parsed.runId))!))).toContain(
    '公式カレンダーで対象の収集日を確認',
  );
  const redacted = parseProgressSnapshot({ ...parsed, tasks: [{ ...parsed.tasks[0], title: 'Bearer PRIVATE' }] });
  expect(redacted.tasks[0]!.title).toBe('タスク 1');
  expect(() => parseProgressSnapshot({ ...parsed, version: 2 })).toThrow();
  expect(() => parseProgressSnapshot({ ...parsed, tasks: Array(33).fill(parsed.tasks[0]) })).toThrow();
});
it('defaults missing or unsafe public titles without truncating sensitive strings', () => {
  for (const title of [
    undefined,
    '',
    '   ',
    'あ'.repeat(61),
    '確認\n続き',
    '確認\u202e続き',
    'https://example.com の確認',
    'user@example.com の予定',
    '<@123> に確認',
    'Bearer PRIVATE',
    'api_key=PRIVATE',
    'sk-PRIVATE',
    '01234567890 に連絡',
    'a'.repeat(32),
    '/private/work.txt を確認',
    '**確認**',
  ]) {
    expect(safeProgressTitle(title, 2)).toBe('タスク 2');
  }
  expect(safeProgressTitle(' 現在の通知設定と収集日を照合 ', 2)).toBe('現在の通知設定と収集日を照合');
  expect(safeProgressTitle('あ'.repeat(60), 2)).toBe('あ'.repeat(60));
});
it('compact completion shows failed/partial/timeout/cancel counts and uses warning color', async () => {
  const batchId = crypto.randomUUID(),
    c = controller(),
    s = state({
      state: 'completed',
      batches: [{ id: batchId, ordinal: 1, state: 'partial' }],
      tasks: ['failed', 'partial', 'timed_out', 'cancelled'].map((status, index) => ({
        id: crypto.randomUUID(),
        batchId,
        ordinal: index + 1,
        title: '動作を検証',
        state: status as TaskState,
      })),
    });
  await deliver(c, s);
  await flush();
  const row = (await getProgressCard(s.runId))!;
  const msg = progressMessage(row);
  expect(JSON.stringify(msg)).toContain('時間切れ 1');
  expect(JSON.stringify(msg)).toContain('一部完了 1');
  expect(msg.components[0]!.accent_color).toBe(0xf1c40f);
});
it('acks before queued work, shares explicit expand/collapse and edits with Bot auth', async () => {
  const c = controller(),
    s = state({ state: 'completed' });
  await deliver(c, s);
  await flush();
  const row = (await getProgressCard(s.runId))!;
  await Promise.all([
    c.interaction(click(s.runId, row.message_id!, 'e')),
    c.interaction(click(s.runId, row.message_id!, 'c')),
  ]);
  expect((await getProgressCard(s.runId))!.expanded).toBe(0);
  const acks = calls.filter((c) => c.url.includes('/callback'));
  expect(acks).toHaveLength(2);
  expect(acks.every((c) => c.body.type === 6 && c.authorization === null)).toBe(true);
  expect(edits().every((c) => c.authorization === 'Bot test-placeholder')).toBe(true);
  expect(JSON.stringify(edits()[0]!.body)).toContain('閉じる');
  expect(JSON.stringify(edits()[1]!.body)).toContain('詳細を表示');
});
it.each(['channel', 'guild', 'message', 'application', 'author', 'bot', 'unknown-run', 'user'])(
  'rejects wrong %s binding after ACK without editing',
  async (kind) => {
    const c = controller(),
      s = state({ state: 'completed' });
    await deliver(c, s);
    await flush();
    const row = (await getProgressCard(s.runId))!;
    const input = click(s.runId, row.message_id!);
    if (kind === 'channel') input.channel_id = '301';
    if (kind === 'guild') input.guild_id = '201';
    if (kind === 'application') input.application_id = '701';
    if (kind === 'message') input.message.id = '901';
    if (kind === 'author') input.message.author.id = '701';
    if (kind === 'bot') input.message.author.bot = false;
    if (kind === 'user') input.member.user = { id: '800', bot: true };
    if (kind === 'unknown-run') input.data.custom_id = `ncp:1:${crypto.randomUUID()}:e`;
    await c.interaction(input);
    expect(edits()).toHaveLength(0);
    expect(calls.some((c) => c.body.flags === 64)).toBe(true);
  },
);
it('denies an unregistered/viewer-inaccessible group and does not rely on collectors', async () => {
  const c = controller({ authorize: async () => false }),
    s = state({ state: 'completed' });
  await deliver(c, s);
  await flush();
  await c.interaction(click(s.runId, (await getProgressCard(s.runId))!.message_id!));
  expect(edits()).toHaveLength(0);
});
it('opens completed cards after a fresh controller restart; interrupts old running cards', async () => {
  const c = controller(),
    complete = state({ state: 'completed' }),
    running = state();
  await deliver(c, complete);
  await deliver(c, running);
  await flush();
  await c.stop();
  const next = controller();
  await next.start();
  await flush();
  expect(snapshotOf((await getProgressCard(running.runId))!).state).toBe('interrupted');
  await next.interaction(click(complete.runId, (await getProgressCard(complete.runId))!.message_id!));
  expect((await getProgressCard(complete.runId))!.expanded).toBe(1);
  expect(posts()).toHaveLength(2);
});
it('expired cards respond privately, scrub stored detail, and never edit/repost', async () => {
  const c = controller(),
    s = state({ state: 'completed' });
  await deliver(c, s);
  await flush();
  const row = (await getProgressCard(s.runId))!;
  clock += 8 * 86400000;
  await c.sweep();
  await c.interaction(click(s.runId, row.message_id!));
  expect((await getProgressCard(s.runId))!.snapshot).toBeNull();
  expect(edits()).toHaveLength(0);
  expect(posts()).toHaveLength(1);
});
it.each([400, 401, 403, 404])('stops permanently after PATCH %s instead of retrying forever', async (status) => {
  const c = controller(),
    s = state();
  await deliver(c, s);
  await flush();
  response = () => Response.json({}, { status });
  await deliver(c, { ...s, revision: 2, state: 'completed' });
  await flush();
  expect((await getProgressCard(s.runId))!.delivery_state).toBe('lost');
  await flush(6000);
  await c.sweep();
  await flush();
  expect(edits()).toHaveLength(1);
  expect(posts()).toHaveLength(1);
});
it('unknown POST result is persisted as uncertain and never blindly posted again, including restart', async () => {
  response = async () => {
    throw new Error('connection lost after server might have accepted');
  };
  const c = controller(),
    s = state();
  await deliver(c, s);
  await flush();
  expect((await getProgressCard(s.runId))!.delivery_state).toBe('uncertain');
  await c.stop();
  const next = controller();
  await next.start();
  await flush(10000);
  await next.sweep();
  await flush();
  expect(posts()).toHaveLength(1);
});
it('honors 429 retry_after and retries only the same card when Discord definitively rejected POST', async () => {
  const c = controller(),
    s = state();
  let attempts = 0;
  response = () =>
    ++attempts === 1
      ? Response.json({ retry_after: 2, global: true }, { status: 429 })
      : Response.json({ id: '900', channel_id: '300', author: { id: '700', bot: true } });
  await deliver(c, s);
  await flush();
  expect(posts()).toHaveLength(1);
  await flush(1000);
  await c.sweep();
  await flush();
  expect(posts()).toHaveLength(1);
  await flush(1000);
  await c.sweep();
  await flush();
  expect(posts()).toHaveLength(2);
  expect((await getProgressCard(s.runId))!.message_id).toBe('900');
});
it('callback 429 does not poison Bot editing buckets or other card deliveries', async () => {
  const c = controller(),
    s = state({ state: 'completed' });
  await deliver(c, s);
  await flush();
  response = (url, method) =>
    url.includes('/callback')
      ? Response.json({ retry_after: 999, global: true }, { status: 429 })
      : method === 'POST'
        ? Response.json({ id: '901', channel_id: '300', author: { id: '700', bot: true } })
        : new Response(null, { status: 204 });
  await c.interaction(click(s.runId, '900'));
  await deliver(c, state());
  await flush();
  expect(posts()).toHaveLength(2);
});
it('rejects run reuse across session, route, instance or reply source', async () => {
  const c = controller(),
    s = state();
  await deliver(c, s);
  await flush();
  for (const route of [
    { sessionId: 'other' },
    { inReplyTo: 'other' },
    { agentGroupId: 'other' },
    { messagingGroupId: 'other' },
  ])
    await expect(
      c.deliver('discord:200:300', null, { snapshot: { ...s, revision: 2 }, route: { ...content(s).route, ...route } }),
    ).rejects.toThrow(/mismatch/);
});
it('tracks revisions without serializing unrelated cards and keeps one edit active per run', async () => {
  const c = controller(),
    s = state();
  await deliver(c, s);
  await flush();
  let unlock!: () => void;
  const barrier = new Promise<void>((r) => {
    unlock = r;
  });
  let active = 0,
    peak = 0;
  response = async () => {
    active++;
    peak = Math.max(peak, active);
    await barrier;
    active--;
    return new Response(null, { status: 204 });
  };
  await deliver(c, { ...s, revision: 2 });
  const advancing = flush(1500);
  await Promise.resolve();
  await Promise.resolve();
  const terminal = deliver(c, { ...s, revision: 3, state: 'completed' });
  unlock();
  await advancing;
  await terminal;
  await flush();
  expect(peak).toBe(1);
  expect(snapshotOf((await getProgressCard(s.runId))!).state).toBe('completed');
});
it('uses the real group/wiring/user roles for button authorization and rejects detached routes', async () => {
  const created_at = new Date(clock).toISOString();
  await createAgentGroup({ id: 'ag', name: 'test', folder: 'progress-test', agent_provider: 'cline', created_at });
  await createMessagingGroup({
    id: 'mg',
    channel_type: 'discord',
    platform_id: 'discord:200:300',
    instance: 'discord',
    name: 'test',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at,
  });
  await createMessagingGroupAgent({
    id: 'wire',
    messaging_group_id: 'mg',
    agent_group_id: 'ag',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'known',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at,
  });
  const c = controller({ validateRoute: undefined, authorize: undefined }),
    s = state({ state: 'completed' });
  await deliver(c, s);
  await flush();
  expect(posts()).toHaveLength(1);
  await c.interaction(click(s.runId, '900'));
  expect(edits()).toHaveLength(0);
  await getDb().run(
    'INSERT INTO users (id,kind,display_name,created_at) VALUES (?,?,?,?)',
    'discord:800',
    'human',
    'Test',
    created_at,
  );
  await getDb().run(
    'INSERT INTO user_roles (user_id,role,agent_group_id,granted_at) VALUES (?,?,?,?)',
    'discord:800',
    'owner',
    null,
    created_at,
  );
  await c.interaction(click(s.runId, '900'));
  expect(edits()).toHaveLength(1);
  await getDb().run('UPDATE messaging_groups SET detached_at = ? WHERE id = ?', created_at, 'mg');
  await c.interaction(click(s.runId, '900', 'c'));
  expect(edits()).toHaveLength(1);
});
it('retries a failed PATCH without creating another message', async () => {
  const c = controller(),
    s = state();
  await deliver(c, s);
  await flush();
  let attempt = 0;
  response = async () => {
    if (++attempt === 1) throw new Error('offline');
    return new Response(null, { status: 204 });
  };
  await deliver(c, { ...s, revision: 2, state: 'completed' });
  await flush();
  expect((await getProgressCard(s.runId))!.delivery_state).toBe('sent');
  await flush(5000);
  await c.sweep();
  await flush();
  expect(edits()).toHaveLength(2);
  expect(posts()).toHaveLength(1);
});
it('does not expose full detail or exceed Discord component limits at the bounded maximum', async () => {
  const batchId = crypto.randomUUID(),
    c = controller();
  const s = state({
    batches: [{ id: batchId, ordinal: 1, state: 'running' }],
    tasks: Array.from({ length: 32 }, (_, i) => ({
      id: crypto.randomUUID(),
      batchId,
      ordinal: i + 1,
      title: '情報を調べる',
      state: 'running',
    })),
  });
  await deliver(c, s);
  await flush();
  const body = posts()[0]!.body;
  const count = (value: unknown): number =>
    Array.isArray(value)
      ? value.reduce((n, v) => n + count(v), 0)
      : value && typeof value === 'object'
        ? (typeof (value as Record<string, unknown>).type === 'number' ? 1 : 0) +
          count((value as Record<string, unknown>).components)
        : 0;
  expect(count(body.components)).toBeLessThanOrEqual(40);
  expect(JSON.stringify(body).length).toBeLessThan(4000);
});
it('recovers an interrupted sending marker conservatively without a duplicate POST', async () => {
  const c = controller(),
    s = state();
  await deliver(c, s);
  const row = (await getProgressCard(s.runId))!;
  row.delivery_state = 'sending';
  await saveProgressCard(row);
  await c.stop();
  const next = controller();
  await next.start();
  await flush();
  await next.sweep();
  await flush();
  expect((await getProgressCard(s.runId))!.delivery_state).toBe('uncertain');
  expect(posts()).toHaveLength(0);
});
it('closes a stopped container run after the grace period when no terminal event survived', async () => {
  const c = controller({ isRunActive: async () => false }),
    s = state();
  await deliver(c, s);
  await flush();
  await flush(10000);
  await c.sweep();
  await flush();
  expect(snapshotOf((await getProgressCard(s.runId))!).state).toBe('running');
  await flush(5000);
  await c.sweep();
  await flush();
  const row = (await getProgressCard(s.runId))!;
  expect(snapshotOf(row).state).toBe('interrupted');
  expect(row.expanded).toBe(0);
  expect(edits()).toHaveLength(1);
});
it('waits for a queued terminal mailbox snapshot before treating a stopped session as interrupted', async () => {
  const c = controller({ isRunActive: undefined }),
    s = state();
  await deliver(c, s);
  await flush();
  const fakeMailbox = {
    getDeliveredIds: () => new Set<string>(),
    getDueMessages: () => [
      { id: 'terminal', kind: 'agent_progress', content: JSON.stringify({ ...s, revision: 2, state: 'completed' }) },
    ],
  } as unknown as MailboxSession;
  const spy = vi
    .spyOn(sessionManager, 'withExistingMailboxSession')
    .mockImplementationOnce(async (_group, _session, action) => action(fakeMailbox));
  try {
    await flush(20000);
    await c.sweep();
    await flush();
    expect(snapshotOf((await getProgressCard(s.runId))!).state).toBe('running');
  } finally {
    spy.mockRestore();
  }
  await deliver(c, { ...s, revision: 2, state: 'completed' });
  await flush();
  expect(snapshotOf((await getProgressCard(s.runId))!).state).toBe('completed');
});
