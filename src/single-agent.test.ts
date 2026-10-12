import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import {
  allowMultipleAgentGroups,
  assertCanCreateAgentGroup,
  effectiveSessionMode,
  forcePerThreadInGroupChats,
  singleAgentCreateError,
} from './single-agent.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  delete process.env.ALLOW_MULTIPLE_AGENT_GROUPS;
  delete process.env.FORCE_PER_THREAD_IN_GROUP_CHATS;
});

afterEach(async () => {
  await closeDb();
  delete process.env.ALLOW_MULTIPLE_AGENT_GROUPS;
  delete process.env.FORCE_PER_THREAD_IN_GROUP_CHATS;
});

describe('single-agent policy', () => {
  it('allows the first agent group and refuses a second unless overridden', async () => {
    await assertCanCreateAgentGroup();
    await createAgentGroup({
      id: 'ag-1',
      name: 'Andy',
      folder: 'andy',
      agent_provider: null,
      created_at: now(),
    });
    await expect(assertCanCreateAgentGroup()).rejects.toThrow(/single-agent/);
    process.env.ALLOW_MULTIPLE_AGENT_GROUPS = 'true';
    expect(allowMultipleAgentGroups()).toBe(true);
    await assertCanCreateAgentGroup();
  });

  it('honours wiring session_mode unless FORCE_PER_THREAD_IN_GROUP_CHATS is set', () => {
    expect(
      effectiveSessionMode('shared', { adapterSupportsThreads: true, isGroup: true }),
    ).toBe('shared');
    process.env.FORCE_PER_THREAD_IN_GROUP_CHATS = 'true';
    expect(forcePerThreadInGroupChats()).toBe(true);
    expect(
      effectiveSessionMode('shared', { adapterSupportsThreads: true, isGroup: true }),
    ).toBe('per-thread');
    expect(
      effectiveSessionMode('agent-shared', { adapterSupportsThreads: true, isGroup: true }),
    ).toBe('agent-shared');
  });

  it('formats a useful create error', async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Andy',
      folder: 'andy',
      agent_provider: null,
      created_at: now(),
    });
    const { getAllAgentGroups } = await import('./db/agent-groups.js');
    expect(singleAgentCreateError(await getAllAgentGroups())).toMatch(/andy \(ag-1\)/);
  });
});
