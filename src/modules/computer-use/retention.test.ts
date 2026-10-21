import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { INBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
import { wrapSqliteInbound } from '../../mailbox/sqlite/index.js';
it('prunes only transient system responses; preserves chat and newer replies', async () => {
  const db = new Database(':memory:');
  db.exec(INBOUND_SCHEMA);
  let seq = 0;
  const mailbox = wrapSqliteInbound(db, () => (seq += 2));
  try {
    for (const [id, kind, timestamp] of [
      ['gui-response-old', 'system', '2026-10-21T00:00:00.000Z'],
      ['gui-response-chat', 'chat', '2026-10-21T00:00:00.000Z'],
      ['gui-response-new', 'system', '2026-10-21T00:02:00.000Z'],
    ] as const)
      await mailbox.insertMessage({
        id,
        kind,
        timestamp,
        content: '{}',
        trigger: false,
        platformId: null,
        channelType: null,
        threadId: null,
        processAfter: null,
        recurrence: null,
      });
    expect(mailbox.pruneSystemMessages!('gui-response-', '2026-10-21T00:01:00.000Z')).toBe(1);
    expect((db.prepare('SELECT id FROM messages_in ORDER BY id').all() as { id: string }[]).map((r) => r.id)).toEqual([
      'gui-response-chat',
      'gui-response-new',
    ]);
  } finally {
    db.close();
  }
});
