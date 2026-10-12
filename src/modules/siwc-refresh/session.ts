/**
 * Local SIWC session file — refresh_token stays on the host (OpenAI SIWC terms:
 * persistent tokens must be local / under the user). The gateway vault holds
 * only the current access_token for Bearer injection.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';

export const SIWC_SESSION_RELATIVE = path.join('siwc', 'session.json');
export const SIWC_SESSION_LOCK_RELATIVE = path.join('siwc', 'session.lock');

export type SiwcSession = {
  clientId: string;
  refreshToken: string;
  accessToken: string;
  idToken?: string;
  /** ISO-8601 UTC when access_token expires. */
  expiresAt: string;
  /** ISO-8601 UTC; do not refresh before this when present. */
  earliestRefreshAt?: string;
  scopes: string[];
  savedAt: string;
  /** Set when refresh failed permanently; clear on successful browser login. */
  needsReauth?: boolean;
};

export function resolveSiwcSessionPath(root?: string): string {
  const base = root ? path.join(root, 'data') : DATA_DIR;
  return path.join(base, SIWC_SESSION_RELATIVE);
}

export function resolveSiwcSessionLockPath(root?: string): string {
  const base = root ? path.join(root, 'data') : DATA_DIR;
  return path.join(base, SIWC_SESSION_LOCK_RELATIVE);
}

export function loadSiwcSession(root?: string): SiwcSession | null {
  const file = resolveSiwcSessionPath(root);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SiwcSession>;
  if (
    typeof raw.clientId !== 'string' ||
    !raw.clientId ||
    typeof raw.refreshToken !== 'string' ||
    !raw.refreshToken ||
    typeof raw.accessToken !== 'string' ||
    !raw.accessToken ||
    typeof raw.expiresAt !== 'string' ||
    !raw.expiresAt ||
    typeof raw.savedAt !== 'string' ||
    !raw.savedAt ||
    !Array.isArray(raw.scopes)
  ) {
    throw new Error(`Invalid SIWC session at ${file}`);
  }
  return {
    clientId: raw.clientId,
    refreshToken: raw.refreshToken,
    accessToken: raw.accessToken,
    idToken: typeof raw.idToken === 'string' ? raw.idToken : undefined,
    expiresAt: raw.expiresAt,
    earliestRefreshAt: typeof raw.earliestRefreshAt === 'string' ? raw.earliestRefreshAt : undefined,
    scopes: raw.scopes.filter((s): s is string => typeof s === 'string'),
    savedAt: raw.savedAt,
    needsReauth: raw.needsReauth === true,
  };
}

export function saveSiwcSession(session: SiwcSession, root?: string): void {
  const file = resolveSiwcSessionPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearSiwcSession(root?: string): void {
  const file = resolveSiwcSessionPath(root);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/**
 * Exclusive lock around session read-modify-write (rotating refresh tokens
 * must not race). Stale locks older than `staleMs` are stolen.
 */
export async function withSiwcSessionLock<T>(
  fn: () => Promise<T>,
  options?: { root?: string; staleMs?: number; waitMs?: number },
): Promise<T> {
  const lockPath = resolveSiwcSessionLockPath(options?.root);
  const staleMs = options?.staleMs ?? 60_000;
  const waitMs = options?.waitMs ?? 30_000;
  const deadline = Date.now() + waitMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      if (code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // raced with another unlock
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for SIWC session lock at ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

export function accessExpiresSoon(session: SiwcSession, now = Date.now(), skewMs = 5 * 60_000): boolean {
  const exp = Date.parse(session.expiresAt);
  if (!Number.isFinite(exp)) return true;
  return exp - now <= skewMs;
}

export function mayRefreshYet(session: SiwcSession, now = Date.now()): boolean {
  if (!session.earliestRefreshAt) return true;
  const earliest = Date.parse(session.earliestRefreshAt);
  if (!Number.isFinite(earliest)) return true;
  return now >= earliest;
}
