import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-lock' };
});

const TEST_DIR = '/tmp/nanoclaw-test-host-lock';

import { acquireHostLock, releaseHostLock, hostLockPath, isProcessAlive, HostLockError } from './host-lock.js';

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
afterEach(() => {
  releaseHostLock();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('host-lock', () => {
  it('hostLockPath points at data/host.lock', () => {
    expect(hostLockPath()).toBe(path.join(TEST_DIR, 'host.lock'));
  });

  it('isProcessAlive returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive returns false for a pid that does not exist', () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
  });

  it('acquire creates the lock file with this pid', () => {
    acquireHostLock();
    expect(fs.readFileSync(hostLockPath(), 'utf8').trim()).toBe(String(process.pid));
  });

  it('second acquire throws HostLockError while the first lock is held', () => {
    acquireHostLock();
    expect(() => acquireHostLock()).toThrow(HostLockError);
    try {
      acquireHostLock();
    } catch (err) {
      expect(err).toBeInstanceOf(HostLockError);
      expect((err as HostLockError).existingPid).toBe(process.pid);
    }
  });

  it('release allows a subsequent acquire', () => {
    acquireHostLock();
    releaseHostLock();
    expect(() => acquireHostLock()).not.toThrow();
  });

  it('reclaims a stale lock when the recorded pid is dead', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(hostLockPath(), '999999999\n');
    expect(() => acquireHostLock()).not.toThrow();
    expect(fs.readFileSync(hostLockPath(), 'utf8').trim()).toBe(String(process.pid));
  });
});
