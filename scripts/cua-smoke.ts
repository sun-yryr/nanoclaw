/** Read-only live CUA connectivity check. Never prints screen contents or control tokens. */
import fs from 'node:fs/promises';
import { initDb, closeDb } from '../src/db/connection.js';
import { getGuiEnvironment } from '../src/modules/computer-use/store.js';
import { connectGui } from '../src/modules/computer-use/cua.js';
const group = process.argv[2];
if (!group) throw new Error('Use cua-smoke.ts <group-id>');
await initDb();
try {
  const env = await getGuiEnvironment(group);
  if (!env) throw new Error('GUI not configured');
  const client = await connectGui(env);
  const screen = await client.observe(AbortSignal.timeout(20_000));
  if (process.env.CUA_SMOKE_IMAGE)
    await fs.writeFile(process.env.CUA_SMOKE_IMAGE, Buffer.from(screen.data, 'base64'), { mode: 0o600 });
  console.log(`CUA screen OK: ${screen.width}x${screen.height}, ${Buffer.from(screen.data, 'base64').length} bytes`);
} finally {
  await closeDb();
}
