import { describe, expect, it } from 'vitest';

import { decideVoiceResponse, hasExplicitResponseRequest, normalizeProbability } from './decision.js';

describe('discord voice response decision', () => {
  it('clamps invalid probability values', () => {
    expect(normalizeProbability(-1)).toBe(0);
    expect(normalizeProbability(2)).toBe(1);
    expect(normalizeProbability(Number.NaN)).toBe(0);
    expect(normalizeProbability(0.25)).toBe(0.25);
  });

  it('detects explicit English and Japanese response requests', () => {
    expect(hasExplicitResponseRequest('NanoClaw, what do you think?', ['NanoClaw'])).toBe(true);
    expect(hasExplicitResponseRequest('これについてどう思う？')).toBe(true);
    expect(hasExplicitResponseRequest('ちょっと教えて')).toBe(true);
    expect(hasExplicitResponseRequest('yeah that sounds good')).toBe(false);
  });

  it('responds immediately to explicit requests', async () => {
    const decision = await decideVoiceResponse({
      transcript: 'assistant, can you explain that?',
      probability: 0,
      random: () => 1,
    });
    expect(decision).toMatchObject({ respond: true, reason: 'explicit' });
  });

  it('uses the AI judge before the probability fallback', async () => {
    const decision = await decideVoiceResponse({
      transcript: 'there is a tricky production error in the logs',
      probability: 0,
      random: () => 1,
      aiJudge: async () => ({ respond: true, reason: 'technical help useful' }),
    });
    expect(decision).toMatchObject({ respond: true, reason: 'ai_judge' });
  });

  it('falls back to probability when judge declines', async () => {
    const decision = await decideVoiceResponse({
      transcript: 'casual background chatter',
      probability: 0.5,
      random: () => 0.25,
      aiJudge: async () => ({ respond: false }),
    });
    expect(decision).toMatchObject({ respond: true, reason: 'probability' });
  });

  it('declines when probability misses', async () => {
    const decision = await decideVoiceResponse({
      transcript: 'casual background chatter',
      probability: 0.5,
      random: () => 0.75,
    });
    expect(decision).toMatchObject({ respond: false, reason: 'probability_miss' });
  });
});
