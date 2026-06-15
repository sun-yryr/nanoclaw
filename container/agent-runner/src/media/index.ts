import type { MessageInRow } from '../db/messages-in.js';
import type { UserContentPart } from '../providers/types.js';
import { formatMessages } from '../formatter.js';
import { buildKimiContentParts } from './build-kimi-content.js';
import { messagesHaveAttachments, resolveAttachmentsFromMessages } from './resolve-attachments.js';

export { VIDEO_INLINE_MAX_BYTES } from './build-kimi-content.js';
export { resolveAttachmentsFromMessages, messagesHaveAttachments } from './resolve-attachments.js';
export type { ResolvedAttachment } from './resolve-attachments.js';

export interface UserTurnContent {
  prompt: string;
  userContent?: UserContentPart[];
}

/**
 * Build the text prompt and optional Kimi multimodal content parts for a
 * message batch. When attachments resolve to image/video bytes, media parts
 * are sent natively and attachment path lines are omitted from the text.
 */
export async function buildUserContentFromMessages(messages: MessageInRow[]): Promise<UserTurnContent> {
  const hasAttachments = messagesHaveAttachments(messages);
  const prompt = formatMessages(messages, { omitAttachments: hasAttachments });

  if (!hasAttachments) {
    return { prompt };
  }

  const attachments = await resolveAttachmentsFromMessages(messages);
  if (attachments.length === 0) {
    return { prompt: formatMessages(messages) };
  }

  const userContent = await buildKimiContentParts(attachments, prompt);
  if (userContent.length === 0) {
    return { prompt: formatMessages(messages) };
  }

  return { prompt, userContent };
}
