/**
 * Single-host lock — prevents two NanoClaw host processes from running in
 * parallel. Without this, each process runs its own delivery poll loop and
 * they race on the same session outbound rows: both read a message as
 * undelivered, both call the channel adapter, and the user sees duplicates
 * even though markDelivered is idempotent in the DB.
 *
 * Uses an exclusive create (O_EXCL) on data/host.lock. Stale locks left by
 * a crash are reclaimed when the recorded pid is no longer alive.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

const LOCK_BASENAME = 'host.lock';

export class HostLockError extends Error {
  constructor(
    message: string,
    readonly existingPid: number,
  ) {
    super(message);
    this.name = 'HostLockError';
  }
}

export function hostLockPath(): string {
  return path.join(DATA_DIR, LOCK_BASENAME);
}

/** True when `pid` refers to a live process (or exists but is not signalable). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM — process exists, we just can't signal it.
    return e.code === 'EPERM';
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const line = fs.readFileSync(lockPath, 'utf8').split('\n')[0]?.trim();
    const pid = Number(line);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function writeLock(lockPath: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeFileSync(fd, `${process.pid}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function removeStaleLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  }
}

/**
 * Acquire the host lock for this process. Throws HostLockError when another
 * live host already holds it.
 */
export function acquireHostLock(): void {
  const lockPath = hostLockPath();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeLock(lockPath);
      return;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw err;

      const existingPid = readLockPid(lockPath);
      if (existingPid !== null && isProcessAlive(existingPid)) {
        throw new HostLockError(
          `Another NanoClaw host is already running (pid ${existingPid}). ` +
            'Stop the other instance before starting a new one — parallel hosts duplicate outbound delivery.',
          existingPid,
        );
      }

      removeStaleLock(lockPath);
    }
  }

  throw new Error('Failed to acquire host lock after reclaiming a stale lock file');
}

/** Release the lock on graceful shutdown. Best-effort on crash — stale pid reclaim handles that. */
export function releaseHostLock(): void {
  const lockPath = hostLockPath();
  try {
    if (!fs.existsSync(lockPath)) return;
    const owner = readLockPid(lockPath);
    if (owner !== null && owner !== process.pid) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Best-effort — a stale lock is reclaimed on the next startup.
  }
}
