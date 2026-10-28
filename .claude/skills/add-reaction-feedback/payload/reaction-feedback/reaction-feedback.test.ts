import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emoji, type Adapter, type Chat } from 'chat';
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn(async () => {}) }));
vi.mock('../../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));
import { writeSessionMessage } from '../../session-manager.js';
import { registerWebhookAdapter } from '../../webhook-server.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createChatSdkBridge } from '../../channels/chat-sdk-bridge.js';
import { lookup } from '../../cli/registry.js';
import { readFeedback } from './store.js';
import { receiveReaction, recordFeedbackMessage } from './service.js';
import './index.js';
const stamp = '2026-10-22T00:00:00.000Z';
const origin = { messageId: 'out-1', sessionId: 's1', agentGroupId: 'g1' };
let adapter: Adapter;
let bridge: ReturnType<typeof createChatSdkBridge>;
let part = 0;
beforeEach(async () => {
  vi.clearAllMocks();
  part = 0;
  const db = await initTestDb();
  await runMigrations(db);
  await db.run('INSERT INTO agent_groups(id,name,folder,created_at) VALUES (?,?,?,?)', 'g1', 'Agent', 'agent', stamp);
  await db.run(
    'INSERT INTO sessions(id,agent_group_id,status,created_at) VALUES (?,?,?,?)',
    's1',
    'g1',
    'active',
    stamp,
  );
  await db.run('INSERT INTO users(id,kind,created_at) VALUES (?,?,?)', 'discord:human', 'human', stamp);
  await db.run('INSERT INTO user_roles(user_id,role,granted_at) VALUES (?,?,?)', 'discord:human', 'owner', stamp);
  adapter = {
    name: 'discord',
    initialize: async () => {},
    channelIdFromThreadId: () => 'discord:guild:channel',
    postMessage: vi.fn(async () => ({ id: `part-${++part}` })),
  } as unknown as Adapter;
  bridge = createChatSdkBridge({
    adapter,
    supportsThreads: true,
    maxTextLength: 20,
    onReaction: receiveReaction,
    onMessageSent: recordFeedbackMessage,
  });
  await bridge.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
});
afterEach(async () => {
  await bridge?.teardown();
  await closeDb();
});
async function send() {
  await bridge.deliver('discord:guild:channel', 'discord:guild:channel:thread', {
    origin,
    kind: 'chat',
    content: { text: 'A useful answer about a deadline that is still unfinished.' },
  });
}
async function react(rawEmoji = '👀', added = true, userId = 'human', messageId = 'part-1', isBot = false) {
  const chat = vi.mocked(registerWebhookAdapter).mock.calls.at(-1)![0] as Chat;
  let work: Promise<unknown> | undefined;
  chat.processReaction(
    {
      adapter,
      added,
      emoji: emoji.eyes,
      rawEmoji,
      messageId,
      threadId: 'discord:guild:channel:thread',
      raw: {},
      user: { userId, userName: userId, fullName: userId, isBot, isMe: false },
    },
    {
      waitUntil: (p) => {
        work = p;
      },
    },
  );
  await work;
}
describe('Discord reaction feedback', () => {
  it('records split parts against one answer and silently delivers reactions through the real SDK', async () => {
    await send();
    expect(part).toBeGreaterThan(1);
    await react('👀', true, 'human', `part-${part}`);
    const { feedback } = await readFeedback('g1');
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({ message_id: 'out-1', meaning: 'seen', active: 1 });
    expect(writeSessionMessage).toHaveBeenCalledWith(
      'g1',
      's1',
      expect.objectContaining({ trigger: false, channelType: 'session-echo', kind: 'chat' }),
    );
    expect(JSON.parse(vi.mocked(writeSessionMessage).mock.calls[0][2].content).text).toContain(
      'never mark a task read or complete from a rating',
    );
  });
  it('keeps quality ratings distinct from read/ack and handles removals and duplicates', async () => {
    await send();
    for (const reaction of ['👍', '👎', '🆗', '👀']) await react(reaction);
    expect((await readFeedback('g1')).feedback.map((r) => r.meaning).sort()).toEqual(
      ['good_answer', 'bad_answer', 'acknowledged', 'seen'].sort(),
    );
    await react('👀');
    expect(writeSessionMessage).toHaveBeenCalledTimes(4);
    await react('👀', false);
    expect((await readFeedback('g1')).feedback.find((r) => r.meaning === 'seen')?.active).toBe(0);
    await react('👀', false);
    expect(writeSessionMessage).toHaveBeenCalledTimes(5);
  });
  it('ignores bots, strangers, unknown messages, and sibling adapter identities', async () => {
    await send();
    await react('👀', true, 'human', 'part-1', true);
    await react('👀', true, 'stranger');
    await react('👀', true, 'human', 'not-ours');
    expect((await readFeedback('g1')).feedback).toEqual([]);
    await receiveReaction(
      { user: { userId: 'human' }, messageId: 'part-1', rawEmoji: '👀', added: true } as never,
      'discord-other',
    );
    expect((await readFeedback('g1')).feedback).toEqual([]);
  });
  it('scopes persistent reads to the agent group, including global agents', async () => {
    await send();
    await react();
    const command = lookup('groups-feedback')!;
    expect(
      ((await command.handler({ id: 'g1' }, { caller: 'host' })) as { feedback: unknown[] }).feedback,
    ).toHaveLength(1);
    await expect(
      command.handler({ id: 'g1' }, { caller: 'agent', agentGroupId: 'g2', sessionId: 's2', messagingGroupId: 'm' }),
    ).rejects.toThrow('different group');
    expect((await readFeedback('g2')).feedback).toEqual([]);
  });
  it('pins host wiring and Discord opt-in so metadata cannot silently stop arriving', () => {
    const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source('../../delivery.ts')).toContain(
      '{ messageId: msg.id, sessionId: session.id, agentGroupId: session.agent_group_id }',
    );
    expect(source('../../channels/channel-registry.ts')).toContain('files, origin');
    expect(source('../../channels/discord.ts')).toContain('onReaction: receiveReaction');
    expect(source('../../channels/discord.ts')).toContain('onMessageSent: recordFeedbackMessage');
    expect(source('../index.ts')).toContain("import './reaction-feedback/index.js'");
  });
});

