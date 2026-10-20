import { beforeEach, afterEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClineProvider } from './cline.js';
import type { ProviderEvent } from './types.js';

const keys = [
  'CLINE_AUTH_MODE',
  'CLINE_API',
  'CLINE_BASE_URL',
  'CLINE_MODEL',
  'CLINE_SPAWN_MODEL',
  'CLINE_SPAWN_AUTH_MODE',
  'CLINE_SPAWN_BASE_URL',
  'CLINE_SPAWN_API',
  'CLINE_SPAWN_MAX_ITERATIONS',
  'CLINE_MODEL_IO',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_GO_API_KEY',
] as const;
let previous: Record<string, string | undefined>;
let directory: string;
beforeEach(() => {
  previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-recovery-adapter-'));
  Object.assign(process.env, {
    CLINE_AUTH_MODE: 'default',
    CLINE_API: 'chat',
    CLINE_MODEL: 'test',
    CLINE_SPAWN_MODEL: '',
    CLINE_SPAWN_AUTH_MODE: 'default',
    CLINE_MODEL_IO: '0',
    CLAUDE_CONFIG_DIR: directory,
    OPENCODE_GO_API_KEY: 'placeholder',
  });
});
afterEach(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  fs.rmSync(directory, { recursive: true, force: true });
});
function reply(text: string, calls?: Array<{ name: string; args: unknown }>) {
  const delta = calls
    ? {
        role: 'assistant',
        content: '',
        tool_calls: calls.map((c, index) => ({
          index,
          id: `call-${index}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      }
    : { role: 'assistant', content: text };
  return new Response(
    `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta, finish_reason: calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
it('withholds a premature disclaimer, asks the parent to recover only missing work and publishes one verified final', async () => {
  let parentCalls = 0;
  const childCalls = new Map<string, number>();
  const task = (id: string) => ({
    id,
    objective: id,
    expectedOutput: 'verified evidence',
    followUpTo: null,
    requireCoverage: false,
  });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = (await req.json()) as { model: string; messages: Array<{ role: string; content: string }> };
      if (body.model === 'worker') {
        const id = JSON.parse(body.messages.find((m) => m.role === 'user')!.content).objective;
        const count = childCalls.get(id) ?? 0;
        childCalls.set(id, count + 1);
        return count === 0
          ? reply('', [
              {
                name: 'report_task_result',
                args: {
                  status: id === 'verify' ? 'partial' : 'completed',
                  evidence:
                    id === 'verify' ? '12 read' : '12 enumerated = 12 read; next page absent; boundaries checked',
                  remainingWork: id === 'verify' ? 'count reconciliation' : '',
                  coverage: null,
                },
              },
            ])
          : reply('worker evidence');
      }
      const step = parentCalls++;
      if (step === 0)
        return reply('', [{ name: 'delegate_tasks', args: { tasks: [task('verify'), task('remember')] } }]);
      if (step === 1) return reply('<message to="main">Count reconciliation unfinished.</message>');
      if (step === 2) {
        expect(JSON.stringify(body.messages)).toContain('Completion review');
        const toolContent = body.messages
          .filter((m) => m.role === 'tool')
          .map((m) => m.content)
          .find((c) => c.includes('taskRef'))!;
        const ref = toolContent.match(/"taskRef"\s*:\s*"([^"]+)"/)![1];
        return reply('', [
          {
            name: 'delegate_tasks',
            args: {
              tasks: [
                {
                  ...task('remaining-count'),
                  followUpTo: ref,
                  context: '12 already read; reconcile IDs only; no writes',
                },
              ],
            },
          },
        ]);
      }
      return reply('<message to="main">All 12 reconciled.</message>');
    },
  });
  Object.assign(process.env, {
    CLINE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    CLINE_SPAWN_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    CLINE_SPAWN_MODEL: 'worker',
    CLINE_SPAWN_API: 'chat',
    CLINE_SPAWN_MAX_ITERATIONS: '6',
  });
  const query = new ClineProvider().query({
    prompt: 'Check all messages, remember purchases and reconcile the exact count.',
    cwd: directory,
  });
  query.end();
  try {
    const results: ProviderEvent[] = [];
    for await (const event of query.events) if (event.type === 'result') results.push(event);
    expect(results).toEqual([{ type: 'result', text: '<message to="main">All 12 reconciled.</message>' }]);
    expect(parentCalls).toBe(4);
    expect(childCalls.get('remember')).toBe(2);
    expect(childCalls.get('verify')).toBe(2);
    expect(childCalls.get('remaining-count')).toBe(2);
  } finally {
    query.abort();
    server.stop(true);
  }
});

it('stops repeated invalid delegation inputs after three model calls instead of exhausting 50 iterations', async () => {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      calls++;
      return reply('', [
        {
          name: 'delegate_tasks',
          args: {
            tasks: [
              {
                id: 'read',
                objective: 'synthetic read only',
                expectedOutput: 'evidence',
                followUpTo: '00000000-0000-0000-0000-000000000000',
              },
            ],
          },
        },
      ]);
    },
  });
  Object.assign(process.env, {
    CLINE_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    CLINE_SPAWN_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
    CLINE_SPAWN_MODEL: 'worker',
    CLINE_SPAWN_API: 'chat',
    CLINE_SPAWN_MAX_ITERATIONS: '6',
  });
  const query = new ClineProvider().query({ prompt: 'synthetic request', cwd: directory });
  query.end();
  try {
    const results: ProviderEvent[] = [];
    for await (const event of query.events) if (event.type === 'result') results.push(event);
    expect(calls).toBe(3);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true });
  } finally {
    query.abort();
    server.stop(true);
  }
});
it('connects requestFinalResponse to tool-free continuation and restores normal tools on the next user turn', async () => {
  const toolCounts: number[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = (await req.json()) as { tools?: unknown[] };
      toolCounts.push(body.tools?.length ?? 0);
      return reply(toolCounts.length === 1 ? '' : '<message to="main">report</message>');
    },
  });
  process.env.CLINE_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  const query = new ClineProvider().query({ prompt: 'synthetic request', cwd: directory });
  const results: ProviderEvent[] = [];
  try {
    for await (const event of query.events) {
      if (event.type !== 'result') continue;
      results.push(event);
      if (results.length === 1) query.requestFinalResponse!('Report only existing results, no actions.');
      else if (results.length === 2) query.push('new normal user turn');
      else query.end();
    }
    expect(results).toHaveLength(3);
    expect(toolCounts[0]).toBeGreaterThan(0);
    expect(toolCounts[1]).toBe(0);
    expect(toolCounts[2]).toBeGreaterThan(0);
  } finally {
    query.abort();
    server.stop(true);
  }
});
it('reports a real SDK model failure once instead of emitting an empty success or duplicate terminal notices', async () => {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      Response.json({ error: { message: 'synthetic failure', type: 'invalid_request_error' } }, { status: 400 }),
  });
  process.env.CLINE_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
  const query = new ClineProvider().query({ prompt: 'synthetic request', cwd: directory });
  query.end();
  try {
    const results: ProviderEvent[] = [];
    for await (const event of query.events) if (event.type === 'result') results.push(event);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true });
  } finally {
    query.abort();
    server.stop(true);
  }
});
