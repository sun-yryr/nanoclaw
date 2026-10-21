/** Host-only controls: all UI and viewer authentication remain CUA-owned. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { register } from '../../cli/registry.js';
import { getDb } from '../../db/connection.js';
import { embedded } from '@trycua/cua';
import { verifyGuiNetwork } from './cua.js';
import { getGuiEnvironment } from './store.js';
import type { GuiManager } from './manager.js';
const exec = promisify(execFile);
export function registerGuiCommands(manager: GuiManager): void {
  const parseArgs = (raw: Record<string, unknown>) => {
    if (typeof raw.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(raw.id))
      throw new Error('--id <agent-group-id> is required');
    return { id: raw.id };
  };
  register({
    name: 'computer-pause',
    resource: 'computer',
    access: 'open',
    hostOnly: true,
    description: 'Pause agent GUI input, retaining the desktop and browser login.',
    parseArgs,
    async handler({ id }) {
      if (!(await getGuiEnvironment(id, true))) throw new Error('GUI not configured');
      await getDb().run(
        'UPDATE cua_environments SET enabled = 0, updated_at = ? WHERE agent_group_id = ?',
        new Date().toISOString(),
        id,
      );
      await manager.pause(id);
      return { paused: true, desktopPreserved: true };
    },
  });
  register({
    name: 'computer-resume',
    resource: 'computer',
    access: 'open',
    hostOnly: true,
    description: 'Revoke CUA Viewer tickets and return GUI control to agents without closing the browser.',
    parseArgs,
    async handler({ id }) {
      const env = await getGuiEnvironment(id, true);
      if (!env) throw new Error('GUI not configured');
      await getDb().run(
        'UPDATE cua_environments SET enabled = 0, updated_at = ? WHERE agent_group_id = ?',
        new Date().toISOString(),
        id,
      );
      await manager.pause(id);
      await verifyGuiNetwork(env);
      const token = crypto.randomBytes(32).toString('hex');
      await fs.writeFile(env.token_path, token, { mode: 0o600 });
      // Only spacesd restarts. Desktop and Chromium processes keep running.
      await exec(
        'docker',
        [
          'exec',
          env.container_name,
          'supervisorctl',
          '-c',
          '/etc/supervisor/supervisord.conf',
          'restart',
          'cua-spacesd',
        ],
        { timeout: 20_000, maxBuffer: 65536 },
      );
      const client = await embedded().spacesd(env.endpoint, token);
      await client.health({ signal: AbortSignal.timeout(10_000) });
      await getDb().run(
        'UPDATE cua_environments SET enabled = 1, updated_at = ? WHERE agent_group_id = ?',
        new Date().toISOString(),
        id,
      );
      manager.resume(id);
      return { paused: false, desktopPreserved: true, previousViewerTicketsRevoked: true };
    },
  });
}
