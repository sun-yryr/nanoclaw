import { describe, expect, it } from 'vitest';

import { formatTranscriptChannelMessage, isVoiceTranscriptChannelMessage } from './index.js';

describe('discord voice transcript posts', () => {
  it('formats a speaker-attributed transcript line', () => {
    const message = formatTranscriptChannelMessage('sun-yryr', 'こんにちは');
    expect(message).toContain('🎤 **sun-yryr**: こんにちは');
    expect(isVoiceTranscriptChannelMessage(message)).toBe(true);
  });

  it('does not treat normal bot replies as transcript posts', () => {
    expect(isVoiceTranscriptChannelMessage('はい、日本語で話せますよ！')).toBe(false);
  });
});
