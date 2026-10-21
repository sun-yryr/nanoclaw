import { getDb, hasTable } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
export interface GuiEnvironment {
  agent_group_id: string;
  endpoint: string;
  token_path: string;
  container_name: string;
  network_name: string;
  gateway_container: string;
  enabled: number;
}
export async function getGuiEnvironment(groupId: string, includeDisabled = false): Promise<GuiEnvironment | undefined> {
  const db = getDb();
  if (!(await hasTable(db, 'cua_environments'))) return undefined;
  return db.get<GuiEnvironment>(
    `SELECT * FROM cua_environments WHERE agent_group_id = ?${includeDisabled ? '' : ' AND enabled = 1'}`,
    groupId,
  );
}
export function registerGuiMigration(): void {
  registerMigration({
    version: 1,
    name: 'module:computer-use:environments',
    async up(db) {
      await db.exec(`CREATE TABLE cua_environments (
        agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id),
        endpoint TEXT NOT NULL, token_path TEXT NOT NULL, container_name TEXT NOT NULL,
        network_name TEXT NOT NULL, gateway_container TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      )`);
    },
  });
}
