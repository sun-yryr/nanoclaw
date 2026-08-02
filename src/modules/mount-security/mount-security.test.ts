/**
 * Regression tests for mount-security — verify that undefined/null/empty
 * hostPath values in additional mounts are handled gracefully (WARN log,
 * skip entry, no TypeError crash).
 *
 * The pre-fix behaviour was that `expandPath(p: string)` called
 * `p.startsWith('~/')` without a guard, crashing with:
 *   TypeError: Cannot read properties of undefined (reading 'startsWith')
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Must be a string literal inside the factory due to vi.mock hoisting.
const ALLOWLIST_PATH = path.join(os.tmpdir(), 'nanoclaw-test-mount-security-allowlist.json');

// mock before any import that pulls in config
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, MOUNT_ALLOWLIST_PATH: ALLOWLIST_PATH };
});

import type { AdditionalMount } from './index.js';
import { validateAdditionalMounts } from './index.js';

function writeAllowlist(content: unknown) {
  const dir = path.dirname(ALLOWLIST_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(content, null, 2));
}

function removeAllowlist() {
  try {
    fs.unlinkSync(ALLOWLIST_PATH);
  } catch {
    // ignore
  }
}

describe('validateAdditionalMounts with bad hostPath entries', () => {
  beforeEach(() => {
    vi.resetModules();
    writeAllowlist({
      allowedRoots: [{ path: os.tmpdir(), allowReadWrite: true, description: 'temp' }],
      blockedPatterns: [],
    });
  });

  afterEach(() => {
    removeAllowlist();
  });

  it('skips entries with undefined hostPath without throwing TypeError', async () => {
    const mod = await import('./index.js');
    const validMount: AdditionalMount = { hostPath: os.tmpdir(), containerPath: 'test-dir' };

    const result = mod.validateAdditionalMounts(
      [
        { hostPath: undefined as unknown as string },
        validMount,
        { hostPath: null as unknown as string },
        { hostPath: '' },
      ],
      'test-group',
    );

    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe('/workspace/extra/test-dir');
  });

  it('safely handles null/undefined non-object entries', async () => {
    const mod = await import('./index.js');
    const result = mod.validateAdditionalMounts(
      [null as unknown as AdditionalMount, undefined as unknown as AdditionalMount],
      'test-group',
    );
    expect(result).toHaveLength(0);
  });

  it('safely handles entries with non-string hostPath', async () => {
    const mod = await import('./index.js');
    const result = mod.validateAdditionalMounts([{ hostPath: 42 as unknown as string }], 'test-group');
    expect(result).toHaveLength(0);
  });

  it('returns empty array when all entries are invalid', async () => {
    const mod = await import('./index.js');
    const result = mod.validateAdditionalMounts(
      [{ hostPath: undefined as unknown as string }, { hostPath: '' }, { hostPath: '/nonexistent/path/xyz' }],
      'test-group',
    );
    expect(result).toHaveLength(0);
  });

  it('returns empty array for an empty mounts list', async () => {
    const mod = await import('./index.js');
    const result = mod.validateAdditionalMounts([], 'test-group');
    expect(result).toHaveLength(0);
  });
});
