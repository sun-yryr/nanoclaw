import { expect, it } from 'bun:test';
import { Agent, createTool, type AgentToolContext } from '@cline/sdk';
import {
  buildClineDelegateTasksTool,
  delegationInputSchema,
  resolveDelegationLimits,
  type DelegateTasksOutput,
} from './cline-delegation.js';
import { McpRetryGuard } from './cline-mcp-retry.js';
import type { DelegationProgress } from '../agent-progress/model.generated.js';
import { FinalResponseGate } from './cline-final-response.js';
const context: AgentToolContext = { agentId: 'parent', iteration: 1 };
const task = (id: string) => ({ id, objective: id, expectedOutput: 'concise result' });

it('accepts nullable optional fields for new tasks and reports actionable errors for invented follow-up IDs', async () => {
  const f = fixture(() => completion('synthetic read-only result'));
  try {
    const tool = buildClineDelegateTasksTool(f.options);
    const output = (await tool.execute(
      { tasks: [{ ...task('first'), title: null, context: null, followUpTo: null, requireCoverage: null }] },
      context,
    )) as DelegateTasksOutput;
    expect(output.results[0]?.status).toBe('completed');
    const invalid = { tasks: [{ ...task('bad'), followUpTo: '00000000-0000-0000-0000-000000000000' }] };
    for (let i = 0; i < 3; i++) await expect(tool.execute(invalid, context)).rejects.toThrow('followUpTo: null');
    expect(() => tool.assertInputBudget()).toThrow('three invalid inputs');
    tool.resetTurn();
    expect(() => tool.assertInputBudget()).not.toThrow();
  } finally {
    f.stop();
  }
});

it('advertises null for absent optional values through the real Responses request adapter', async () => {
  let inspected = false;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = (await req.json()) as { tools: Array<{ name: string; parameters: any }> };
      const params = body.tools.find((t) => t.name === 'delegate_tasks')!.parameters;
      for (const key of ['followUpTo', 'title', 'context', 'requireCoverage']) {
        expect(JSON.stringify(params.properties.tasks.items.properties[key])).toContain('null');
      }
      inspected = true;
      return Response.json(
        { error: { message: 'synthetic stop after request inspection', type: 'invalid_request_error' } },
        { status: 400 },
      );
    },
  });
  const f = fixture(() => completion());
  try {
    const tool = buildClineDelegateTasksTool(f.options);
    await new Agent({
      providerId: 'openai-native',
      modelId: 'test',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'placeholder',
      tools: [tool],
      maxIterations: 1,
    }).run('synthetic request');
    expect(inspected).toBe(true);
  } finally {
    server.stop(true);
    f.stop();
  }
});

it('treats SDK completion without evidence as unverified and retains timeout gaps for parent recovery', async () => {
  const f = fixture(() => completion('12 read, count unknown'));
  try {
    const tool = buildClineDelegateTasksTool(f.options);
    const output = (await tool.execute(tasks('review'), context)) as DelegateTasksOutput;
    expect(output.results[0]?.status).toBe('completed'); // Execution, not objective completion.
    expect(output.results[0]?.completion?.status).toBe('unverified');
    expect(tool.recoveryPrompt()).toContain(output.results[0]!.taskRef);
    tool.resetTurn();
    expect(tool.recoveryPrompt()).toBeUndefined();
  } finally {
    f.stop();
  }
  const slow = fixture(async () => {
    await new Promise((r) => setTimeout(r, 60));
    return completion();
  });
  try {
    const tool = buildClineDelegateTasksTool({ ...slow.options, childTimeoutMs: 10 });
    const output = (await tool.execute(tasks('verify'), context)) as DelegateTasksOutput;
    expect(output.results[0]?.status).toBe('cancelled');
    expect(output.results[0]?.recovery).toBeUndefined();
    expect(tool.recoveryPrompt()).toContain('verify');
    expect(tool.recoveryPrompt()).toContain('Remaining child attempts in this turn: 7');
  } finally {
    slow.stop();
  }
});

