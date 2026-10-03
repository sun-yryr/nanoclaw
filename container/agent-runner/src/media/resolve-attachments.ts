import fs from 'fs';
import path from 'path';

import type { MessageInRow } from '../db/messages-in.js';
import { classifyAttachment, mimeForKind, type MediaKind } from './classify.js';

function workspaceRoot(): string {
  return process.env.NANOCLAW_WORKSPACE || '/workspace';
}

function log(msg: string): void {
  console.error(`[resolve-attachments] ${msg}`);
}

export interface ResolvedAttachment {
  name: string;
  kind: MediaKind;
  mimeType: string;
  data: Buffer;
}

function parseContent(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function attachmentName(att: Record<string, unknown>): string {
  const name = att.name ?? att.filename;
  if (typeof name === 'string' && name) return path.basename(name);
  return `attachment-${Date.now()}`;
}

/** Refuse paths outside the session inbox mount. */
function resolveInboxPath(localPath: string): string | null {
  if (!localPath || localPath.includes('..')) return null;
  const normalized = localPath.replace(/^\/+/, '');
  if (!normalized.startsWith('inbox/')) return null;
  const abs = path.join(workspaceRoot(), normalized);
  if (!fs.existsSync(abs)) return null;
  try {
    const realWorkspace = fs.realpathSync(workspaceRoot());
    const realFile = fs.realpathSync(abs);
    if (!realFile.startsWith(realWorkspace + path.sep) && realFile !== realWorkspace) {
      return null;
    }
    return realFile;
  } catch {
    return null;
  }
}

async function loadFromAttachment(att: Record<string, unknown>): Promise<ResolvedAttachment | null> {
  const name = attachmentName(att);
  const kind = classifyAttachment(att, name);

  let data: Buffer | null = null;

  if (typeof att.localPath === 'string') {
    const filePath = resolveInboxPath(att.localPath);
    if (filePath && fs.existsSync(filePath)) {
      data = fs.readFileSync(filePath);
    } else {
      log(`Missing or unsafe localPath: ${String(att.localPath)}`);
    }
  } else if (typeof att.data === 'string') {
    try {
      data = Buffer.from(att.data, 'base64');
    } catch {
      log(`Failed to decode base64 attachment ${name}`);
    }
  } else if (typeof att.url === 'string' && att.url) {
    try {
      const res = await fetch(att.url);
      if (!res.ok) {
        log(`Failed to fetch attachment URL (${res.status}): ${name}`);
      } else {
        data = Buffer.from(await res.arrayBuffer());
      }
    } catch (err) {
      log(`Fetch attachment failed: ${name} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!data || data.length === 0) return null;

  const mimeType = mimeForKind(kind, name, typeof att.mimeType === 'string' ? att.mimeType : undefined);
  return { name, kind, mimeType, data };
}

/**
 * Collect and load attachments from a batch of inbound messages.
 * Only image/video kinds are returned for multimodal delivery; callers
 * rely on the text prompt for other file types.
 */
export async function resolveAttachmentsFromMessages(messages: MessageInRow[]): Promise<ResolvedAttachment[]> {
  const results: ResolvedAttachment[] = [];

  for (const msg of messages) {
    if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') continue;
    const content = parseContent(msg.content);
    const attachments = content.attachments;
    if (!Array.isArray(attachments)) continue;

    for (const raw of attachments) {
      if (!raw || typeof raw !== 'object') continue;
      const att = raw as Record<string, unknown>;
      const resolved = await loadFromAttachment(att);
      if (!resolved) continue;
      if (resolved.kind === 'other') continue;
      results.push(resolved);
    }
  }

  return results;
}

/** True when any chat message in the batch declares attachments. */
export function messagesHaveAttachments(messages: MessageInRow[]): boolean {
  for (const msg of messages) {
    if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') continue;
    const content = parseContent(msg.content);
    if (Array.isArray(content.attachments) && content.attachments.length > 0) return true;
  }
  return false;
}
