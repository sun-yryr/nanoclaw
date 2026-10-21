/** Operator-only access using CUA's own expiring Viewer ticket. */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { SocketTransport } from '../../../../src/cli/socket-client.js';
import { embedded, ViewerOptions, telemetrySetEnabled } from '@trycua/cua';
import { initDb, closeDb } from '../../../../src/db/connection.js';
import { getGuiEnvironment } from '../../../../src/modules/computer-use/store.js';
import { verifyGuiNetwork } from '../../../../src/modules/computer-use/cua.js';
import { forwardViewer } from './viewer-forward.js';
telemetrySetEnabled(false);
const output = process.argv[3];
if (!output) throw new Error('Pass <group-id> <private-output-file> [--local-port <port>] [--control]');
const option = (flag: string) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
};
const localPort = option('--local-port');
const httpsHost = option('--https-host');
const port = httpsHost ? Number(option('--port') ?? 13214) : localPort === undefined ? undefined : Number(localPort);
if (httpsHost && localPort) throw new Error('Choose --local-port or --https-host');
const certPath = option('--tls-cert');
const keyPath = option('--tls-key');
if (httpsHost && (!certPath || !keyPath)) throw new Error('HTTPS needs --tls-cert and --tls-key');
let forwarding: Awaited<ReturnType<typeof forwardViewer>> | undefined;
let published = false;
await initDb();
try {
  const env = await getGuiEnvironment(process.argv[2], true);
  if (!env) throw new Error('GUI not configured');
  const control = process.argv.includes('--control');
  if (control) {
    const paused = await new SocketTransport().sendFrame({
      id: crypto.randomUUID(),
      command: 'computer-pause',
      args: { id: env.agent_group_id },
    });
    if (!paused.ok) throw new Error('Cannot pause agent input; no control ticket issued');
  }
  const address = await verifyGuiNetwork(env);
  if (env.endpoint !== `http://${address}:3211`) throw new Error('GUI endpoint must match the isolated container');
  const sb = await embedded()
    .sandboxes()
    .connectUrl(env.endpoint, (await fs.readFile(env.token_path, 'utf8')).trim(), undefined);
  const view = await sb.viewerUrl(
    ViewerOptions.create({ viewOnly: !control, clipboard: false, microphone: false, ttlSeconds: 1800, filesRoot: '' }),
  );
  if (port !== undefined) {
    const secure = httpsHost
      ? { host: httpsHost, cert: await fs.readFile(certPath!), key: await fs.readFile(keyPath!) }
      : undefined;
    forwarding = await forwardViewer(env.endpoint, port, 1800_000, secure);
    const url = new URL(view.url);
    const origin = new URL(forwarding.origin);
    url.protocol = origin.protocol;
    url.host = origin.host;
    view.url = url.toString();
    process.once('SIGINT', forwarding.close);
    process.once('SIGTERM', forwarding.close);
  }
  // The caller chooses a private file, keeping the ticket out of ordinary operator logs.
  await fs.writeFile(
    output,
    JSON.stringify(view, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    { mode: 0o600 },
  );
  published = true;
  console.log(
    control
      ? 'CUA control ticket saved. Agent input is paused; use ncl computer resume --id <group> when finished.'
      : 'CUA view-only ticket saved (30 minutes).',
  );
  if (forwarding) console.log(`Viewer forwarding on ${forwarding.origin} for 30 minutes; keep this process running.`);
} finally {
  if (!published) forwarding?.close();
  await closeDb();
}
