/** Put a randomly generated synthetic code on the dedicated GUI. Run before user login only. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { initDb, closeDb } from '../src/db/connection.js';
import { connectGui } from '../src/modules/computer-use/cua.js';
import { getGuiEnvironment } from '../src/modules/computer-use/store.js';
await initDb();
try {
  const env = await getGuiEnvironment(process.argv[2]);
  if (!env) throw new Error('No GUI');
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const html = `<html><body style="font:48px sans-serif;background:white;padding:60px"><h1>Desk Check</h1><p>${code}</p><button style="font:32px sans-serif;padding:16px" onclick="document.getElementById('status').textContent='VERIFIED'">Verify</button><p id="status">READY</p><p style="font-size:22px">Synthetic GUI test. No private account data.</p></body></html>`;
  const c = await connectGui(env);
  const signal = AbortSignal.timeout(20000);
  await c.act({ kind: 'key', keys: ['ctrl', 'l'] }, signal);
  await c.act({ kind: 'type', text: `data:text/html,${encodeURIComponent(html)}` }, signal);
  await c.act({ kind: 'key', keys: ['enter'] }, signal);
  await fs.writeFile('/tmp/nanoclaw-cua-expected-code', code, { mode: 0o600 });
  console.log('Synthetic screen ready; expected code saved privately for comparison.');
} finally {
  await closeDb();
}
