/** Default-mailbox import: retain old message identities so new reactions on recent answers work too. */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { getDb } from '../../db/connection.js';
import {
  getMessagingGroup,
  getMessagingGroupForOwnDestination,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { getAgentMailbox } from '../../mailbox/index.js';
import { SqliteAgentMailbox, inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/index.js';
import type { Session } from '../../types.js';
import { recordFeedbackMessage } from './service.js';

export async function importSessionFeedback(session: Session, inboundPath: string, outboundPath: string) {
  if (!existsSync(inboundPath) || !existsSync(outboundPath)) return 0;
  const inbound = new Database(inboundPath, { readonly: true, fileMustExist: true });
  let outbound: Database.Database | undefined;
  try {
    outbound = new Database(outboundPath, { readonly: true, fileMustExist: true });
    const receipts = inbound
      .prepare(
        `SELECT message_out_id,platform_message_id FROM delivered
      WHERE status='delivered' AND platform_message_id IS NOT NULL ORDER BY delivered_at DESC LIMIT 200`,
      )
      .all() as {
      message_out_id: string;
      platform_message_id: string;
    }[];
    const find = outbound.prepare(`SELECT content,platform_id,thread_id,kind FROM messages_out
      WHERE id=? AND channel_type='discord' AND kind IN ('chat','chat-sdk')`);
    let count = 0;
    const originMg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    for (const receipt of receipts) {
      const row = find.get(receipt.message_out_id) as
        | {
            content: string;
            platform_id: string;
            thread_id: string | null;
            kind: string;
          }
        | undefined;
      if (!row) continue;
      const mg =
        originMg?.channel_type === 'discord' && originMg.platform_id === row.platform_id
          ? originMg
          : ((await getMessagingGroupForOwnDestination(session.agent_group_id, 'discord', row.platform_id)) ??
            (await getMessagingGroupByPlatform('discord', row.platform_id)));
      if (!mg) continue;
      await recordFeedbackMessage(
        {
          kind: row.kind,
          content: JSON.parse(row.content),
          origin: {
            messageId: receipt.message_out_id,
            sessionId: session.id,
            agentGroupId: session.agent_group_id,
          },
        },
        {
          instance: mg.instance ?? 'discord',
          platformId: row.platform_id,
          threadId: row.thread_id,
          messageId: receipt.platform_message_id,
        },
      );
      count++;
    }
    return count;
  } finally {
    outbound?.close();
    inbound.close();
  }
}
export async function importRecentFeedback() {
  if (!(getAgentMailbox() instanceof SqliteAgentMailbox)) return;
  const sessions = await getDb().all<Session>('SELECT * FROM sessions');
  for (const session of sessions) {
    await importSessionFeedback(
      session,
      inboundDbPath(session.agent_group_id, session.id),
      outboundDbPath(session.agent_group_id, session.id),
    );
  }
}
