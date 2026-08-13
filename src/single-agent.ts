/**
 * Single-agent-group policy for this personal install.
 *
 * Default: one agent group (identity / workspace / memory). New channels
 * wire to it; new groups are not created. Override with
 * ALLOW_MULTIPLE_AGENT_GROUPS=true.
 *
 * Threaded group chats honour wiring session_mode (default `shared`).
 * Restore the old "always per-thread" override with
 * FORCE_PER_THREAD_IN_GROUP_CHATS=true.
 */
import {
  createMessagingGroupAgent,
  deleteMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  updateMessagingGroupAgent,
} from './db/messaging-groups.js';
import { getAgentGroup, getAgentGroupByFolder, getAllAgentGroups, createAgentGroup } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import { log } from './log.js';
import type { AgentGroup, MessagingGroupAgent } from './types.js';

export function allowMultipleAgentGroups(): boolean {
  return process.env.ALLOW_MULTIPLE_AGENT_GROUPS === 'true';
}

export function forcePerThreadInGroupChats(): boolean {
  return process.env.FORCE_PER_THREAD_IN_GROUP_CHATS === 'true';
}

export function singleAgentCreateError(existing: AgentGroup[]): string {
  const listed = existing.map((g) => `${g.folder} (${g.id})`).join(', ');
  return (
    `Refusing to create another agent group. This install is single-agent ` +
    `(existing: ${listed}). Wire new channels to the existing group, or set ` +
    `ALLOW_MULTIPLE_AGENT_GROUPS=true to override.`
  );
}

export function assertCanCreateAgentGroup(): void {
  if (allowMultipleAgentGroups()) return;
  const existing = getAllAgentGroups();
  if (existing.length === 0) return;
  throw new Error(singleAgentCreateError(existing));
}

/** Oldest-created group, then id. Undefined when none exist. */
export function getCanonicalAgentGroup(): AgentGroup | undefined {
  const groups = getAllAgentGroups();
  if (groups.length === 0) return undefined;
  return [...groups].sort((a, b) => {
    const byTime = a.created_at.localeCompare(b.created_at);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  })[0];
}

export function resolveKeepAgentGroup(keep?: string): AgentGroup {
  if (keep) {
    const byId = getAgentGroup(keep);
    if (byId) return byId;
    const byFolder = getAgentGroupByFolder(keep);
    if (byFolder) return byFolder;
    throw new Error(`agent group not found: ${keep}`);
  }
  const groups = getAllAgentGroups();
  if (groups.length === 0) throw new Error('no agent groups exist');
  if (groups.length === 1) return groups[0];
  const listing = groups.map((g) => `  ${g.id}  ${g.folder}  ${g.name}`).join('\n');
  throw new Error(`multiple agent groups; pass --keep <id-or-folder>:\n${listing}`);
}

/**
 * Find an existing group to reuse, or create one when none exist (or when
 * multiple groups are allowed and `folder` is new).
 */
export function resolveOrCreateAgentGroup(input: { folder: string; name: string; now?: string }): {
  group: AgentGroup;
  created: boolean;
} {
  const byFolder = getAgentGroupByFolder(input.folder);
  if (byFolder) return { group: byFolder, created: false };

  if (!allowMultipleAgentGroups()) {
    const canonical = getCanonicalAgentGroup();
    if (canonical) {
      log.info('Reusing existing agent group (single-agent mode)', {
        requestedFolder: input.folder,
        usingId: canonical.id,
        usingFolder: canonical.folder,
      });
      return { group: canonical, created: false };
    }
  }

  const now = input.now ?? new Date().toISOString();
  const group: AgentGroup = {
    id: `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name,
    folder: input.folder,
    agent_provider: null,
    created_at: now,
  };
  createAgentGroup(group);
  return { group, created: true };
}

export function effectiveSessionMode(
  wiredMode: MessagingGroupAgent['session_mode'],
  opts: { adapterSupportsThreads: boolean; isGroup: boolean },
): MessagingGroupAgent['session_mode'] {
  if (forcePerThreadInGroupChats() && opts.adapterSupportsThreads && wiredMode !== 'agent-shared' && opts.isGroup) {
    return 'per-thread';
  }
  return wiredMode;
}

export interface ConsolidateResult {
  keep: AgentGroup;
  rewired: Array<{ messagingGroupId: string; fromAgentGroupId: string; mgaId: string }>;
  alreadyOnKeep: number;
  otherGroups: AgentGroup[];
}

/**
 * Point every messaging_group_agents row at `keepId` with session_mode=shared.
 * Does not delete leftover agent_groups (use `ncl groups delete` after review).
 */
export function consolidateAgentGroups(keepId: string): ConsolidateResult {
  const keep = getAgentGroup(keepId);
  if (!keep) throw new Error(`agent group not found: ${keepId}`);

  const wirings = getDb().prepare('SELECT * FROM messaging_group_agents').all() as MessagingGroupAgent[];

  const rewired: ConsolidateResult['rewired'] = [];
  let alreadyOnKeep = 0;

  for (const mga of wirings) {
    if (mga.agent_group_id === keep.id) {
      if (mga.session_mode !== 'shared') {
        updateMessagingGroupAgent(mga.id, { session_mode: 'shared' });
      }
      alreadyOnKeep++;
      continue;
    }

    const existingKeep = getMessagingGroupAgentByPair(mga.messaging_group_id, keep.id);
    if (existingKeep) {
      if (existingKeep.session_mode !== 'shared') {
        updateMessagingGroupAgent(existingKeep.id, { session_mode: 'shared' });
      }
      deleteMessagingGroupAgent(mga.id);
      rewired.push({
        messagingGroupId: mga.messaging_group_id,
        fromAgentGroupId: mga.agent_group_id,
        mgaId: mga.id,
      });
      continue;
    }

    createMessagingGroupAgent({
      ...mga,
      id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agent_group_id: keep.id,
      session_mode: 'shared',
      created_at: new Date().toISOString(),
    });
    deleteMessagingGroupAgent(mga.id);
    rewired.push({
      messagingGroupId: mga.messaging_group_id,
      fromAgentGroupId: mga.agent_group_id,
      mgaId: mga.id,
    });
  }

  return {
    keep,
    rewired,
    alreadyOnKeep,
    otherGroups: getAllAgentGroups().filter((g) => g.id !== keep.id),
  };
}
