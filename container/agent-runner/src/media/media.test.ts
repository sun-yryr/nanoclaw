import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildKimiContentParts } from './build-kimi-content.js';
import { classifyAttachment, mimeForKind } from './classify.js';
import { resolveAttachmentsFromMessages } from './resolve-attachments.js';
import type { MessageInRow } from '../db/messages-in.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-media-'));
const workspace = path.join(tmpRoot, 'workspace');

beforeEach(() => {
  process.env.NANOCLAW_WORKSPACE = workspace;
  fs.mkdirSync(path.join(workspace, 'inbox', 'msg-1'), { recursive: true });
});

afterEach(() => {
  delete process.env.NANOCLAW_WORKSPACE;
});

function row(id: string, content: object): MessageInRow {
  return {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    platform_id: 'p1',
    channel_type: 'discord',
    thread_id: null,
    content: JSON.stringify(content),
    seq: 1,
    trigger: 1,
  };
}

describe('classifyAttachment', () => {
  it('classifies jpeg image by mime', () => {
    expect(classifyAttachment({ mimeType: 'image/jpeg' }, 'photo.jpg')).toBe('image');
  });

  it('classifies mp4 video by type', () => {
    expect(classifyAttachment({ type: 'video' }, 'clip.bin')).toBe('video');
  });

  it('classifies unknown as other', () => {
    expect(classifyAttachment({ type: 'document' }, 'report.pdf')).toBe('other');
  });
});

describe('buildKimiContentParts', () => {
  it('builds image_url and text parts', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const parts = await buildKimiContentParts(
      [{ name: 'a.png', kind: 'image', mimeType: 'image/png', data: png }],
      '<message>hi</message>',
    );
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('image_url');
    expect(parts[0].image_url?.url).toStartWith('data:image/png;base64,');
    expect(parts[1]).toEqual({ type: 'text', text: '<message>hi</message>' });
  });

  it('falls back to inline video_url when Files API upload fails for small clips', async () => {
    const data = Buffer.from('fake-video');
    const mockFetch = async () => new Response('not found', { status: 404 });

    const parts = await buildKimiContentParts(
      [{ name: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', data }],
      'check this',
      mockFetch as typeof fetch,
    );
    expect(parts[0].type).toBe('video_url');
    expect(parts[0].video_url?.url).toStartWith('data:video/mp4;base64,');
  });

  it('uploads videos via Files API when available', async () => {
    const data = Buffer.from('fake-video');
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/files') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'file-small' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const parts = await buildKimiContentParts(
      [{ name: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', data }],
      'check this',
      mockFetch as typeof fetch,
    );
    expect(parts[0].video_url?.url).toBe('ms://file-small');
  });

  it('uploads large videos via Files API', async () => {
    const data = Buffer.alloc(11 * 1024 * 1024, 1);
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/files') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'file-abc' }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const parts = await buildKimiContentParts(
      [{ name: 'big.mp4', kind: 'video', mimeType: 'video/mp4', data }],
      'big clip',
      mockFetch as typeof fetch,
    );
    expect(parts[0].video_url?.url).toBe('ms://file-abc');
  });

  it('omits video when upload fails and clip exceeds inline fallback limit', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024, 1);
    const mockFetch = async () => new Response('not found', { status: 404 });

    const parts = await buildKimiContentParts(
      [{ name: 'big.mp4', kind: 'video', mimeType: 'video/mp4', data }],
      'describe',
      mockFetch as typeof fetch,
    );
    expect(parts.some((p) => p.type === 'video_url')).toBe(false);
    expect(parts.some((p) => p.type === 'text')).toBe(true);
  });
});

describe('resolveAttachmentsFromMessages', () => {
  it('reads image bytes from inbox localPath', async () => {
    const filePath = path.join(workspace, 'inbox', 'msg-1', 'photo.png');
    fs.writeFileSync(filePath, 'PNGDATA');

    const resolved = await resolveAttachmentsFromMessages([
      row('msg-1', {
        text: 'pic',
        attachments: [{ name: 'photo.png', type: 'image', localPath: 'inbox/msg-1/photo.png' }],
      }),
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].kind).toBe('image');
    expect(resolved[0].data.toString()).toBe('PNGDATA');
    expect(mimeForKind(resolved[0].kind, resolved[0].name, resolved[0].mimeType)).toBe('image/png');
  });

  it('skips non-media attachments', async () => {
    const filePath = path.join(workspace, 'inbox', 'msg-1', 'doc.pdf');
    fs.writeFileSync(filePath, 'PDF');

    const resolved = await resolveAttachmentsFromMessages([
      row('msg-1', {
        text: 'doc',
        attachments: [{ name: 'doc.pdf', type: 'document', localPath: 'inbox/msg-1/doc.pdf' }],
      }),
    ]);

    expect(resolved).toHaveLength(0);
  });
});