it('links verified follow-ups to incomplete work, leaves completed siblings alone and shares the attempt budget', async () => {
  const calls = new Map<string, number>();
  const f = fixture((body) => {
    const id = objective(body),
      n = calls.get(id) ?? 0;
    calls.set(id, n + 1);
    if (n === 0)
      return completion('', [
        {
          name: 'report_task_result',
          args: {
            status: id === 'review' ? 'partial' : 'completed',
            evidence:
              id === 'review'
                ? '12 messages read; page total unverified'
                : '12 unique IDs enumerated = 12 read = 12 classified; no next page',
            remainingWork: id === 'review' ? 'reconcile IDs and time boundaries' : '',
          },
        },
      ]);
    return completion('evidence');
  });
  try {
    const tool = buildClineDelegateTasksTool({
      ...f.options,
      limits: { maxConcurrency: 3, maxTasksPerBatch: 4, maxTasksPerTurn: 3 },
    });
    const output = (await tool.execute(tasks('review', 'remember'), context)) as DelegateTasksOutput;
    expect(output.results[0]?.completion?.status).toBe('partial');
    expect(tool.recoveryPrompt()).toContain('reconcile IDs');
    expect(tool.recoveryPrompt()).not.toContain('remember');
    await tool.execute({ tasks: [{ ...task('verify'), followUpTo: output.results[0]!.taskRef }] }, context);
    expect(tool.recoveryPrompt()).toBeUndefined();
    expect(calls.get('remember')).toBe(2); // Exactly one worker, two model turns.
    await expect(tool.execute(tasks('extra'), context)).rejects.toThrow(/budget/);
    tool.resetTurn();
    await expect(
      tool.execute({ tasks: [{ ...task('stale'), followUpTo: output.results[0]!.taskRef }] }, context),
    ).rejects.toThrow(/earlier task/);
  } finally {
    f.stop();
  }
});

it('accepts a concrete external blocker without forcing blind recovery', async () => {
  let requests = 0;
  const f = fixture(() =>
    requests++ === 0
      ? completion('', [
          {
            name: 'report_task_result',
            args: {
              status: 'blocked',
              evidence: 'Permission denied; no write attempted',
              remainingWork: 'Operator must grant account access',
            },
          },
        ])
      : completion('blocked'),
  );
  try {
    const tool = buildClineDelegateTasksTool(f.options);
    const output = (await tool.execute(tasks('permission'), context)) as DelegateTasksOutput;
    expect(output.results[0]?.completion?.status).toBe('blocked');
    expect(tool.recoveryPrompt()).toBeUndefined();
    expect(requests).toBe(2);
  } finally {
    f.stop();
  }
});

it('requires explicit parent resumption after max_iterations, retains evidence and session, and never repeats a successful action', async () => {
  let requests = 0,
    writes = 0;
  const sessions = new Set<string>();
  const events: DelegationProgress[] = [];
  const f = fixture((body, req) => {
    sessions.add(req.headers.get('x-opencode-session')!);
    const step = requests++;
    if (step === 0) return completion('', [{ name: 'tool_search', args: { query: 'external' } }]);
    expect(body.tools?.some((tool) => tool.function.name === 'mcp__external__write_once')).toBe(true);
    if (step === 1) return completion('', [{ name: 'mcp__external__write_once', args: {} }]);
    expect(JSON.stringify(body.messages)).toContain('APPLIED-ONCE');
    if (step === 2)
      return completion('', [
        {
          name: 'report_task_result',
          args: {
            status: 'completed',
            evidence: 'Existing APPLIED-ONCE receipt verified; report finished',
            remainingWork: '',
          },
        },
      ]);
    return completion('Verified existing change; finished remaining reporting.');
  }, 2);
  try {
    const tool = buildClineDelegateTasksTool({
      ...f.options,
      onProgress: (e) => {
        events.push(e);
      },
      extraChildTools: [
        createTool({
          name: 'mcp__external__write_once',
          description: 'synthetic action',
          inputSchema: { type: 'object' },
          execute: async () => {
            writes++;
            return 'APPLIED-ONCE';
          },
        }),
      ],
    });
    const first = (await tool.execute(tasks('work'), context)) as DelegateTasksOutput;
    expect(first.results[0]!.finishReason).toBe('max_iterations');
    expect(first.results[0]!.recovery).toBeDefined();
    expect(requests).toBe(2); // No automatic retry.
    const input = {
      recoveryId: first.results[0]!.recovery!.id,
      instruction: 'Verify the existing change and complete only the remaining report.',
    };
    await expect(tool.resumeTool.execute(input, { ...context, agentId: 'other-parent' })).rejects.toThrow(
      /unavailable/,
    );
    const resumed = (await tool.resumeTool.execute(
      input,
      context,
    )) as import('./cline-delegation.js').DelegatedTaskResult;
    expect(resumed.status).toBe('completed');
    expect(resumed.completion?.status).toBe('completed');
    expect(resumed.recovery).toBeUndefined();
    expect(writes).toBe(1);
    expect(sessions.size).toBe(1);
    expect(new Set(events.filter((e) => e.kind === 'task').map((e) => (e.kind === 'task' ? e.taskId : ''))).size).toBe(
      1,
    );
    await expect(tool.resumeTool.execute(input, context)).rejects.toThrow(/already used/);
  } finally {
    f.stop();
  }
});

