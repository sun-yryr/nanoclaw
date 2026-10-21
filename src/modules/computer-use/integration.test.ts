import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runMigrations } from '../../db/migrations/index.js';
import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig } from '../../db/container-configs.js';
import { materializeContainerJson } from '../../container-config.js';
import { getDeliveryAction } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import { validGuiRequest } from './protocol.js';
import '../../modules/index.js';
vi.mock('../../session-manager.js', async (original) => ({
  ...(await original<typeof import('../../session-manager.js')>()),
  writeSessionMessage: vi.fn(),
}));
const root = '/tmp/nanoclaw-cua-test-groups';
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-cua-test-groups',
}));
const session = {
  id: 's1',
  agent_group_id: 'g1',
  messaging_group_id: null,
  thread_id: null,
  agent_provider: 'cline',
  status: 'active' as const,
  container_status: 'running' as const,
  last_active: null,
  created_at: new Date().toISOString(),
};
beforeEach(async () => {
  vi.clearAllMocks();
  await initTestDb();
  await runMigrations(getDb());
  await createAgentGroup({
    id: 'g1',
    name: 'test',
    folder: 'gui',
    agent_provider: 'cline',
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('g1', 'cline');
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});
it('loads the real module barrel and denies GUI access until a group is explicitly enabled', async () => {
  const action = getDeliveryAction('gui_request');
  expect(action).toBeTypeOf('function');
  await action!(
    {
      action: 'gui_request',
      requestId: 'test',
      deadline: Date.now() + 20000,
      operation: { kind: 'acquire', owner: 'worker' },
    },
    session,
  );
  expect(vi.mocked(writeSessionMessage).mock.calls.at(-1)?.[2].content).toContain('disabled');
});
it('materializes GUI capability only for an enabled persistent environment and grants its lease through guarded delivery', async () => {
  expect((await materializeContainerJson('g1')).computerUse).toBeUndefined();
  await getDb().run(
    `INSERT INTO cua_environments VALUES (?,?,?,?,?,?,1,?)`,
    'g1',
    'http://172.20.0.2:3211',
    '/operator/token',
    'gui',
    'internal',
    'onecli',
    new Date().toISOString(),
  );
  expect((await materializeContainerJson('g1')).computerUse).toBe(true);
  const req = {
    action: 'gui_request',
    requestId: 'enabled',
    deadline: Date.now() + 20000,
    operation: { kind: 'acquire', owner: 'worker' },
  };
  expect(validGuiRequest(req)).toBe(true);
  await getDeliveryAction('gui_request')!(req, session);
  expect(vi.mocked(writeSessionMessage).mock.calls.at(-1)?.[2]).toMatchObject({ trigger: false, kind: 'system' });
  expect(JSON.parse(vi.mocked(writeSessionMessage).mock.calls.at(-1)![2].content).response).toMatchObject({
    ok: true,
    lease: expect.any(String),
  });
});
it('rejects expired operations without executing a GUI action', async () => {
  await getDeliveryAction('gui_request')!(
    { action: 'gui_request', requestId: 'expired', deadline: 1, operation: { kind: 'acquire', owner: 'worker' } },
    session,
  );
  expect(vi.mocked(writeSessionMessage).mock.calls.at(-1)?.[2].content).toContain('expired');
});
it('keeps capability visible while human control pauses input, and marks operator commands host-only', async () => {
  await getDb().run(
    `INSERT INTO cua_environments VALUES (?,?,?,?,?,?,0,?)`,
    'g1',
    'http://172.20.0.2:3211',
    '/operator/token',
    'gui',
    'internal',
    'onecli',
    new Date().toISOString(),
  );
  expect((await materializeContainerJson('g1')).computerUse).toBe(true);
  const { lookup, commandGuard } = await import('../../cli/registry.js');
  const { guard } = await import('../../guard/index.js');
  for (const name of ['computer-pause', 'computer-resume']) {
    expect(lookup(name)?.hostOnly).toBe(true);
    expect(
      await guard(commandGuard(name), {
        actor: { kind: 'agent', agentGroupId: 'g1', sessionId: 's1' },
        payload: { id: 'g1' },
      }),
    ).toMatchObject({ effect: 'deny' });
  }
});
