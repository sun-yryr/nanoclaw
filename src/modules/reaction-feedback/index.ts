import { log } from '../../log.js';
import { onHostStart } from '../../host-lifecycle.js';
import { importRecentFeedback } from './backfill.js';
import { register } from '../../cli/registry.js';
import { registerFeedbackMigration, readFeedback } from './store.js';
registerFeedbackMigration();
register({
  name: 'groups-feedback',
  resource: 'groups',
  access: 'open',
  description:
    'Read human reaction feedback for this agent group. --id GROUP (auto-filled for agents), optional --message-id OUTBOUND_ID. Ratings are answer quality, not task completion. JSON includes removed reactions and a truncation flag.',
  parseArgs(raw) {
    if (typeof raw.id !== 'string' || !raw.id) throw new Error('--id required');
    if (raw.message_id !== undefined && typeof raw.message_id !== 'string') throw new Error('Invalid --message-id');
    return { id: raw.id, messageId: raw.message_id as string | undefined };
  },
  async handler(args, ctx) {
    // Even global agents read only their own feedback; host can select a group.
    if (ctx.caller === 'agent' && args.id !== ctx.agentGroupId)
      throw new Error('Feedback belongs to a different group');
    return readFeedback(args.id, args.messageId);
  },
});

onHostStart(async () => {
  try {
    await importRecentFeedback();
  } catch (err) {
    log.warn('Recent reaction history import failed; new answers remain tracked', { err });
  }
});
