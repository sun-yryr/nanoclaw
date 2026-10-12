/**
 * Host-side SIWC refresh loop. Log-only on failure; Discord notices come from
 * the agent when a turn still hits 401.
 */
import fs from 'node:fs';

import { log } from '../../log.js';
import { refreshSiwcSessionIfNeeded } from './refresh.js';
import { loadSiwcSession, resolveSiwcSessionPath } from './session.js';

/** How often to check expiry. Refresh itself runs only near expiry. */
export const SIWC_REFRESH_CHECK_MS = 60_000;

export type SiwcRefreshLoopHandle = { stop: () => void };

function shouldRunSiwcRefreshLoop(root?: string): boolean {
  if (process.env.CLINE_AUTH_MODE?.trim().toLowerCase() === 'siwc') return true;
  return fs.existsSync(resolveSiwcSessionPath(root));
}

function logRefreshResult(result: Awaited<ReturnType<typeof refreshSiwcSessionIfNeeded>>): void {
  switch (result.status) {
    case 'refreshed':
      log.info('SIWC access token refreshed', { expiresAt: result.expiresAt });
      break;
    case 'skipped':
      if (result.reason === 'needs_reauth') {
        log.warn('SIWC session needs browser re-login (needsReauth)', {
          hint: 'pnpm exec tsx .claude/skills/add-cline-siwc-auth/scripts/run-cline-siwc-auth.ts',
        });
      }
      break;
    case 'reauth_required':
      log.warn('SIWC refresh requires browser re-login', {
        reason: result.reason,
        hint: 'pnpm exec tsx .claude/skills/add-cline-siwc-auth/scripts/run-cline-siwc-auth.ts',
      });
      break;
    case 'error':
      log.error('SIWC refresh failed', { reason: result.reason });
      break;
  }
}

/**
 * Start periodic SIWC refresh when a session file exists or CLINE_AUTH_MODE=siwc.
 * No-ops (with an optional warn) when there is nothing to refresh.
 */
export function startSiwcRefreshLoop(options?: {
  root?: string;
  signal?: AbortSignal;
  checkMs?: number;
}): SiwcRefreshLoopHandle {
  const root = options?.root;
  const checkMs = options?.checkMs ?? SIWC_REFRESH_CHECK_MS;

  if (!shouldRunSiwcRefreshLoop(root)) {
    return { stop: () => {} };
  }

  let session: ReturnType<typeof loadSiwcSession> = null;
  try {
    session = loadSiwcSession(root);
  } catch (err) {
    log.error('SIWC session file unreadable; refresh loop not started', { err });
    return { stop: () => {} };
  }

  if (!session) {
    log.warn('CLINE_AUTH_MODE=siwc but data/siwc/session.json is missing; run SIWC login once', {
      hint: 'pnpm exec tsx .claude/skills/add-cline-siwc-auth/scripts/run-cline-siwc-auth.ts',
    });
    return { stop: () => {} };
  }

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | null = null;

  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = refreshSiwcSessionIfNeeded({ root })
      .then(logRefreshResult)
      .catch((err) => {
        log.error('SIWC refresh tick threw', { err });
      })
      .finally(() => {
        inFlight = null;
      });
  };

  log.info('SIWC refresh loop started', {
    expiresAt: session.expiresAt,
    needsReauth: session.needsReauth === true,
    checkMs,
  });
  tick();
  timer = setInterval(tick, checkMs);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    log.info('SIWC refresh loop stopped');
  };

  options?.signal?.addEventListener('abort', stop, { once: true });
  return { stop };
}
