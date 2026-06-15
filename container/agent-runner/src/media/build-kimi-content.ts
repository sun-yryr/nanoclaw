import type { UserContentPart } from '../providers/types.js';
import type { ResolvedAttachment } from './resolve-attachments.js';
import { uploadVideoToKimi } from './kimi-files-upload.js';

/** Inline base64 threshold for videos — above this use Files API. */
export const VIDEO_INLINE_MAX_BYTES = 20 * 1024 * 1024;

function log(msg: string): void {
  console.error(`[build-kimi-content] ${msg}`);
}

function dataUrl(mimeType: string, data: Buffer): string {
  return `data:${mimeType};base64,${data.toString('base64')}`;
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
      let videoUrl: string;
      if (att.data.length <= VIDEO_INLINE_MAX_BYTES) {
        videoUrl = dataUrl(att.mimeType, att.data);
      } else {
        try {
          const uploaded = await uploadVideoToKimi(att.data, att.name, fetchImpl);
          videoUrl = uploaded.url;
        } catch (err) {
          log(
            `Video upload failed for ${att.name} (${att.data.length} bytes): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
      }
      parts.push({
        type: 'video_url',
        video_url: { url: videoUrl },
      });
    }
  }

  if (textPrompt.trim()) {
    parts.push({ type: 'text', text: textPrompt });
  } else if (parts.length > 0) {
    parts.push({ type: 'text', text: 'The user sent media without a caption.' });
  }

  return parts;
}
