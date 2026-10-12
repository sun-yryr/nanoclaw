/**
 * SIWC access-token refresh (OpenAI OSS token-sharing).
 * Spec: https://developers.openai.com/siwc/token-sharing-open-source/token-reference
 */
import {
  accessExpiresSoon,
  loadSiwcSession,
  mayRefreshYet,
  saveSiwcSession,
  withSiwcSessionLock,
  type SiwcSession,
} from './session.js';
import {
  CLINE_SIWC_RESOURCE,
  CLINE_SIWC_SHARING_SCOPE,
  CLINE_SIWC_TOKEN_ENDPOINT,
  accessTokenFromSiwcTokens,
  saveSiwcAccessToVault,
  scopesIncludeSharing,
} from './vault.js';

export type SiwcRefreshResult =
  | { status: 'refreshed'; expiresAt: string }
  | { status: 'skipped'; reason: 'fresh' | 'too_early' | 'needs_reauth' | 'no_session' }
  | { status: 'reauth_required'; reason: string }
  | { status: 'error'; reason: string };

const UNUSABLE_REFRESH =
  /invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused/i;

export type RefreshSiwcOptions = {
  root?: string;
  /** Force refresh even when access still looks fresh. */
  force?: boolean;
  fetchImpl?: typeof fetch;
  /** Skip vault write (tests). */
  skipVault?: boolean;
  now?: number;
};

function scopesList(scope: string | undefined): string[] {
  if (!scope) return [];
  return scope.split(/[\s+]+/).filter(Boolean);
}

export async function exchangeRefreshToken(params: {
  clientId: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  access_token: string;
  refresh_token: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  earliest_refresh_at?: number;
}> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: params.clientId,
    refresh_token: params.refreshToken,
    resource: CLINE_SIWC_RESOURCE,
  });
  const res = await fetchImpl(CLINE_SIWC_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SIWC refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as Record<string, unknown>;
  if (typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string') {
    throw new Error('SIWC refresh response missing access_token or refresh_token.');
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    id_token: typeof json.id_token === 'string' ? json.id_token : undefined,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    expires_in: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    earliest_refresh_at: typeof json.earliest_refresh_at === 'number' ? json.earliest_refresh_at : undefined,
  };
}

/**
 * Refresh when access is near expiry (or `force`). Updates session.json and
 * the gateway vault access token. Failure reporting is log-only (caller).
 */
export async function refreshSiwcSessionIfNeeded(options: RefreshSiwcOptions = {}): Promise<SiwcRefreshResult> {
  const root = options.root;
  const now = options.now ?? Date.now();

  return withSiwcSessionLock(
    async () => {
      let session: SiwcSession | null;
      try {
        session = loadSiwcSession(root);
      } catch (err) {
        return {
          status: 'error',
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      if (!session) return { status: 'skipped', reason: 'no_session' };
      if (session.needsReauth) return { status: 'skipped', reason: 'needs_reauth' };
      if (!options.force && !accessExpiresSoon(session, now)) {
        return { status: 'skipped', reason: 'fresh' };
      }
      if (!mayRefreshYet(session, now)) {
        return { status: 'skipped', reason: 'too_early' };
      }

      try {
        const tokens = await exchangeRefreshToken({
          clientId: session.clientId,
          refreshToken: session.refreshToken,
          fetchImpl: options.fetchImpl,
        });
        const scope = tokens.scope ?? session.scopes.join(' ');
        if (!scopesIncludeSharing(scope)) {
          session = {
            ...session,
            needsReauth: true,
            savedAt: new Date().toISOString(),
          };
          saveSiwcSession(session, root);
          return {
            status: 'reauth_required',
            reason: `refresh lost ${CLINE_SIWC_SHARING_SCOPE}`,
          };
        }
        const accessToken = accessTokenFromSiwcTokens({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          id_token: tokens.id_token,
          scope,
        });
        const expiresInSec = tokens.expires_in ?? 3600;
        const expiresAt = new Date(now + expiresInSec * 1000).toISOString();
        const next: SiwcSession = {
          clientId: session.clientId,
          refreshToken: tokens.refresh_token,
          accessToken,
          idToken: tokens.id_token ?? session.idToken,
          expiresAt,
          earliestRefreshAt:
            typeof tokens.earliest_refresh_at === 'number'
              ? new Date(tokens.earliest_refresh_at * 1000).toISOString()
              : undefined,
          scopes: scopesList(scope),
          savedAt: new Date(now).toISOString(),
          needsReauth: false,
        };
        saveSiwcSession(next, root);
        if (!options.skipVault) {
          saveSiwcAccessToVault(accessToken);
        }
        return { status: 'refreshed', expiresAt };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (UNUSABLE_REFRESH.test(message)) {
          saveSiwcSession(
            {
              ...session,
              needsReauth: true,
              savedAt: new Date().toISOString(),
            },
            root,
          );
          return { status: 'reauth_required', reason: message };
        }
        return { status: 'error', reason: message };
      }
    },
    { root },
  );
}

/** Persist a fresh browser-login result into session.json (vault is caller's job). */
export function sessionFromLogin(params: {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  scope: string;
  expiresIn?: number;
  now?: number;
}): SiwcSession {
  const now = params.now ?? Date.now();
  const expiresInSec = params.expiresIn ?? 3600;
  return {
    clientId: params.clientId,
    refreshToken: params.refreshToken,
    accessToken: params.accessToken,
    idToken: params.idToken,
    expiresAt: new Date(now + expiresInSec * 1000).toISOString(),
    scopes: scopesList(params.scope),
    savedAt: new Date(now).toISOString(),
    needsReauth: false,
  };
}
