import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  isLegacyInlineContinuation,
  isOpaqueSessionId,
  loadSessionSnapshot,
  maybeRotateClineContinuation,
  saveSessionSnapshot,
  sessionTranscriptPath,
} from './cline-sessions.js';

describe('cline-sessions', () => {
  let tmpHome: string;
  let prevConfigDir: string | undefined;
  let prevRotateBytes: string | undefined;
  let prevRotateAge: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-sessions-'));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    prevRotateBytes = process.env.CLINE_TRANSCRIPT_ROTATE_BYTES;
    prevRotateAge = process.env.CLINE_TRANSCRIPT_ROTATE_AGE_DAYS;
    process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude');
    delete process.env.CLINE_TRANSCRIPT_ROTATE_BYTES;
    delete process.env.CLINE_TRANSCRIPT_ROTATE_AGE_DAYS;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    if (prevRotateBytes === undefined) delete process.env.CLINE_TRANSCRIPT_ROTATE_BYTES;
    else process.env.CLINE_TRANSCRIPT_ROTATE_BYTES = prevRotateBytes;
    if (prevRotateAge === undefined) delete process.env.CLINE_TRANSCRIPT_ROTATE_AGE_DAYS;
    else process.env.CLINE_TRANSCRIPT_ROTATE_AGE_DAYS = prevRotateAge;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('accepts UUIDs and rejects legacy inline JSON', () => {
    expect(isOpaqueSessionId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
    expect(isOpaqueSessionId('{"messages":[]}')).toBe(false);
    expect(isLegacyInlineContinuation('{"agentId":"x","messages":[]}')).toBe(true);
    expect(isLegacyInlineContinuation('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(false);
  });

  it('round-trips a snapshot to disk', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const snapshot = {
      agentId: 'agent_test',
      status: 'idle',
      iteration: 0,
      messages: [{ role: 'user', content: 'hi' }],
      pendingToolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };

    saveSessionSnapshot(id, snapshot as never);
    expect(fs.existsSync(sessionTranscriptPath(id))).toBe(true);

    const loaded = loadSessionSnapshot(id);
    expect(loaded?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('rotates legacy inline continuations', () => {
    expect(maybeRotateClineContinuation('{"messages":[]}')).toBe(
      'legacy inline snapshot in session_state',
    );
  });

  it('rotates missing transcript files', () => {
    expect(maybeRotateClineContinuation('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(
      'missing transcript file',
    );
  });

  it('rotates oversized transcripts and moves the file aside', () => {
    process.env.CLINE_TRANSCRIPT_ROTATE_BYTES = '100';
    const id = '99999999-8888-7777-6666-555555555555';
    saveSessionSnapshot(id, {
      agentId: 'a',
      status: 'idle',
      iteration: 0,
      messages: [{ role: 'user', content: 'x'.repeat(200) }],
      pendingToolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as never);

    const reason = maybeRotateClineContinuation(id);
    expect(reason).toMatch(/MB >/);
    expect(fs.existsSync(sessionTranscriptPath(id))).toBe(false);
    const rotated = fs.readdirSync(path.join(tmpHome, '.claude', 'cline-sessions'));
    expect(rotated.some((n) => n.startsWith(`${id}.json.rotated-`))).toBe(true);
  });

  it('keeps a fresh small transcript', () => {
    const id = '12345678-1234-1234-1234-1234567890ab';
    saveSessionSnapshot(id, {
      agentId: 'a',
      status: 'idle',
      iteration: 0,
      messages: [{ role: 'user', content: 'hi' }],
      pendingToolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as never);

    expect(maybeRotateClineContinuation(id)).toBeNull();
    expect(loadSessionSnapshot(id)?.messages).toHaveLength(1);
  });
});
