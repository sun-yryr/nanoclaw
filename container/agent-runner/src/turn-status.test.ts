import { describe, expect, it } from 'bun:test';

import {
  createTurnStatusPoster,
  formatToolStatusLine,
  shouldSkipToolStatus,
  summarizeToolInput,
} from './turn-status.js';

describe('turn-status formatting', () => {
  it('skips messaging / ask tools including MCP-prefixed names', () => {
    expect(shouldSkipToolStatus('send_message')).toBe(true);
    expect(shouldSkipToolStatus('mcp__nanoclaw__send_message')).toBe(true);
    expect(shouldSkipToolStatus('mcp__nanoclaw__edit_message')).toBe(true);
    expect(shouldSkipToolStatus('ask_question')).toBe(true);
    expect(shouldSkipToolStatus('spawn_agent')).toBe(false);
    expect(shouldSkipToolStatus('mcp__brave-search__brave_web_search')).toBe(false);
  });

  it('summarizes spawn_agent task text', () => {
    expect(
      summarizeToolInput('spawn_agent', {
        systemPrompt: 'researcher',
        task: 'Look up the weather in Tokyo and summarize',
      }),
    ).toBe('Look up the weather in Tokyo and summarize');
  });

  it('formats start/end lines and skips send_message', () => {
    expect(formatToolStatusLine('start', 'send_message', { text: 'hi' })).toBeNull();
    expect(
      formatToolStatusLine('start', 'mcp__nanoclaw__send_message', {
        to: 'health',
        text: '動画確認した',
      }),
    ).toBeNull();
    expect(formatToolStatusLine('start', 'spawn_agent', { task: 'fetch docs' })).toBe(
      '→ spawn_agent — fetch docs',
    );
    expect(formatToolStatusLine('end', 'bash', { command: 'ls -la' })).toBe('✓ bash — ls -la');
  });
});

describe('createTurnStatusPoster', () => {
  it('writes turn_status rows and finishes with Done', async () => {
    const writes: Array<{ kind: string; content: string }> = [];
    const poster = createTurnStatusPoster(
      {
        platformId: 'discord:g:c',
        channelType: 'discord',
        threadId: null,
        inReplyTo: 'in-1',
        taskRun: false,
      },
      async (row) => {
        writes.push({ kind: row.kind, content: row.content });
      },
    );
    expect(poster).not.toBeNull();
    await poster!.update('Working…');
    await poster!.update('→ spawn_agent — research');
    await poster!.finish();

    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes.every((w) => w.kind === 'turn_status')).toBe(true);
    const last = JSON.parse(writes[writes.length - 1].content);
    expect(last.done).toBe(true);
    expect(last.text).toContain('spawn_agent');
    expect(last.text).toContain('Done');
  });

  it('returns null for task runs', () => {
    expect(
      createTurnStatusPoster({
        platformId: 'discord:g:c',
        channelType: 'discord',
        threadId: null,
        taskRun: true,
      }),
    ).toBeNull();
  });
});
