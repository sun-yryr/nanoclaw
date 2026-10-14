import crypto from 'node:crypto';
import { beforeEach, afterEach, expect, it } from 'bun:test';
import '../mailbox/compose.js';
import { createAgentProgressPoster } from './poster.js';
import { parseProgressSnapshot } from './model.generated.js';
import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { processQuery } from '../poll-loop.js';
import type { AgentQuery, ProviderEvent } from '../providers/types.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());
const route = {
  platformId: 'discord:200:300',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'in',
  taskRun: false,
};
it('freezes the route, preserves task titles, serializes writes, and finishes last', async () => {
  const writes: Array<{ content: string; in_reply_to?: string | null }> = [];
  const routing = { ...route };
  const poster = createAgentProgressPoster(routing, async (row) => {
    await new Promise((r) => setTimeout(r, 5));
    writes.push(row);
  })!;
  const batchId = crypto.randomUUID(),
    a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const first = poster.update({ kind: 'batch', batchId, ordinal: 1, state: 'running' });
  routing.inReplyTo = 'different';
  await poster.update({
    kind: 'task',
    batchId,
    taskId: a,
    ordinal: 1,
    state: 'running',
    title: '公式カレンダーで対象の収集日を確認',
  });
  await poster.update({ kind: 'task', batchId, taskId: b, ordinal: 2, state: 'queued' });
  await poster.update({ kind: 'task', batchId, taskId: a, ordinal: 1, state: 'timed_out', durationMs: 100 });
  await poster.update({ kind: 'batch', batchId, ordinal: 1, state: 'failed' });
  await poster.update();
  await poster.finish('failed');
  await first;
  expect(writes.every((row) => row.in_reply_to === 'in')).toBe(true);
  const last = parseProgressSnapshot(JSON.parse(writes.at(-1)!.content));
  expect(last.tasks.map((t) => t.ordinal)).toEqual([1, 2]);
  expect(last.tasks.map((t) => t.title)).toEqual(['公式カレンダーで対象の収集日を確認', 'タスク 2']);
  expect(last.tasks.map((t) => t.state)).toEqual(['timed_out', 'failed']);
  expect(last.state).toBe('failed');
  expect(last.phase).toBe('synthesizing');
  expect(new Set(writes.map((row) => JSON.parse(row.content).runId)).size).toBe(1);
});
it('does not change other channels or task runs and assigns a new ID to another turn', async () => {
  expect(createAgentProgressPoster({ ...route, channelType: 'slack' })).toBeNull();
  expect(createAgentProgressPoster({ ...route, taskRun: true })).toBeNull();
  const ids: string[] = [];
  for (let i = 0; i < 2; i++)
    await createAgentProgressPoster(route, async (row) => {
      ids.push(JSON.parse(row.content).runId);
    })!.finish('cancelled');
  expect(new Set(ids).size).toBe(2);
});
function seedDestination() {
  getInboundDb()
    .prepare(
      "INSERT INTO destinations (name,type,channel_type,platform_id) VALUES ('main','channel','discord','discord:200:300')",
    )
    .run();
}
it('keeps one run open across the wrapping correction and does not finish at the intermediate result', async () => {
  seedDestination();
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'progress', message: 'PRIVATE tool inputs' };
    yield { type: 'result', text: 'unwrapped answer' };
    const intermediate = getUndeliveredMessages().filter((m) => m.kind === 'agent_progress');
    expect(intermediate.every((m) => JSON.parse(m.content).state === 'running')).toBe(true);
    yield { type: 'progress', message: 'PRIVATE result' };
    yield { type: 'result', text: '<message to="main">final answer</message>' };
  }
  const query: AgentQuery = {
    events: events(),
    push: (m) => {
      pushes.push(m);
    },
    end() {},
    abort() {},
  };
  await processQuery(query, route, [], 'cline', undefined, 'user request', undefined);
  expect(pushes).toHaveLength(1);
  const messages = getUndeliveredMessages();
  const snapshots = messages
    .filter((m) => m.kind === 'agent_progress')
    .map((m) => parseProgressSnapshot(JSON.parse(m.content)));
  expect(new Set(snapshots.map((s) => s.runId)).size).toBe(1);
  expect(snapshots.filter((s) => s.state === 'completed')).toHaveLength(1);
  expect(JSON.stringify(snapshots)).not.toContain('PRIVATE');
  expect(messages.filter((m) => m.kind === 'chat').map((m) => JSON.parse(m.content).text)).toEqual(['final answer']);
});
it('mid-turn delivery is a separate bubble and does not terminate the progress run', async () => {
  seedDestination();
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'progress', message: 'Working' };
    yield { type: 'text', text: '<message to="main">first segment</message>' };
    expect(
      getUndeliveredMessages()
        .filter((m) => m.kind === 'agent_progress')
        .every((m) => JSON.parse(m.content).state === 'running'),
    ).toBe(true);
    yield { type: 'result', text: '' };
  }
  const query: AgentQuery = { events: events(), push() {}, end() {}, abort() {} };
  await processQuery(query, route, [], 'cline', undefined, 'request', undefined, true);
  const rows = getUndeliveredMessages();
  expect(rows.filter((m) => m.kind === 'agent_progress').map((m) => JSON.parse(m.content).state)).toEqual([
    'running',
    'completed',
  ]);
  expect(rows.some((m) => m.kind === 'chat' && JSON.parse(m.content).text === 'first segment')).toBe(true);
});
