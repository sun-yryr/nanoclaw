import { log } from './log.js';

/** Attachment shape from Chat SDK or serialized inbound content. */
export interface DownloadableAttachment {
  type?: string;
  fetchData?: () => Promise<Buffer>;
  url?: string;
}

/**
 * Download attachment bytes and return base64. Chat SDK adapters (Discord,
 * Slack, …) usually expose a CDN `url` without `fetchData`; Telegram and
 * others may provide `fetchData` directly.
 */
export async function downloadAttachmentBase64(att: DownloadableAttachment): Promise<string | undefined> {
  if (att.fetchData) {
    try {
      const buffer = await att.fetchData();
      return buffer.toString('base64');
    } catch (err) {
      log.warn('Failed to download attachment via fetchData', { type: att.type, err });
      return undefined;
    }
  }

  if (typeof att.url === 'string' && att.url) {
    try {
      const res = await fetch(att.url);
      if (!res.ok) {
        log.warn('Failed to download attachment from url', { type: att.type, status: res.status, url: att.url });
        return undefined;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      return buffer.toString('base64');
    } catch (err) {
      log.warn('Failed to download attachment from url', { type: att.type, url: att.url, err });
      return undefined;
    }
  }

  return undefined;
}