it('invalidates a completion claim if another operation runs afterward', async () => {
  let step = 0;
  const f = fixture(() => {
    if (step++ === 0)
      return completion('', [
        { name: 'report_task_result', args: { status: 'completed', evidence: 'state verified', remainingWork: '' } },
      ]);
    if (step === 2) return completion('', [{ name: 'probe', args: {} }]);
    return completion('done');
  });
  try {
    const tool = buildClineDelegateTasksTool({
      ...f.options,
      extraChildTools: [
        createTool({
          name: 'probe',
          description: 'synthetic operation',
          inputSchema: { type: 'object' },
          execute: async () => 'changed state',
        }),
      ],
    });
    const output = (await tool.execute(tasks('work'), context)) as DelegateTasksOutput;
    expect(output.results[0]?.completion?.status).toBe('unverified');
    expect(tool.recoveryPrompt()).toContain('work');
  } finally {
    f.stop();
  }
});

it('inherits exhaustive coverage in follow-ups and preserves checkpoint evidence after a timeout', async () => {
  const steps = new Map<string, number>();
  const f = fixture(async (body) => {
    const id = objective(body),
      n = steps.get(id) ?? 0;
    steps.set(id, n + 1);
    if (id === 'slow' && n > 0) {
      await new Promise((r) => setTimeout(r, 80));
      return completion();
    }
    if (n === 0)
      return completion('', [
        {
          name: 'report_task_result',
          args: {
            status: id === 'slow' ? 'partial' : 'completed',
            evidence: 'checkpoint: 12 read IDs retained',
            remainingWork: id === 'slow' ? 'reconcile last page' : '',
          },
        },
      ]);
    return completion('worker finished');
  });
  try {
    const tool = buildClineDelegateTasksTool({ ...f.options, childTimeoutMs: 40 });
    const original = (await tool.execute(
      { tasks: [{ ...task('original'), requireCoverage: true }] },
      context,
    )) as DelegateTasksOutput;
    expect(original.results[0]?.completion?.status).toBe('partial');
    const follow = (await tool.execute(
      { tasks: [{ ...task('follow'), followUpTo: original.results[0]!.taskRef, requireCoverage: false }] },
      context,
    )) as DelegateTasksOutput;
    expect(follow.results[0]?.completion?.status).toBe('partial');
    expect(tool.recoveryPrompt()).toContain(original.results[0]!.taskRef);
    const slow = (await tool.execute(tasks('slow'), context)) as DelegateTasksOutput;
    expect(slow.results[0]?.status).toBe('cancelled');
    expect(slow.results[0]?.completion?.evidence).toContain('12 read IDs');
    expect(slow.results[0]?.completion?.remainingWork).toBe('reconcile last page');
  } finally {
    f.stop();
  }
});
it('charges resumption to the shared turn budget and expires checkpoints on the next user turn', async () => {
  const f = fixture(() => completion('', [{ name: 'missing', args: {} }]), 1);
  try {
    const tool = buildClineDelegateTasksTool({
      ...f.options,
      limits: { maxConcurrency: 3, maxTasksPerBatch: 4, maxTasksPerTurn: 2 },
    });
    const first = (await tool.execute(tasks('a'), context)) as DelegateTasksOutput;
    const recoveryId = first.results[0]!.recovery!.id;
    await tool.execute(tasks('b'), context);
    await expect(
      tool.resumeTool.execute({ recoveryId, instruction: 'Continue only missing work' }, context),
    ).rejects.toThrow(/budget/);
    tool.resetTurn();
    await expect(tool.resumeTool.execute({ recoveryId, instruction: 'Continue' }, context)).rejects.toThrow(/expired/);
  } finally {
    f.stop();
  }
});

