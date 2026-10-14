import { expect, it } from 'bun:test';
import type { AgentRuntimeHooks } from '@cline/agents';
import { FinalResponseGate } from './cline-final-response.js';
it('allows one recovery model request, removes all tools, blocks hallucinated calls, and restores normal mode', async () => {
  let models = 0,
    tools = 0;
  const gate = new FinalResponseGate();
  const base: AgentRuntimeHooks = {
    beforeModel: async () => {
      models++;
      return { tools: [{ name: 'side_effect' }] };
    },
    beforeTool: () => {
      tools++;
    },
  };
  const hooks = gate.hooks(base);
  const model = { request: { tools: [{ name: 'side_effect' }] }, iteration: 1 } as Parameters<
    NonNullable<AgentRuntimeHooks['beforeModel']>
  >[0];
  const call = { tool: { name: 'side_effect' } } as Parameters<NonNullable<AgentRuntimeHooks['beforeTool']>>[0];
  gate.begin(true);
  expect(await hooks.beforeModel!(model)).toMatchObject({ tools: [] });
  expect(await hooks.beforeTool!(call)).toMatchObject({ skip: true });
  expect(tools).toBe(0);
  expect(await hooks.beforeModel!(model)).toMatchObject({ stop: true });
  expect(models).toBe(1);
  gate.begin(false);
  await hooks.beforeModel!(model);
  await hooks.beforeTool!(call);
  expect(models).toBe(2);
  expect(tools).toBe(1);
});
