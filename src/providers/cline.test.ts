import { afterEach, expect, it, vi } from 'vitest';
const dotenv = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) =>
    Object.fromEntries(keys.flatMap((key) => (key in dotenv.values ? [[key, dotenv.values[key]]] : []))),
}));
import './cline.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
afterEach(() => {
  dotenv.values = {};
});
const ctx = { sessionDir: '/tmp/test', agentGroupId: 'test', groupDir: '/tmp/test', selectedSkills: [], hostEnv: {} };
it('forwards delegation bounds and child authentication without changing SIWC parent defaults', async () => {
  dotenv.values = {
    CLINE_AUTH_MODE: 'siwc',
    CLINE_SPAWN_MODEL: 'child',
    CLINE_SPAWN_BASE_URL: 'https://opencode.ai/zen/go/v1',
    CLINE_SPAWN_AUTH_MODE: 'default',
    CLINE_SPAWN_API: 'chat',
    CLINE_SPAWN_MAX_ITERATIONS: '12',
    CLINE_DELEGATION_MAX_CONCURRENCY: '2',
    CLINE_DELEGATION_MAX_TASKS_PER_BATCH: '3',
    CLINE_DELEGATION_MAX_TASKS_PER_TURN: '6',
  };
  const { env } = await getProviderContainerConfig('cline')!(ctx);
  expect(env).toMatchObject({
    ...dotenv.values,
    CLINE_API: 'responses',
    CLINE_BASE_URL: 'https://api.openai.com/v1',
    OPENCODE_GO_API_KEY: 'siwc-sentinel',
  });
});
it('preserves an invalid empty bound for fail-fast container validation', async () => {
  dotenv.values = { CLINE_DELEGATION_MAX_CONCURRENCY: '' };
  expect((await getProviderContainerConfig('cline')!(ctx)).env).toEqual(dotenv.values);
});
it('leaves unconfigured Cline container env empty', async () => {
  expect((await getProviderContainerConfig('cline')!(ctx)).env).toEqual({});
});