it('emits safe titled child lifecycle with independent IDs, and distinguishes timeout from cancellation', async () => {
  const events: DelegationProgress[] = [];
  const f = fixture(() => completion());
  try {
    const tool = buildClineDelegateTasksTool({
      ...f.options,
      onProgress: (event) => {
        events.push(event);
      },
    });
    await tool.execute(
      {
        tasks: [
          {
            id: 'PRIVATE-ID',
            objective: 'PRIVATE-OBJECTIVE',
            context: 'PRIVATE-CONTEXT',
            title: '現在の通知設定と収集日を照合',
            expectedOutput: 'PRIVATE-OUTPUT',
          },
        ],
      },
      context,
    );
    const states = events.filter((e) => e.kind === 'task').map((e) => e.state);
    expect(states).toEqual(['queued', 'running', 'partial']);
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
    expect(events.filter((e) => e.kind === 'task').every((e) => e.title === '現在の通知設定と収集日を照合')).toBe(true);
    expect(events.filter((e) => e.kind === 'batch').map((e) => e.state)).toEqual(['running', 'partial']);
    events.length = 0;
    await tool.execute({ tasks: [{ ...task('second'), title: 'Bearer PRIVATE' }] }, context);
    expect(events.filter((e) => e.kind === 'task').every((e) => e.title === 'タスク 2')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
  } finally {
    f.stop();
  }
  const slow = fixture(async () => {
    await new Promise((r) => setTimeout(r, 100));
    return completion();
  });
  try {
    const tool = buildClineDelegateTasksTool({
      ...slow.options,
      childTimeoutMs: 20,
      onProgress: (e) => {
        events.push(e);
      },
    });
    await tool.execute(tasks('timeout'), context);
    expect(events.some((e) => e.kind === 'task' && e.state === 'timed_out')).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await tool.execute(tasks('cancelled'), { ...context, signal: controller.signal });
    expect(events.some((e) => e.kind === 'task' && e.state === 'cancelled')).toBe(true);
  } finally {
    slow.stop();
  }
});
const tasks = (...ids: string[]) => ({ tasks: ids.map(task) });

it('real SDK final-only mode makes one model request and executes zero tools even for a hallucinated call', async () => {
  let requests = 0,
    actions = 0;
  const f = fixture((body) => {
    requests++;
    expect(body.tools ?? []).toEqual([]);
    return completion('', [{ name: 'mcp__nanoclaw__action', args: {} }]);
  });
  try {
    const gate = new FinalResponseGate();
    gate.begin(true);
    const parent = new Agent({
      ...f.options.spawn,
      hooks: gate.hooks({}),
      tools: [
        createTool({
          name: 'mcp__nanoclaw__action',
          description: 'synthetic',
          inputSchema: { type: 'object' },
          execute: async () => {
            actions++;
            return 'done';
          },
        }),
      ],
    });
    await parent.run('Use only existing evidence to answer');
    expect(requests).toBe(1);
    expect(actions).toBe(0);
  } finally {
    f.stop();
  }
});
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
  expect(
    schema.parse({ tasks: [{ ...task('a'), title: ' 公式カレンダーで対象の収集日を確認 ' }] }).tasks[0]?.title,
  ).toBe('公式カレンダーで対象の収集日を確認');
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
    { tasks: [{ ...task('a'), title: 'あ'.repeat(61) }] },
    { tasks: [{ ...task('a'), title: ' ' }] },
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
