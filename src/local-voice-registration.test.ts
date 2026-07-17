import { describe, expect, it } from 'vitest';

import './channels/index.js';
import { getRegisteredChannelNames } from './channels/channel-registry.js';

describe('local voice channel registration', () => {
  it('is reachable through the real channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('local-voice');
  });
});
