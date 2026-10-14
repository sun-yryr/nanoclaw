import { beforeEach, afterEach, expect, it } from 'bun:test';
import './mailbox/compose.js';
import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      "INSERT INTO destinations (name,type,channel_type,platform_id) VALUES ('main','channel','discord','discord:200:300')",
    )
    .run();
});
afterEach(() => closeSessionDb());
const route = {
  platformId: 'discord:200:300',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'in',
  taskRun: false,
};
const chat = () => getUndeliveredMessages().filter((m) => m.kind === 'chat');
const snapshots = () =>
  getUndeliveredMessages()
    .filter((m) => m.kind === 'agent_progress')
    .map((m) => JSON.parse(m.content));

it('recovers an empty Cline answer once using the dedicated tool-free request and keeps the same run', async () => {
  const recoveries: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'progress', message: 'Working' };
    yield { type: 'result', text: '' };
    expect(chat()).toHaveLength(0);
    expect(snapshots().every((s) => s.state === 'running')).toBe(true);
    yield {
      type: 'result',
      text: '<message to="main">The child could not finish; no completion is claimed.</message>',
    };
  }
  const query: AgentQuery = {
    events: events(),
    push() {
      throw Error('Ordinary execution must not be restarted');
    },
    requestFinalResponse: (p) => {
      recoveries.push(p);
    },
    end() {},
    abort() {},
  };
  await processQuery(query, route, [], 'cline', undefined, 'original request', undefined);
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]).toContain('original request');
  expect(chat()).toHaveLength(1);
  expect(new Set(snapshots().map((s) => s.runId)).size).toBe(1);
  expect(snapshots().at(-1).state).toBe('completed');
});
it.each(['', '   ', 'PRIVATE unwrapped scratchpad'])(
  'reports failure after the one recovery returns %j instead of silently succeeding',
  async (text) => {
    let requests = 0;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'result', text: '' };
      yield { type: 'result', text };
    }
    const query: AgentQuery = {
      events: events(),
      push() {
        throw Error('No action replay');
      },
      requestFinalResponse() {
        requests++;
      },
      end() {},
      abort() {},
    };
    await processQuery(query, route, [], 'cline', undefined, 'request', undefined);
    expect(requests).toBe(1);
    expect(chat()).toHaveLength(1);
    expect(JSON.parse(chat()[0]!.content).text).toContain('回答を生成できませんでした');
    expect(JSON.stringify(chat())).not.toContain('PRIVATE');
    expect(snapshots().at(-1).state).toBe('failed');
  },
);
it('does not duplicate an already queued MCP reply when final text is empty', async () => {
  let requests = 0;
  async function* events(): AsyncGenerator<ProviderEvent> {
    await writeMessageOut({
      id: 'sent',
      kind: 'chat',
      platform_id: route.platformId,
      channel_type: 'discord',
      content: JSON.stringify({ text: 'already replied' }),
      in_reply_to: 'in',
    });
    yield { type: 'result', text: '' };
  }
  await processQuery(
    {
      events: events(),
      push() {},
      requestFinalResponse() {
        requests++;
      },
      end() {},
      abort() {},
    },
    route,
    [],
    'cline',
    undefined,
    'request',
    undefined,
  );
  expect(requests).toBe(0);
  expect(chat()).toHaveLength(1);
});
it('fails closed without the constrained query API and never uses ordinary push to replay actions', async () => {
  let pushes = 0;
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'result', text: '' };
  }
  await processQuery(
    {
      events: events(),
      push() {
        pushes++;
      },
      end() {},
      abort() {},
    },
    route,
    [],
    'cline',
    undefined,
    'request',
    undefined,
  );
  expect(pushes).toBe(0);
  expect(chat()).toHaveLength(1);
  expect(snapshots().at(-1).state).toBe('failed');
});
it.each(['claude', 'mock'])('preserves empty results for %s rather than invoking Cline recovery', async (provider) => {
  let requests = 0;
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'result', text: '' };
  }
  await processQuery(
    {
      events: events(),
      push() {},
      requestFinalResponse() {
        requests++;
      },
      end() {},
      abort() {},
    },
    route,
    [],
    provider,
    undefined,
    'request',
    undefined,
  );
  expect(requests).toBe(0);
  expect(chat()).toHaveLength(0);
});
it('does not force a chat reply for task runs or failure-notice wakes', async () => {
  for (const routing of [
    { ...route, taskRun: true },
    { ...route, failureNoticeWake: true },
  ]) {
    let requests = 0;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'result', text: '' };
    }
    await processQuery(
      {
        events: events(),
        push() {},
        requestFinalResponse() {
          requests++;
        },
        end() {},
        abort() {},
      },
      routing,
      [],
      'cline',
      undefined,
      'request',
      undefined,
    );
    expect(requests).toBe(0);
  }
  expect(chat()).toHaveLength(0);
});
