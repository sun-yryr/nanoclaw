import { expect, it } from 'bun:test';
import { Agent, createTool, type AgentToolContext } from '@cline/sdk';
import {
  buildClineDelegateTasksTool,
  delegationInputSchema,
  resolveDelegationLimits,
  type DelegateTasksOutput,
} from './cline-delegation.js';
import { McpRetryGuard } from './cline-mcp-retry.js';
const context: AgentToolContext = { agentId: 'parent', iteration: 1 };
const task = (id: string) => ({ id, objective: id, expectedOutput: 'concise result' });
const tasks = (...ids: string[]) => ({ tasks: ids.map(task) });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error('Barrier did not open');
}
function completion(text = 'done', calls?: Array<{ name: string; args: unknown }>) {
  const chunk = {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        delta: calls
          ? {
              role: 'assistant',
              tool_calls: calls.map((t, index) => ({
                index,
                id: `call-${index}`,
                type: 'function',
                function: { name: t.name, arguments: JSON.stringify(t.args) },
              })),
            }
          : { role: 'assistant', content: text },
        finish_reason: calls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
type Body = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> };
function fixture(handle: (body: Body, request: Request) => Response | Promise<Response>, maxIterations = 6) {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      return handle((await request.json()) as Body, request);
    },
  });
  const options = {
    cwd: process.cwd(),
    spawn: {
      modelId: 'test',
      providerId: 'openai-compatible' as const,
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'placeholder',
      maxIterations,
    },
  };
  return { options, stop: () => server.stop(true) };
}
function objective(body: Body): string {
  const first = body.messages.find((m) => m.role === 'user')?.content;
  return typeof first === 'string' ? JSON.parse(first).objective : '';
}
it('validates trimmed bounded input, duplicate IDs and unsupported fields', () => {
  const schema = delegationInputSchema();
  expect(schema.parse({ tasks: [{ ...task(' a '), objective: ' x ' }] }).tasks[0]?.id).toBe('a');
  for (const value of [
    tasks(),
    tasks('x', ' x '),
    tasks('1', '2', '3', '4', '5'),
    { tasks: [{ ...task('a'), objective: ' ' }] },
    { tasks: [{ ...task('a'), objective: 'x'.repeat(1501) }] },
    { tasks: [{ ...task('a'), context: 'x'.repeat(3001) }] },
    { tasks: [{ ...task('a'), systemPrompt: 'elevate' }] },
    { tasks: [{ ...task('a'), expectedOutput: 'x'.repeat(1001) }] },
    { tasks: [{ ...task('a'), id: 'x'.repeat(41) }] },
  ]) {
    expect(() => schema.parse(value)).toThrow();
  }
  expect(resolveDelegationLimits({})).toEqual({ maxConcurrency: 3, maxTasksPerBatch: 4, maxTasksPerTurn: 8 });
  for (const value of ['', '0', '-1', '4', '1.5', 'NaN']) {
    expect(() => resolveDelegationLimits({ CLINE_DELEGATION_MAX_CONCURRENCY: value })).toThrow();
  }
});
it('real SDK children share peak three across concurrent batches and isolate headers', async () => {
  let active = 0,
    peak = 0,
    calls = 0;
  const headers = new Map<string, string>();
  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const f = fixture(async (body, request) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    headers.set(objective(body), request.headers.get('x-opencode-session')!);
    await barrier;
    active--;
    return completion(objective(body));
  });
  try {
    const tool = buildClineDelegateTasksTool(f.options);
    expect(tool.name).toBe('delegate_tasks');
    const a = tool.execute(tasks('a', 'b', 'c', 'd'), context);
    const b = tool.execute(tasks('e', 'f', 'g', 'h'), context);
    await until(() => calls === 3);
    expect(peak).toBe(3);
    expect(() => tool.resetTurn()).toThrow();
    unblock();
    const out = (await Promise.all([a, b])) as DelegateTasksOutput[];
    expect(out[0].results.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(out[0].summary.completed).toBe(4);
    expect(out[1].summary.completed).toBe(4);
    expect(new Set(headers.values()).size).toBe(8);
    expect(peak).toBe(3);
    await expect(tool.execute(tasks('over'), context)).rejects.toThrow(/budget/);
    tool.resetTurn();
    expect(((await tool.execute(tasks('next'), context)) as DelegateTasksOutput).summary.completed).toBe(1);
  } finally {
    unblock();
    f.stop();
  }
}, 15000);
it('retains partial results with successful siblings in input order', async () => {
  const f = fixture(
    (body) =>
      objective(body) === 'partial'
        ? completion('', [{ name: 'not_registered', args: {} }])
        : completion(objective(body)),
    1,
  );
  try {
    const tool = buildClineDelegateTasksTool(f.options);
    const out = (await tool.execute(tasks('a', 'partial', 'c', 'd'), context)) as DelegateTasksOutput;
    expect(out.results.map((r) => r.id)).toEqual(['a', 'partial', 'c', 'd']);
    expect(out.results[1].status).toBe('partial');
    expect(out.summary.completed).toBe(3);
  } finally {
    f.stop();
  }
});
it('propagates abort and cancels queued children without starting them', async () => {
  const controller = new AbortController();
  let started = 0;
  const f = fixture(async () => {
    started++;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return completion();
  });
  try {
    const tool = buildClineDelegateTasksTool({
      ...f.options,
      limits: { maxConcurrency: 1, maxTasksPerBatch: 4, maxTasksPerTurn: 8 },
    });
    const run = tool.execute(tasks('a', 'b', 'c'), { ...context, signal: controller.signal });
    await until(() => started === 1);
    controller.abort();
    expect(((await run) as DelegateTasksOutput).summary.cancelled).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(started).toBe(1);
    tool.resetTurn();
  } finally {
    f.stop();
  }
});
it('child deadline aborts and awaits SDK termination', async () => {
  const f = fixture(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return completion();
  });
  try {
    const tool = buildClineDelegateTasksTool({ ...f.options, childTimeoutMs: 20 });
    expect(((await tool.execute(tasks('a'), context)) as DelegateTasksOutput).summary.cancelled).toBe(1);
    tool.resetTurn();
  } finally {
    f.stop();
  }
});
it('SDK runtime hooks block deferred tools, activate by search and isolate activation per child', async () => {
  let executed = 0;
  const seen = new Map<string, string[][]>();
  const count = new Map<string, number>();
  const f = fixture((body) => {
    const id = objective(body),
      step = count.get(id) ?? 0;
    count.set(id, step + 1);
    seen.set(id, [...(seen.get(id) ?? []), (body.tools ?? []).map((t) => t.function.name)]);
    if (step === 0) return completion('', [{ name: 'mcp__external__lookup', args: {} }]);
    if (step === 1 && id === 'activate') return completion('', [{ name: 'tool_search', args: { query: 'external' } }]);
    if (step === 2 && id === 'activate') return completion('', [{ name: 'mcp__external__lookup', args: {} }]);
    return completion();
  });
  try {
    const tool = buildClineDelegateTasksTool({
      ...f.options,
      extraChildTools: [
        createTool({
          name: 'mcp__external__lookup',
          description: 'lookup',
          inputSchema: { type: 'object' },
          execute: async () => {
            executed++;
            return 'source-id';
          },
        }),
      ],
    });
    expect(
      ((await tool.execute(tasks('activate', 'unactivated'), context)) as DelegateTasksOutput).summary.completed,
    ).toBe(2);
    expect(executed).toBe(1);
    expect(seen.get('activate')?.[0]).not.toContain('mcp__external__lookup');
    expect(seen.get('activate')?.[2]).toContain('mcp__external__lookup');
    expect(seen.get('unactivated')?.flat()).not.toContain('mcp__external__lookup');
    for (const name of ['spawn_agent', 'delegate_tasks', 'ask_question'])
      expect(seen.get('activate')?.flat()).not.toContain(name);
  } finally {
    f.stop();
  }
});
it('serializes unknown actions and intentionally shares MCP retry budget', async () => {
  let active = 0,
    peak = 0,
    executions = 0;
  const retry = new McpRetryGuard();
  const counts = new Map<string, number>();
  const f = fixture((body) => {
    const id = objective(body),
      n = counts.get(id) ?? 0;
    counts.set(id, n + 1);
    return n === 0 ? completion('', [{ name: 'mcp__nanoclaw__unknown_action', args: {} }]) : completion();
  });
  try {
    const tool = buildClineDelegateTasksTool({
      ...f.options,
      extraChildTools: [
        createTool({
          name: 'mcp__nanoclaw__unknown_action',
          description: 'unknown',
          inputSchema: { type: 'object' },
          execute: async () =>
            retry.run('unknown', {}, async () => {
              executions++;
              active++;
              peak = Math.max(peak, active);
              await tick();
              active--;
              return { isError: true };
            }),
        }),
      ],
    });
    expect(((await tool.execute(tasks('a', 'b', 'c'), context)) as DelegateTasksOutput).summary.completed).toBe(3);
    expect(peak).toBe(1);
    expect(executions).toBe(2);
  } finally {
    f.stop();
  }
});
it('isolates a child initialization exception without losing three sibling results', async () => {
  const f = fixture(() => completion());
  let first = true;
  const brokenOnce = createTool({
    name: 'probe',
    description: 'test',
    inputSchema: { type: 'object' },
    execute: async () => 'ok',
  });
  Object.defineProperty(brokenOnce, 'name', {
    get() {
      if (first) {
        first = false;
        throw new Error('Initialization failed');
      }
      return 'probe';
    },
  });
  try {
    const tool = buildClineDelegateTasksTool({ ...f.options, extraChildTools: [brokenOnce] });
    const output = (await tool.execute(tasks('a', 'b', 'c', 'd'), context)) as DelegateTasksOutput;
    expect(output.results.map((r) => r.status)).toEqual(['failed', 'completed', 'completed', 'completed']);
    expect(output.summary).toEqual({ completed: 3, partial: 0, failed: 1, cancelled: 0 });
  } finally {
    f.stop();
  }
});
it('supports parent synthesis, dependent second batch, restore and continue with reset budgets', async () => {
  let parentStep = 0;
  const parentTools: string[][] = [];
  const f = fixture((body) => {
    const names = (body.tools ?? []).map((t) => t.function.name);
    if (!names.includes('delegate_tasks')) return completion('child evidence');
    parentTools.push(names);
    const step = parentStep++;
    if (step === 0) return completion('', [{ name: 'delegate_tasks', args: tasks('a', 'b', 'c', 'd') }]);
    if (step === 1) {
      expect(JSON.stringify(body.messages)).toContain('child evidence');
      return completion('', [{ name: 'delegate_tasks', args: tasks('e', 'f', 'g', 'h') }]);
    }
    if (step === 3) return completion('', [{ name: 'delegate_tasks', args: tasks('new-turn') }]);
    return completion('parent synthesis');
  });
  try {
    const delegation = buildClineDelegateTasksTool(f.options);
    const config = { ...f.options.spawn, tools: [delegation], maxIterations: 6 };
    const parent = new Agent(config);
    delegation.resetTurn();
    expect((await parent.run('first user request')).status).toBe('completed');
    const restored = new Agent(config);
    restored.restore(parent.snapshot().messages);
    delegation.resetTurn();
    const result = await restored.continue('second user request');
    expect(result.status).toBe('completed');
    expect(result.outputText).toContain('parent synthesis');
    expect(parentStep).toBe(5);
    for (const names of parentTools) expect(names).toEqual(['delegate_tasks']);
  } finally {
    f.stop();
  }
}, 15000);
it('abort reaches an executing child tool and prevents another tool from acquiring the lock', async () => {
  const controller = new AbortController();
  let active = 0,
    started = 0;
  const f = fixture(() => completion('', [{ name: 'mcp__nanoclaw__wait', args: {} }]));
  try {
    const tool = buildClineDelegateTasksTool({
      ...f.options,
      extraChildTools: [
        createTool({
          name: 'mcp__nanoclaw__wait',
          description: 'wait',
          inputSchema: { type: 'object' },
          execute: async (_input: unknown, ctx: AgentToolContext) => {
            started++;
            active++;
            try {
              await new Promise<void>((resolve) => {
                if (ctx.signal?.aborted) resolve();
                else ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              return 'stopped';
            } finally {
              active--;
            }
          },
        }),
      ],
    });
    const run = tool.execute(tasks('a', 'b', 'c', 'd'), { ...context, signal: controller.signal });
    await until(() => active === 1);
    controller.abort();
    expect(((await run) as DelegateTasksOutput).summary.cancelled).toBe(4);
    expect(active).toBe(0);
    expect(started).toBe(1);
  } finally {
    f.stop();
  }
});
it('query cancellation signal works when SDK tool context omits its signal', async () => {
  const controller = new AbortController();
  let started = 0;
  const f = fixture(async () => {
    started++;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return completion();
  });
  try {
    const tool = buildClineDelegateTasksTool({ ...f.options, parentSignal: controller.signal });
    const run = tool.execute(tasks('a', 'b'), context);
    await until(() => started > 0);
    controller.abort();
    expect(((await run) as DelegateTasksOutput).summary.cancelled).toBe(2);
  } finally {
    f.stop();
  }
});
it('waits for uncooperative tool execution to settle after a child deadline', async () => {
  let active = 0;
  const f = fixture(() => completion('', [{ name: 'mcp__nanoclaw__slow', args: {} }]));
  try {
    const tool = buildClineDelegateTasksTool({
      ...f.options,
      childTimeoutMs: 40,
      extraChildTools: [
        createTool({
          name: 'mcp__nanoclaw__slow',
          description: 'slow',
          inputSchema: { type: 'object' },
          execute: async () => {
            active++;
            await new Promise((resolve) => setTimeout(resolve, 100));
            active--;
            return 'settled';
          },
        }),
      ],
    });
    const run = tool.execute(tasks('a'), context);
    await until(() => active === 1);
    expect(((await run) as DelegateTasksOutput).summary.cancelled).toBe(1);
    expect(active).toBe(0);
    tool.resetTurn();
  } finally {
    f.stop();
  }
});
