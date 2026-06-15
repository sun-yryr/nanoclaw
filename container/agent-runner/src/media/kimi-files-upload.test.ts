import { afterEach, describe, expect, it } from 'bun:test';

import { resolveKimiFilesBaseUrl } from './kimi-files-upload.js';

describe('resolveKimiFilesBaseUrl', () => {
  afterEach(() => {
    delete process.env.MOONSHOT_API_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it('uses Moonshot directly when chat base is OpenCode Go', () => {
    expect(resolveKimiFilesBaseUrl('https://opencode.ai/zen/go/v1')).toBe('https://api.moonshot.ai/v1');
  });

  it('respects MOONSHOT_API_BASE_URL override', () => {
    process.env.MOONSHOT_API_BASE_URL = 'https://api.moonshot.cn/v1';
    expect(resolveKimiFilesBaseUrl('https://opencode.ai/zen/go/v1')).toBe('https://api.moonshot.cn/v1');
  });

  it('uses chat base when it is already Moonshot', () => {
    expect(resolveKimiFilesBaseUrl('https://api.moonshot.ai/v1')).toBe('https://api.moonshot.ai/v1');
  });
});
