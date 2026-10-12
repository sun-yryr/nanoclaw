import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { refreshSiwcSessionIfNeeded, sessionFromLogin } from './refresh.js';
import { loadSiwcSession, saveSiwcSession } from './session.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siwc-refresh-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data', 'siwc'), { recursive: true, mode: 0o700 });
  return root;
}

it('sessionFromLogin writes a one-hour expiry by default', () => {
  const now = Date.parse('2026-10-13T00:00:00.000Z');
  const session = sessionFromLogin({
    clientId: 'cid',
    accessToken: 'at',
    refreshToken: 'rt',
    scope: 'openid chatgpt.tokens.use.direct offline_access',
    now,
  });
  expect(session.expiresAt).toBe('2026-10-13T01:00:00.000Z');
  expect(session.scopes).toContain('chatgpt.tokens.use.direct');
});

it('skips refresh when access is still fresh', async () => {
  const root = tempRoot();
  const now = Date.parse('2026-10-13T00:00:00.000Z');
  saveSiwcSession(
    sessionFromLogin({
      clientId: 'cid',
      accessToken: 'at',
      refreshToken: 'rt',
      scope: 'openid chatgpt.tokens.use.direct',
      expiresIn: 3600,
      now,
    }),
    root,
  );
  const fetchImpl = vi.fn();
  const result = await refreshSiwcSessionIfNeeded({
    root,
    now: now + 60_000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    skipVault: true,
  });
  expect(result).toEqual({ status: 'skipped', reason: 'fresh' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('refreshes near expiry and rotates the refresh token', async () => {
  const root = tempRoot();
  const now = Date.parse('2026-10-13T00:00:00.000Z');
  saveSiwcSession(
    sessionFromLogin({
      clientId: 'cid',
      accessToken: 'old-at',
      refreshToken: 'old-rt',
      scope: 'openid chatgpt.tokens.use.direct offline_access',
      expiresIn: 3600,
      now,
    }),
    root,
  );

  const fetchImpl = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        access_token: 'new-at',
        refresh_token: 'new-rt',
        scope: 'openid chatgpt.tokens.use.direct offline_access',
        expires_in: 3600,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  const nearExpiry = now + 56 * 60_000; // 4 min left (< 5 min skew)
  const result = await refreshSiwcSessionIfNeeded({
    root,
    now: nearExpiry,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    skipVault: true,
  });
  expect(result).toEqual({
    status: 'refreshed',
    expiresAt: new Date(nearExpiry + 3600_000).toISOString(),
  });
  const saved = loadSiwcSession(root)!;
  expect(saved.accessToken).toBe('new-at');
  expect(saved.refreshToken).toBe('new-rt');
  expect(fetchImpl).toHaveBeenCalledOnce();
  const call = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
  const body = String(call[1]?.body ?? '');
  expect(body).toContain('grant_type=refresh_token');
  expect(body).toContain('refresh_token=old-rt');
  expect(body).toContain('client_id=cid');
});

it('marks needsReauth on unusable refresh token', async () => {
  const root = tempRoot();
  const now = Date.parse('2026-10-13T00:00:00.000Z');
  saveSiwcSession(
    {
      ...sessionFromLogin({
        clientId: 'cid',
        accessToken: 'at',
        refreshToken: 'dead-rt',
        scope: 'openid chatgpt.tokens.use.direct',
        expiresIn: 60,
        now,
      }),
    },
    root,
  );

  const fetchImpl = vi.fn(async () => {
    return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh_token_expired' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  });

  const result = await refreshSiwcSessionIfNeeded({
    root,
    force: true,
    now,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    skipVault: true,
  });
  expect(result.status).toBe('reauth_required');
  expect(loadSiwcSession(root)?.needsReauth).toBe(true);
});
