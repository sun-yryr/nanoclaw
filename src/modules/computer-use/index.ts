import { onHostShutdown } from '../../host-lifecycle.js';
import { registerGuiCommands } from './operator.js';
import { registerDeliveryAction } from '../../delivery.js';
import { defineGuardedAction, ALLOW, DENY, unguarded } from '../../guard/index.js';
import { withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { connectGui } from './cua.js';
import { GuiManager } from './manager.js';
import { validGuiRequest, type GuiResponse } from './protocol.js';
import { getGuiEnvironment, registerGuiMigration } from './store.js';
registerGuiMigration();
const manager = new GuiManager(async (group) => {
  const env = await getGuiEnvironment(group);
  if (!env) throw new Error('GUI disabled');
  return connectGui(env);
});
onHostShutdown(() => manager.stop());
registerGuiCommands(manager);
const guiAction = defineGuardedAction({
  action: 'computer.use',
  async decide({ actor }) {
    if (actor.kind !== 'agent' || !actor.sessionId) return DENY('A session is required');
    return (await getGuiEnvironment(actor.agentGroupId)) ? ALLOW('Group desktop enabled') : DENY('GUI disabled');
  },
});
async function respond(session: Session, requestId: string, response: GuiResponse) {
  await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    mailbox.pruneSystemMessages?.('gui-response-', new Date(Date.now() - 60_000).toISOString());
  });
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `gui-response-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    trigger: false,
    content: JSON.stringify({ type: 'gui_response', requestId, response }),
  });
}
registerDeliveryAction(
  'gui_request',
  async (content, session) => {
    // Validate again because TypeScript's guard precheck does not narrow handler arguments.
    if (!validGuiRequest(content)) return;
    const response = await manager.request(session.agent_group_id, session.id, content);
    await respond(session, content.requestId, response);
  },
  {
    guardAction: guiAction,
    async precheck(content, session) {
      if (validGuiRequest(content)) return true;
      if (typeof content.requestId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(content.requestId))
        await respond(session, content.requestId, { ok: false, code: 'expired' });
      return false;
    },
    requestHold: async () => {
      throw new Error('GUI policy is allow/deny only');
    },
    onDeny: async (content, session) => respond(session, String(content.requestId), { ok: false, code: 'disabled' }),
  },
);

// Acknowledgements can remove only this session's GUI RPC rows, even after GUI is disabled.
registerDeliveryAction(
  'gui_ack',
  async (content, session) => {
    if (typeof content.requestId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(content.requestId)) return;
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      mailbox.pruneSystemMessages?.(`gui-response-${content.requestId}`, new Date().toISOString());
    });
  },
  unguarded('Only removes the calling session GUI response after consumption; never operates a desktop'),
);
