/**
 * Cline SIWC constants + vault access-token update via the OneCLI CLI.
 *
 * Host `src/` must not import `setup/` (tsc rootDir). Login/create still uses
 * `setup/gateways/credential-store` from the skill CLI under tsx.
 */
import { execFileSync } from 'node:child_process';

export const CLINE_SIWC_CONNECTION_NAME = 'Cline SIWC';
export const CLINE_SIWC_HOST = 'api.openai.com';
export const CLINE_SIWC_PROXY_VALUE = 'nc-cline-siwc-v1';
export const CLINE_SIWC_TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
export const CLINE_SIWC_SHARING_SCOPE = 'chatgpt.tokens.use.direct';
export const CLINE_SIWC_RESOURCE = 'https://api.openai.com/v1';
export const CLINE_SIWC_MODEL_BASE = 'https://api.openai.com/v1';

export function scopesIncludeSharing(scopes: readonly string[] | string | undefined): boolean {
  if (scopes == null) return false;
  const list = typeof scopes === 'string' ? scopes.split(/[\s+]+/).filter(Boolean) : scopes;
  return list.includes(CLINE_SIWC_SHARING_SCOPE);
}

export type SiwcTokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  scopes?: readonly string[];
};

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

type SecretRow = { id?: string; name?: string; type?: string };

/**
 * Replace the access_token on the existing generic "Cline SIWC" secret.
 * Does not create the secret — run the login CLI first.
 */
export function saveSiwcAccessToVault(accessToken: string): void {
  const raw = execFileSync('onecli', ['secrets', 'list', '--fields', 'id,name,type'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rows = JSON.parse(raw) as SecretRow[];
  const list = Array.isArray(rows) ? rows : [];
  const row = list.find((r) => r.name === CLINE_SIWC_CONNECTION_NAME && r.type !== 'openai' && r.id);
  if (!row?.id) {
    throw new Error(
      `No generic OneCLI secret named "${CLINE_SIWC_CONNECTION_NAME}". Run run-cline-siwc-auth.ts first.`,
    );
  }
  execFileSync('onecli', ['secrets', 'update', '--id', row.id, '--value', accessToken], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
