import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadAttachmentBase64 } from './attachment-download.js';

describe('downloadAttachmentBase64', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses fetchData when present', async () => {
    const data = await downloadAttachmentBase64({
      type: 'image',
      fetchData: async () => Buffer.from('PNG'),
    });
    expect(data).toBe(Buffer.from('PNG').toString('base64'));
  });

  it('falls back to url fetch when fetchData is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Buffer.from('JPEG'), { status: 200 })),
    );

    const data = await downloadAttachmentBase64({
      type: 'image',
      url: 'https://cdn.discordapp.com/attachments/1/2/photo.jpg',
    });
    expect(data).toBe(Buffer.from('JPEG').toString('base64'));
  });

  it('returns undefined when download fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const data = await downloadAttachmentBase64({
      type: 'image',
      url: 'https://example.com/missing.jpg',
    });
    expect(data).toBeUndefined();
  });
});
