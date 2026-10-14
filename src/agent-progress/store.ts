import { getDb } from '../db/connection.js';
import type { ProgressSnapshot } from './model.js';
export interface ProgressCardRow {
  run_id: string;
  instance: string;
  session_id: string;
  agent_group_id: string;
  messaging_group_id: string;
  in_reply_to: string | null;
  platform_id: string;
  thread_id: string | null;
  channel_id: string;
  guild_id: string | null;
  application_id: string | null;
  bot_id: string | null;
  message_id: string | null;
  snapshot: string | null;
  event_revision: number;
  revision: number;
  rendered_revision: number;
  expanded: number;
  delivery_state: 'new' | 'sending' | 'sent' | 'lost' | 'uncertain';
  retry_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}
export async function getProgressCard(runId: string): Promise<ProgressCardRow | undefined> {
  return getDb().get<ProgressCardRow>('SELECT * FROM agent_progress_cards WHERE run_id = ?', runId);
}
export async function saveProgressCard(row: ProgressCardRow): Promise<void> {
  const fields = Object.keys(row) as Array<keyof ProgressCardRow>;
  await getDb().run(
    `INSERT INTO agent_progress_cards (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})
    ON CONFLICT(run_id) DO UPDATE SET ${fields
      .filter((k) => k !== 'run_id')
      .map((k) => `${k}=excluded.${k}`)
      .join(',')}`,
    ...fields.map((k) => row[k]),
  );
}
export async function listProgressCards(instance: string): Promise<ProgressCardRow[]> {
  return getDb().all<ProgressCardRow>('SELECT * FROM agent_progress_cards WHERE instance = ?', instance);
}
export function snapshotOf(row: ProgressCardRow): ProgressSnapshot {
  return JSON.parse(row.snapshot!) as ProgressSnapshot;
}
