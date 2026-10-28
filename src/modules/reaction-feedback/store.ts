import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';

export type FeedbackMeaning = 'seen' | 'good_answer' | 'bad_answer' | 'acknowledged' | 'other';
export function reactionMeaning(raw: string): FeedbackMeaning {
  const name = raw
    .replace(/^:|:$/g, '')
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
  if (['eyes', '👀'].includes(name)) return 'seen';
  if (['+1', 'thumbsup', 'thumbs_up', '👍'].includes(name)) return 'good_answer';
  if (['-1', 'thumbsdown', 'thumbs_down', '👎'].includes(name)) return 'bad_answer';
  if (['ok', 'OK', '🆗', 'ok_hand', '👌'].includes(name)) return 'acknowledged';
  return 'other';
}
export function registerFeedbackMigration() {
  registerMigration({
    version: 1,
    name: 'module:reaction-feedback:messages',
    async up(db) {
      await db.exec(`CREATE TABLE feedback_messages (
        instance TEXT NOT NULL, platform_message_id TEXT NOT NULL,
        platform_id TEXT NOT NULL, thread_id TEXT,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(instance, platform_message_id));
        CREATE TABLE message_feedback (
        instance TEXT NOT NULL, platform_message_id TEXT NOT NULL,
        user_id TEXT NOT NULL, emoji TEXT NOT NULL, meaning TEXT NOT NULL,
        active INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(instance, platform_message_id, user_id, emoji),
        FOREIGN KEY(instance, platform_message_id) REFERENCES feedback_messages(instance, platform_message_id) ON DELETE CASCADE);
        CREATE INDEX feedback_messages_group ON feedback_messages(agent_group_id, message_id);`);
    },
  });
}
export interface FeedbackRow {
  message_id: string;
  platform_message_id: string;
  user_id: string;
  emoji: string;
  meaning: FeedbackMeaning;
  active: number;
  updated_at: string;
  body: string;
}
export async function readFeedback(group: string, messageId?: string, limit = 50) {
  const rows = await getDb().all<FeedbackRow>(
    `SELECT f.*, m.message_id, m.body FROM message_feedback f JOIN feedback_messages m
     ON m.instance=f.instance AND m.platform_message_id=f.platform_message_id
     WHERE m.agent_group_id=?${messageId ? ' AND m.message_id=?' : ''}
     ORDER BY f.updated_at DESC, f.platform_message_id, f.user_id, f.emoji LIMIT ?`,
    ...[group, ...(messageId ? [messageId] : []), limit + 1],
  );
  return {
    feedback: rows.slice(0, limit).map((row) => ({ ...row, body: row.body.slice(0, messageId ? 16000 : 2000) })),
    truncated: rows.length > limit,
  };
}
