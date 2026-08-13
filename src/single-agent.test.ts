import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroupAgents } from './db/messaging-groups.js';
import {
  allowMultipleAgentGroups,
  assertCanCreateAgentGroup,
  consolidateAgentGroups,
  effectiveSessionMode,
  forcePerThreadInGroupChats,
  getCanonicalAgentGroup,
  resolveKeepAgentGroup,
  resolveOrCreateAgentGroup,
} from './single-agent.js';

function now(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe('single-agent policy', () => {
  const prevMultiple = process.env.ALLOW_MULTIPLE_AGENT_GROUPS;
  const prevForce = process.env.FORCE_PER_THREAD_IN_GROUP_CHATS;

  beforeEach(() => {
    delete process.env.ALLOW_MULTIPLE_AGENT_GROUPS;
    delete process.env.FORCE_PER_THREAD_IN_GROUP_CHATS;
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
    if (prevMultiple === undefined) delete process.env.ALLOW_MULTIPLE_AGENT_GROUPS;
    else process.env.ALLOW_MULTIPLE_AGENT_GROUPS = prevMultiple;
    if (prevForce === undefined) delete process.env.FORCE_PER_THREAD_IN_GROUP_CHATS;
    else process.env.FORCE_PER_THREAD_IN_GROUP_CHATS = prevForce;
  });

  it('defaults flags off', () => {
    expect(allowMultipleAgentGroups()).toBe(false);
    expect(forcePerThreadInGroupChats()).toBe(false);
  });

  it('picks the oldest group as canonical', () => {
    createAgentGroup({ id: 'ag-new', name: 'New', folder: 'new', agent_provider: null, created_at: now(1000) });
    createAgentGroup({ id: 'ag-old', name: 'Old', folder: 'old', agent_provider: null, created_at: now(0) });
    expect(getCanonicalAgentGroup()?.id).toBe('ag-old');
  });

  it('refuses a second group unless the override is set', () => {
    createAgentGroup({ id: 'ag-1', name: 'One', folder: 'one', agent_provider: null, created_at: now() });
    expect(() => assertCanCreateAgentGroup()).toThrow(/single-agent/);
    process.env.ALLOW_MULTIPLE_AGENT_GROUPS = 'true';
    expect(() => assertCanCreateAgentGroup()).not.toThrow();
  });

  it('reuses the existing group instead of creating a second folder', () => {
    createAgentGroup({ id: 'ag-1', name: 'Mafuyu', folder: 'mafuyu', agent_provider: null, created_at: now() });
    const { group, created } = resolveOrCreateAgentGroup({ folder: 'dm-with-someone', name: 'Other' });
    expect(created).toBe(false);
    expect(group.id).toBe('ag-1');
  });

  it('creates the first group when none exist', () => {
    const { group, created } = resolveOrCreateAgentGroup({ folder: 'mafuyu', name: '真冬' });
    expect(created).toBe(true);
    expect(group.folder).toBe('mafuyu');
  });

  it('honours shared session_mode in threaded group chats by default', () => {
    expect(effectiveSessionMode('shared', { adapterSupportsThreads: true, isGroup: true })).toBe('shared');
  });

  it('forces per-thread only when the opt-in flag is set', () => {
    process.env.FORCE_PER_THREAD_IN_GROUP_CHATS = 'true';
    expect(effectiveSessionMode('shared', { adapterSupportsThreads: true, isGroup: true })).toBe('per-thread');
    expect(effectiveSessionMode('agent-shared', { adapterSupportsThreads: true, isGroup: true })).toBe('agent-shared');
    expect(effectiveSessionMode('shared', { adapterSupportsThreads: true, isGroup: false })).toBe('shared');
  });

  it('rewires every messaging group onto the keep agent with session_mode=shared', () => {
    createAgentGroup({ id: 'ag-keep', name: 'Keep', folder: 'keep', agent_provider: null, created_at: now() });
    createAgentGroup({ id: 'ag-other', name: 'Other', folder: 'other', agent_provider: null, created_at: now(1) });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'discord:1',
      name: 'one',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'telegram',
      platform_id: 'telegram:2',
      name: 'two',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-keep',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-keep',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-other',
      messaging_group_id: 'mg-2',
      agent_group_id: 'ag-other',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const result = consolidateAgentGroups('ag-keep');
    expect(result.rewired).toHaveLength(1);
    expect(result.rewired[0].messagingGroupId).toBe('mg-2');
    expect(getMessagingGroupAgents('mg-1')[0]).toMatchObject({
      agent_group_id: 'ag-keep',
      session_mode: 'shared',
    });
    expect(getMessagingGroupAgents('mg-2')[0]).toMatchObject({
      agent_group_id: 'ag-keep',
      session_mode: 'shared',
      engage_mode: 'pattern',
    });
    expect(result.otherGroups.map((g) => g.id)).toEqual(['ag-other']);
  });

  it('resolveKeepAgentGroup requires --keep when several groups exist', () => {
    createAgentGroup({ id: 'ag-a', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: 'ag-b', name: 'B', folder: 'b', agent_provider: null, created_at: now() });
    expect(() => resolveKeepAgentGroup()).toThrow(/--keep/);
    expect(resolveKeepAgentGroup('b').id).toBe('ag-b');
  });
});
