import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { unwrapIdenticalDiscordLinks } from './discord-links.js';

describe('unwrapIdenticalDiscordLinks', () => {
  it('unwraps [url](url) to a bare URL', () => {
    expect(unwrapIdenticalDiscordLinks('[https://example.com](https://example.com)')).toBe('https://example.com');
  });

  it('unwraps identical links that include a path', () => {
    expect(unwrapIdenticalDiscordLinks('[https://example.com/foo](https://example.com/foo)')).toBe(
      'https://example.com/foo',
    );
  });

  it('unwraps multiple identical links in surrounding prose', () => {
    const input = 'see [https://a.example/x](https://a.example/x) and [https://b.example](https://b.example)';
    expect(unwrapIdenticalDiscordLinks(input)).toBe('see https://a.example/x and https://b.example');
  });

  it('treats trailing-slash and <> wrapping as the same URL', () => {
    expect(unwrapIdenticalDiscordLinks('[https://example.com](https://example.com/)')).toBe('https://example.com/');
    expect(unwrapIdenticalDiscordLinks('[<https://example.com>](https://example.com)')).toBe('https://example.com');
    expect(unwrapIdenticalDiscordLinks('[https://example.com](<https://example.com>)')).toBe('https://example.com');
  });

  it('preserves named markdown links whose label is not the URL', () => {
    const named = '[View the build](https://example.com/builds/123)';
    expect(unwrapIdenticalDiscordLinks(named)).toBe(named);
  });

  it('preserves [url](other-url) when the two differ', () => {
    const mixed = '[https://a.example](https://b.example)';
    expect(unwrapIdenticalDiscordLinks(mixed)).toBe(mixed);
  });

  it('leaves identical links inside fenced code blocks', () => {
    const fenced = '```\n[https://example.com](https://example.com)\n```';
    expect(unwrapIdenticalDiscordLinks(fenced)).toBe(fenced);
  });

  it('leaves identical links inside inline code', () => {
    const inline = 'use `[https://example.com](https://example.com)` as an example';
    expect(unwrapIdenticalDiscordLinks(inline)).toBe(inline);
  });

  it('unwraps prose around a fenced block without touching the fence', () => {
    const input =
      '[https://a.example](https://a.example)\n```\n[https://b.example](https://b.example)\n```\n[https://c.example](https://c.example)';
    expect(unwrapIdenticalDiscordLinks(input)).toBe(
      'https://a.example\n```\n[https://b.example](https://b.example)\n```\nhttps://c.example',
    );
  });
});

describe('discord adapter wiring', () => {
  it('passes unwrapIdenticalDiscordLinks as transformOutboundText', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'discord.ts'), 'utf8');
    expect(src).toMatch(/transformOutboundText:\s*unwrapIdenticalDiscordLinks/);
  });
});
