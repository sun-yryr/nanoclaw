/**
 * Caller-described gateway target for Cline + Sign in with ChatGPT (SIWC).
 *
 * Live probe (2026-10-12): Bearer-only to api.openai.com succeeds; adding
 * ChatGPT-Account-Id (OIDC sub or otherwise) returns 400 invalid_request.
 * SIWC JWTs omit chatgpt_account_id. Therefore we store a **generic**
 * Authorization Bearer secret — not OneCLI/Iron's chatgpt OAuth profile
 * (which injects Account-Id).
 *
 * See ../references/phase1-design.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  GatewayCredentialConnection,
  GatewayCredentialTarget,
  ProviderCredentialStore,
} from '../../../../setup/gateways/credential-store.js';

export const CLINE_SIWC_CONNECTION_NAME = 'Cline SIWC';
export const CLINE_SIWC_HOST = 'api.openai.com';
export const CLINE_SIWC_PROXY_VALUE = 'nc-cline-siwc-v1';
/** SIWC token endpoint (not Codex CLI `https://auth.openai.com/oauth/token`). */
export const CLINE_SIWC_TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
export const CLINE_SIWC_SHARING_SCOPE = 'chatgpt.tokens.use.direct';
export const CLINE_SIWC_MODEL_BASE = 'https://api.openai.com/v1';

const HOST_ID_RELATIVE = path.join('data', 'siwc', 'host-id');

export type ClineSiwcSecret = Extract<GatewayCredentialTarget, { kind: 'api-key' }>;

/** Bearer-only injection — must not attach ChatGPT-Account-Id. */
export function clineSiwcSecret(): Omit<ClineSiwcSecret, 'proxyValue'> {
  return {
    name: CLINE_SIWC_CONNECTION_NAME,
    kind: 'api-key',
    host: CLINE_SIWC_HOST,
    injection: {
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    },
  };
}

export function createClineSiwcVault(store: ProviderCredentialStore): GatewayCredentialConnection {
  if (!store.connection) {
    throw new Error('The selected gateway does not support provider credential connections.');
  }
  return store.connection({
    ...clineSiwcSecret(),
    proxyValue: CLINE_SIWC_PROXY_VALUE,
  });
}

export function resolveSiwcHostIdPath(root = process.cwd()): string {
  return path.join(root, HOST_ID_RELATIVE);
}

/** Load or create a stable ext_agent_host_id for this NanoClaw install. */
export function loadOrCreateSiwcHostId(root = process.cwd()): string {
  const file = resolveSiwcHostIdPath(root);
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.startsWith('urn:uuid:')) return existing;
    throw new Error(`Invalid SIWC host id at ${file}; expected urn:uuid:…`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const id = `urn:uuid:${randomUUID()}`;
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}

export function scopesIncludeSharing(scopes: readonly string[] | string | undefined): boolean {
  if (scopes == null) return false;
  const list = typeof scopes === 'string' ? scopes.split(/[\s+]+/).filter(Boolean) : scopes;
  return list.includes(CLINE_SIWC_SHARING_SCOPE);
}

export type SiwcTokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  /** Space-separated or array from token / callback. */
  scope?: string;
  scopes?: readonly string[];
};

/**
 * Access token string for the generic vault after a successful SIWC exchange.
 * Throws if plan-usage scope is missing.
 */
export function accessTokenFromSiwcTokens(tokens: SiwcTokenResponse): string {
  const accessToken = tokens.access_token?.trim();
  if (!accessToken) {
    throw new Error('SIWC token response is missing access_token.');
  }
  const scopes = tokens.scopes ?? tokens.scope;
  if (!scopesIncludeSharing(scopes)) {
    throw new Error(
      `SIWC login did not grant ${CLINE_SIWC_SHARING_SCOPE}; enable ChatGPT plan usage and sign in again.`,
    );
  }
  return accessToken;
}

export async function configureSiwcModelEndpoint(store: ProviderCredentialStore): Promise<void> {
  if (!store.modelEndpoint) return;
  await store.modelEndpoint(CLINE_SIWC_MODEL_BASE).configure();
}
