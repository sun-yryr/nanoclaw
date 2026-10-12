/**
 * Caller-described gateway target for Cline + Sign in with ChatGPT (SIWC).
 *
 * Live probe (2026-10-12): Bearer-only to api.openai.com succeeds; adding
 * ChatGPT-Account-Id (OIDC sub or otherwise) returns 400 invalid_request.
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
import {
  CLINE_SIWC_CONNECTION_NAME,
  CLINE_SIWC_HOST,
  CLINE_SIWC_MODEL_BASE,
  CLINE_SIWC_PROXY_VALUE,
  CLINE_SIWC_SHARING_SCOPE,
  CLINE_SIWC_TOKEN_ENDPOINT,
  accessTokenFromSiwcTokens,
  scopesIncludeSharing,
  type SiwcTokenResponse,
} from '../../../../src/modules/siwc-refresh/vault.js';

export {
  CLINE_SIWC_CONNECTION_NAME,
  CLINE_SIWC_HOST,
  CLINE_SIWC_MODEL_BASE,
  CLINE_SIWC_PROXY_VALUE,
  CLINE_SIWC_SHARING_SCOPE,
  CLINE_SIWC_TOKEN_ENDPOINT,
  accessTokenFromSiwcTokens,
  scopesIncludeSharing,
  type SiwcTokenResponse,
};

export type ClineSiwcSecret = Extract<GatewayCredentialTarget, { kind: 'api-key' }>;

const HOST_ID_RELATIVE = path.join('data', 'siwc', 'host-id');

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

export async function configureSiwcModelEndpoint(store: ProviderCredentialStore): Promise<void> {
  if (!store.modelEndpoint) return;
  await store.modelEndpoint(CLINE_SIWC_MODEL_BASE).configure();
}
