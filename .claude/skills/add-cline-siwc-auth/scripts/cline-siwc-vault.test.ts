import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import type { GatewayCredentialTarget, ProviderCredentialStore } from '../../../../setup/gateways/credential-store.js';
import {
  CLINE_SIWC_CONNECTION_NAME,
  CLINE_SIWC_HOST,
  CLINE_SIWC_PROXY_VALUE,
  accessTokenFromSiwcTokens,
  clineSiwcSecret,
  createClineSiwcVault,
  loadOrCreateSiwcHostId,
  scopesIncludeSharing,
} from './cline-siwc-vault.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

it('builds a generic Bearer target for api.openai.com', () => {
  expect(clineSiwcSecret()).toEqual({
    name: CLINE_SIWC_CONNECTION_NAME,
    kind: 'api-key',
    host: CLINE_SIWC_HOST,
    injection: {
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    },
  });
});

it('opens the gateway connection with the SIWC sentinel proxyValue', async () => {
  const seen: GatewayCredentialTarget[] = [];
  const store: ProviderCredentialStore = {
    has: async () => false,
    save: async () => {},
    connection(target) {
      seen.push(target);
      return {
        find: async () => null,
        save: async () => {},
        keep: async () => {},
      };
    },
  };
  const vault = createClineSiwcVault(store);
  expect(await vault.find()).toBeNull();
  expect(seen).toEqual([
    {
      name: CLINE_SIWC_CONNECTION_NAME,
      kind: 'api-key',
      host: CLINE_SIWC_HOST,
      proxyValue: CLINE_SIWC_PROXY_VALUE,
      injection: {
        headerName: 'Authorization',
        valueFormat: 'Bearer {value}',
      },
    },
  ]);
});

it('persists a stable urn:uuid host id per install', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siwc-host-'));
  roots.push(root);
  const first = loadOrCreateSiwcHostId(root);
  const second = loadOrCreateSiwcHostId(root);
  expect(first).toMatch(/^urn:uuid:[0-9a-f-]{36}$/i);
  expect(second).toBe(first);
});

it('requires chatgpt.tokens.use.direct before accepting an access token', () => {
  const access = fakeJwt({
    'https://api.openai.com/auth': { encrypted_auth_metadata: 'opaque' },
  });
  expect(() =>
    accessTokenFromSiwcTokens({
      access_token: access,
      scope: 'openid profile email',
    }),
  ).toThrow(/chatgpt\.tokens\.use\.direct/);
});

it('returns the access token when sharing scope is present', () => {
  const access = fakeJwt({
    sub: 'user-sub',
    'https://api.openai.com/auth': { per_user_salt: 'x', encrypted_auth_metadata: 'y' },
  });
  expect(
    accessTokenFromSiwcTokens({
      access_token: access,
      scopes: ['openid', 'chatgpt.tokens.use.direct', 'offline_access'],
    }),
  ).toBe(access);
  expect(scopesIncludeSharing('openid+chatgpt.tokens.use.direct')).toBe(true);
});
