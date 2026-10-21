/** Operator smoke test on the dedicated desktop. No existing user account data is read. */
import fs from 'node:fs/promises';
import { initDb, closeDb } from '../src/db/connection.js';
import { getGuiEnvironment } from '../src/modules/computer-use/store.js';
import { connectGui } from '../src/modules/computer-use/cua.js';
await initDb();
try {
  const env = await getGuiEnvironment(process.argv[2]);
  if (!env) throw new Error('GUI not configured');
  const client = await connectGui(env);
  const signal = AbortSignal.timeout(20_000);
  await client.act({ kind: 'key', keys: ['ctrl', 'l'] }, signal);
  await client.act({ kind: 'type', text: 'https://example.com' }, signal);
  await client.act({ kind: 'key', keys: ['enter'] }, signal);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const screen = await client.observe(signal);
  await fs.writeFile('/tmp/nanoclaw-cua-browser-smoke.jpg', Buffer.from(screen.data, 'base64'), { mode: 0o600 });
  console.log(`Browser probe captured (${screen.width}x${screen.height}); screen contains only the test website.`);
} finally {
  await closeDb();
}
