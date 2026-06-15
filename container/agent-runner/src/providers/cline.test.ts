import { describe, expect, it } from 'bun:test';

import { toClineUserContent } from './cline.js';
import type { UserContentPart } from './types.js';

describe('toClineUserContent', () => {
  it('converts image_url data URLs to Cline image parts', () => {
    const input: UserContentPart[] = [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc123' } },
      { type: 'text', text: 'describe this' },
    ];

    expect(toClineUserContent(input)).toEqual([
      { type: 'image', mediaType: 'image/jpeg', image: 'abc123' },
      { type: 'text', text: 'describe this' },
    ]);
  });

  it('drops unsupported http image_url parts', () => {
    const input: UserContentPart[] = [
      { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.jpg' } },
      { type: 'text', text: 'hello' },
    ];

    expect(toClineUserContent(input)).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('maps video_url to a text placeholder', () => {
    const input: UserContentPart[] = [
      { type: 'video_url', video_url: { url: 'https://files.example.com/v.mp4' } },
    ];

    expect(toClineUserContent(input)).toEqual([
      { type: 'text', text: '[User attached a video: https://files.example.com/v.mp4]' },
    ]);
  });
});
