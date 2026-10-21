/** Persistent LAN read-only entry point; run under the operator's service manager. */
import fs from 'node:fs/promises';
import { embedded, telemetrySetEnabled, ViewerOptions } from '@trycua/cua';
import { closeDb, initDb } from '../../../../src/db/connection.js';
import { getGuiEnvironment } from '../../../../src/modules/computer-use/store.js';
import { verifyGuiNetwork } from '../../../../src/modules/computer-use/cua.js';
import { isPrivateIpv4, startWatchServer, WatchTickets } from '../../../../src/modules/computer-use/watch.js';

telemetrySetEnabled(false);
const config = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
if (
  typeof config.group !== 'string' ||
  !/^[A-Za-z0-9-]+$/.test(config.group) ||
  !isPrivateIpv4(config.host) ||
  !Number.isInteger(config.port) ||
  config.port < 1 ||
  config.port > 65535 ||
  typeof config.cert !== 'string' ||
  typeof config.key !== 'string'
)
  throw new Error('Invalid private LAN viewer configuration');
await initDb(undefined, { role: 'tool' });
const environment = async () => {
  const env = await getGuiEnvironment(config.group, true);
  if (!env) throw new Error('GUI not configured');
  return env;
};
const tickets = new WatchTickets(
  async () => {
    const env = await environment();
    return { endpoint: env.endpoint, token: (await fs.readFile(env.token_path, 'utf8')).trim() };
  },
  async (state) => {
    const env = await environment();
    const address = await verifyGuiNetwork(env);
    if (state.endpoint !== env.endpoint || env.endpoint !== `http://${address}:3211` || !state.token)
      throw new Error('GUI endpoint mismatch');
    const sandbox = await embedded().sandboxes().connectUrl(state.endpoint, state.token, undefined);
    return sandbox.viewerUrl(
      ViewerOptions.create({
        viewOnly: true,
        clipboard: false,
        filesRoot: '',
        microphone: false,
        ttlSeconds: 3600,
      }),
      { signal: AbortSignal.timeout(10_000) },
    );
  },
);
try {
  await tickets.get();
  const server = await startWatchServer({
    host: config.host,
    port: config.port,
    tls: { cert: await fs.readFile(config.cert), key: await fs.readFile(config.key) },
    tickets,
    endpoint: async () => (await environment()).endpoint,
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void server.close().finally(() => closeDb());
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`Read-only desktop available at ${server.origin}/`);
} catch {
  await closeDb();
  throw new Error('Cannot start the LAN viewer; check desktop, network, certificate and port');
}