it('imports existing delivered answers before accepting new feedback on them', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const { importSessionFeedback } = await import('./backfill.js');
  const { getDb } = await import('../../db/connection.js');
  const { getHostStartCallbacks } = await import('../../host-lifecycle.js');
  const dir = mkdtempSync(join(tmpdir(), 'reaction-history-'));
  try {
    const inbound = new Database(join(dir, 'inbound.db'));
    const outbound = new Database(join(dir, 'outbound.db'));
    inbound.exec(`CREATE TABLE delivered(message_out_id TEXT,platform_message_id TEXT,status TEXT,delivered_at TEXT);
      INSERT INTO delivered VALUES ('old-answer','old-part','delivered','2026-10-22T00:00:00.000Z');`);
    outbound.exec(
      'CREATE TABLE messages_out(id TEXT,kind TEXT,channel_type TEXT,platform_id TEXT,thread_id TEXT,content TEXT)',
    );
    outbound
      .prepare('INSERT INTO messages_out VALUES (?,?,?,?,?,?)')
      .run(
        'old-answer',
        'chat',
        'discord',
        'discord:guild:channel',
        null,
        JSON.stringify({ text: 'Existing notification' }),
      );
    inbound.close();
    outbound.close();
    await getDb().run(
      'INSERT INTO messaging_groups(id,channel_type,platform_id,instance,created_at) VALUES (?,?,?,?,?)',
      'mg',
      'discord',
      'discord:guild:channel',
      'discord',
      stamp,
    );
    const session = { id: 's1', agent_group_id: 'g1', messaging_group_id: 'mg' } as import('../../types.js').Session;
    expect(await importSessionFeedback(session, join(dir, 'inbound.db'), join(dir, 'outbound.db'))).toBe(1);
    await react('👀', true, 'human', 'old-part');
    expect((await readFeedback('g1')).feedback[0]).toMatchObject({ message_id: 'old-answer', meaning: 'seen' });
    expect(getHostStartCallbacks().length).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
