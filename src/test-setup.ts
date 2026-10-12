import { beforeEach } from 'vitest';

import type { GatewayProviderDefinition } from './gateway-providers/gateway-provider-registry.js';

const gateway: GatewayProviderDefinition = {
  kind: 'test-gateway',
  agentSkills: [],
  sessions: {
    async ensure() {
      return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
    },
  },
  approvals: {
    async subscribe(_decide, signal) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  },
};

beforeEach(async () => {
  // Upstream tests create multiple agent groups and expect group-chat thread
  // routing. This fork defaults to single-agent + shared sessions in production;
  // restore the upstream semantics only for the host test run.
  process.env.ALLOW_MULTIPLE_AGENT_GROUPS = 'true';
  process.env.FORCE_PER_THREAD_IN_GROUP_CHATS = 'true';

  await import('./mailbox/compose.js');
  (await import('./gateway-providers/index.js')).resetGatewayProvider(gateway);
});
