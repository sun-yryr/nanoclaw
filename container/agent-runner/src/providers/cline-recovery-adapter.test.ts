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
function reply(text: string) {
  return new Response(
    `data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
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
