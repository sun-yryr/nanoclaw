import type { Migration } from './index.js';
export const migration026: Migration = {
  version: 26,
  name: 'agent-progress-cards',
  async up(db) {
    await db.exec(`CREATE TABLE agent_progress_cards (
      run_id TEXT PRIMARY KEY, instance TEXT NOT NULL, session_id TEXT NOT NULL,
      agent_group_id TEXT NOT NULL, messaging_group_id TEXT NOT NULL, in_reply_to TEXT,
      platform_id TEXT NOT NULL, thread_id TEXT, channel_id TEXT NOT NULL, guild_id TEXT,
      application_id TEXT, bot_id TEXT, message_id TEXT, snapshot TEXT,
      event_revision INTEGER NOT NULL, revision INTEGER NOT NULL, rendered_revision INTEGER NOT NULL,
      expanded INTEGER NOT NULL, delivery_state TEXT NOT NULL, retry_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
    ); CREATE INDEX agent_progress_pending ON agent_progress_cards(instance, delivery_state);`);
  },
};
