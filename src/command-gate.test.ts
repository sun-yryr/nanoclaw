import { afterEach, describe, expect, it } from 'vitest';

import { gateCommand, isDiscordVoiceCommand } from './command-gate.js';

describe('command gate', () => {
  afterEach(() => {
    delete process.env.DISCORD_VOICE_COMMAND_PREFIX;
  });

  it('filters Discord voice commands before they reach the agent', () => {
    process.env.DISCORD_VOICE_COMMAND_PREFIX = '!nc voice';

    expect(gateCommand(JSON.stringify({ text: '!nc voice join' }), 'discord:u1', 'ag-1')).toEqual({
      action: 'filter',
    });
    expect(gateCommand(JSON.stringify({ text: '!nc voice leave' }), 'discord:u1', 'ag-1')).toEqual({
      action: 'filter',
    });
    expect(gateCommand(JSON.stringify({ text: '!nc voice status' }), 'discord:u1', 'ag-1')).toEqual({
      action: 'filter',
    });
  });

  it('filters custom Discord voice command prefixes', () => {
    process.env.DISCORD_VOICE_COMMAND_PREFIX = '!voice';

    expect(gateCommand(JSON.stringify({ text: '!voice join' }), 'discord:u1', 'ag-1')).toEqual({
      action: 'filter',
    });
    expect(gateCommand(JSON.stringify({ text: '!nc voice join' }), 'discord:u1', 'ag-1')).toEqual({
      action: 'pass',
    });
  });

  it('requires a prefix boundary', () => {
    expect(isDiscordVoiceCommand('!nc voice join', '!nc voice')).toBe(true);
    expect(isDiscordVoiceCommand('!nc voice', '!nc voice')).toBe(true);
    expect(isDiscordVoiceCommand('!nc voiceover join', '!nc voice')).toBe(false);
  });

  it('keeps normal messages and unknown slash commands passing through', () => {
    process.env.DISCORD_VOICE_COMMAND_PREFIX = '!nc voice';

    expect(gateCommand(JSON.stringify({ text: 'hello' }), 'discord:u1', 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand(JSON.stringify({ text: '/unknown' }), 'discord:u1', 'ag-1')).toEqual({ action: 'pass' });
  });
});
