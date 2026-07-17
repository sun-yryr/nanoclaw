/**
 * Wire the local-voice channel to an existing agent group.
 *
 * Usage:
 *   pnpm exec tsx scripts/init-local-voice.ts --agent-group-id <uuid> [--device-id local]
 */
import crypto from 'crypto';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getAgentGroup } from '../src/db/agent-groups.js';
import { closeDb, initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { addMember } from '../src/modules/permissions/db/agent-group-members.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';

const CHANNEL_TYPE = 'local-voice';
const OPERATOR_ID = 'local-voice:operator';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function validDeviceId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

function main(): void {
  const agentGroupId = argument('--agent-group-id');
  const deviceId = argument('--device-id') ?? 'local';
  if (!agentGroupId) {
    throw new Error('--agent-group-id is required');
  }
  if (!validDeviceId(deviceId)) {
    throw new Error('--device-id must contain only letters, numbers, ".", "_", or "-"');
  }

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  try {
    const agentGroup = getAgentGroup(agentGroupId);
    if (!agentGroup) throw new Error(`Agent group not found: ${agentGroupId}`);

    const now = new Date().toISOString();
    upsertUser({
      id: OPERATOR_ID,
      kind: CHANNEL_TYPE,
      display_name: 'Local voice operator',
      created_at: now,
    });
    addMember({
      user_id: OPERATOR_ID,
      agent_group_id: agentGroup.id,
      added_by: OPERATOR_ID,
      added_at: now,
    });

    let messagingGroup = getMessagingGroupByPlatform(CHANNEL_TYPE, deviceId, CHANNEL_TYPE);
    if (!messagingGroup) {
      messagingGroup = {
        id: crypto.randomUUID(),
        channel_type: CHANNEL_TYPE,
        platform_id: deviceId,
        instance: CHANNEL_TYPE,
        name: `Local voice (${deviceId})`,
        is_group: 0,
        unknown_sender_policy: 'strict',
        created_at: now,
      };
      createMessagingGroup(messagingGroup);
    }

    if (!getMessagingGroupAgentByPair(messagingGroup.id, agentGroup.id)) {
      createMessagingGroupAgent({
        id: crypto.randomUUID(),
        messaging_group_id: messagingGroup.id,
        agent_group_id: agentGroup.id,
        engage_mode: 'mention',
        engage_pattern: null,
        sender_scope: 'known',
        ignored_message_policy: 'drop',
        session_mode: 'shared',
        priority: 0,
        created_at: now,
      });
    }

    console.log(`Local voice ${deviceId} is wired to ${agentGroup.name} (${agentGroup.id}).`);
  } finally {
    closeDb();
  }
}

main();
