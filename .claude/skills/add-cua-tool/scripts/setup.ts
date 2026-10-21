/** Operator-only provisioning: named persistent Docker desktop, OneCLI-only egress. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OneCLI } from '@onecli-sh/sdk';
import { DATA_DIR } from '../../../../src/config.js';
import { readEnvFile } from '../../../../src/env.js';
import { initDb, getDb } from '../../../../src/db/connection.js';
import { runMigrations } from '../../../../src/db/migrations/index.js';
import { getAgentGroup } from '../../../../src/db/agent-groups.js';
import { registerGuiMigration } from '../../../../src/modules/computer-use/store.js';
const exec = promisify(execFile);
const group = process.argv[process.argv.indexOf('--group') + 1];
if (!process.argv.includes('--group') || !/^[A-Za-z0-9-]+$/.test(group))
  throw new Error('Use --group <agent-group-id>');
const values = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY', 'ONECLI_GATEWAY_CONTAINER', 'NANOCLAW_GATEWAY_PROVIDER']);
if (values.NANOCLAW_GATEWAY_PROVIDER !== 'onecli')
  throw new Error('This installer requires the selected OneCLI gateway');
registerGuiMigration();
await initDb();
await runMigrations(getDb());
if (!(await getAgentGroup(group))) throw new Error('Unknown agent group');
const container = `nanoclaw-gui-${group}`;
const network = `${container}-net`;
const volume = `${container}-home`;
const image = 'nanoclaw-cua:0.4.4';
const gateway = values.ONECLI_GATEWAY_CONTAINER || 'onecli';
const root = path.join(DATA_DIR, 'computer-use', group);
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const sdk = new OneCLI({ url: values.ONECLI_URL, apiKey: values.ONECLI_API_KEY });
const config = await sdk.getContainerConfig({ agent: group });
const upstream = new URL(config.env.HTTPS_PROXY);
if (upstream.protocol !== 'http:') throw new Error('Only an HTTP OneCLI proxy is supported');
await fs.writeFile(path.join(root, 'upstream.json'), JSON.stringify({ proxy: upstream.toString() }), { mode: 0o600 });
await fs.writeFile(path.join(root, 'ca.crt'), config.caCertificate, { mode: 0o644 });
const tokenPath = path.join(root, 'env-token');
try {
  await fs.access(tokenPath);
} catch {
  await fs.writeFile(tokenPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
}
const docker = async (...args: string[]) => (await exec('docker', args, { maxBuffer: 4 * 1024 * 1024 })).stdout;
async function exists(...args: string[]) {
  try {
    await docker(...args);
    return true;
  } catch {
    return false;
  }
}
if (!(await exists('network', 'inspect', network))) await docker('network', 'create', '--internal', network);
const net = JSON.parse(await docker('network', 'inspect', network))[0];
if (!net.Internal) throw new Error('Existing GUI network must be internal');
const gw = JSON.parse(await docker('inspect', gateway))[0];
if (!gw.NetworkSettings.Networks[network])
  await docker('network', 'connect', '--alias', upstream.hostname, network, gateway);
const currentGateway = JSON.parse(await docker('inspect', gateway))[0];
const gatewayAddress = currentGateway.NetworkSettings.Networks[network].IPAddress;
if (!(await exists('image', 'inspect', image))) {
  console.log('Building GUI image (includes Japanese fonts and OneCLI browser trust)');
  await docker('build', '-t', image, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../runtime'));
}
if (!(await exists('container', 'inspect', container))) {
  await docker('volume', 'create', volume);
  await docker(
    'create',
    '--name',
    container,
    '--restart',
    'unless-stopped',
    '--network',
    network,
    '--add-host',
    `${upstream.hostname}:${gatewayAddress}`,
    '--label',
    `nanoclaw-cua-group=${group}`,
    '--label',
    'nanoclaw-role=computer-use',
    '--cpus',
    '2',
    '--memory',
    '4g',
    '--shm-size',
    '512m',
    '--mount',
    `type=volume,src=${volume},dst=/home/cua`,
    '--mount',
    `type=bind,src=${root},dst=/run/nanoclaw-gui,readonly`,
    '-e',
    'CUA_ENV_TOKEN_FILE=/run/nanoclaw-gui/env-token',
    '-e',
    'CUA_ENV_LISTEN=0.0.0.0:3211',
    '-e',
    'CUA_TELEMETRY=0',
    '-e',
    'TZ=Asia/Tokyo',
    image,
  );
}
await docker('start', container);
const gui = JSON.parse(await docker('inspect', container))[0];
if (gui.Config.Labels?.['nanoclaw-cua-group'] !== group || Object.keys(gui.NetworkSettings.Networks).join() !== network)
  throw new Error('Existing GUI container does not match this group');
// Internal Docker networks do not publish ports on this host. Reach the verified bridge IP directly.
const address = gui.NetworkSettings.Networks[network].IPAddress;
if (!address) throw new Error('CUA has no isolated address');
const endpoint = `http://${address}:3211`;
await getDb().run(
  `INSERT INTO cua_environments
  (agent_group_id,endpoint,token_path,container_name,network_name,gateway_container,enabled,updated_at)
  VALUES (?,?,?,?,?,?,1,?) ON CONFLICT(agent_group_id) DO UPDATE SET
  endpoint=excluded.endpoint,token_path=excluded.token_path,container_name=excluded.container_name,
  network_name=excluded.network_name,gateway_container=excluded.gateway_container,enabled=1,updated_at=excluded.updated_at`,
  group,
  endpoint,
  tokenPath,
  container,
  network,
  gateway,
  new Date().toISOString(),
);
console.log(`Persistent desktop ready: ${container} (${endpoint}). Profile volume: ${volume}.`);
