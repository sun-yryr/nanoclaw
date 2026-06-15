import type { UserContentPart } from '../providers/types.js';
import type { ResolvedAttachment } from './resolve-attachments.js';
import { uploadVideoToKimi } from './kimi-files-upload.js';

/** Max video size for inline base64 fallback when Files API is unavailable. */
export const VIDEO_INLINE_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;

/** @deprecated Use VIDEO_INLINE_FALLBACK_MAX_BYTES. */
export const VIDEO_INLINE_MAX_BYTES = VIDEO_INLINE_FALLBACK_MAX_BYTES;

function log(msg: string): void {
  console.error(`[build-kimi-content] ${msg}`);
}

function dataUrl(mimeType: string, data: Buffer): string {
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

async function videoPartForAttachment(
  att: ResolvedAttachment,
  fetchImpl: typeof fetch,
): Promise<UserContentPart | null> {
  try {
    const uploaded = await uploadVideoToKimi(att.data, att.name, fetchImpl);
    return { type: 'video_url', video_url: { url: uploaded.url } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`Video upload failed for ${att.name} (${att.data.length} bytes): ${reason}`);

    if (att.data.length <= VIDEO_INLINE_FALLBACK_MAX_BYTES) {
      log(
        `Falling back to inline video_url for ${att.name} (${att.data.length} bytes) — ` +
          `OpenCode Go has no /files endpoint; large clips need MOONSHOT_API_KEY for direct upload`,
      );
      return { type: 'video_url', video_url: { url: dataUrl(att.mimeType, att.data) } };
    }

    log(
      `Video ${att.name} (${att.data.length} bytes) exceeds inline fallback limit; ` +
        `set MOONSHOT_API_KEY (Moonshot platform key) for Files API upload`,
    );
    return null;
  }
}

export async function buildKimiContentParts(
  attachments: ResolvedAttachment[],
  textPrompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UserContentPart[]> {
  const parts: UserContentPart[] = [];

  for (const att of attachments) {
    if (att.kind === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: dataUrl(att.mimeType, att.data) },
      });
      continue;
    }

    if (att.kind === 'video') {
      const part = await videoPartForAttachment(att, fetchImpl);
      if (part) parts.push(part);
    }
  }

  if (textPrompt.trim()) {
    parts.push({ type: 'text', text: textPrompt });
  } else if (parts.length > 0) {
    parts.push({ type: 'text', text: 'The user sent media without a caption.' });
  }

  return parts;
}
