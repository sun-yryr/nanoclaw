import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import {
  SIWC_CALLBACK_PORT,
  SIWC_DYNAMIC_CLIENT,
  SIWC_RESOURCE,
  assertIdTokenClaims,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  loadSiwcRegistration,
  saveSiwcRegistration,
} from './siwc-login.js';

it('uses fixed loopback callback port 1455 by default', () => {
  expect(SIWC_CALLBACK_PORT).toBe(1455);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

it('builds a PKCE pair with s256 challenge', () => {
  const { verifier, challenge } = createPkcePair();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(challenge).not.toBe(verifier);
});

it('builds first-time authorize URL with dynamic client and host id', () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: SIWC_DYNAMIC_CLIENT,
      redirectUri: 'http://127.0.0.1:1455/auth/callback',
      state: 'st',
      nonce: 'nn',
      codeChallenge: 'cc',
      hostId: 'urn:uuid:11111111-1111-1111-1111-111111111111',
    }),
  );
  expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
  expect(url.searchParams.get('client_id')).toBe(SIWC_DYNAMIC_CLIENT);
  expect(url.searchParams.get('resource')).toBe(SIWC_RESOURCE);
  expect(url.searchParams.get('agent_name_hint')).toBe('NanoClaw Cline');
  expect(url.searchParams.get('ext_agent_host_id')).toContain('urn:uuid:');
  expect(url.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
});

it('omits agent_name_hint when reusing an issued client id', () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: 'oaiapp_issued',
      redirectUri: 'http://127.0.0.1:9/auth/callback',
      state: 'st',
      nonce: 'nn',
      codeChallenge: 'cc',
      hostId: 'urn:uuid:22222222-2222-2222-2222-222222222222',
    }),
  );
  expect(url.searchParams.get('client_id')).toBe('oaiapp_issued');
  expect(url.searchParams.has('agent_name_hint')).toBe(false);
});

it('checks id_token nonce and audience', () => {
  const idToken = fakeJwt({
    nonce: 'expected-nonce',
    aud: 'oaiapp_x',
    sub: 'user-1',
    email: 'a@example.com',
  });
  expect(assertIdTokenClaims(idToken, { clientId: 'oaiapp_x', nonce: 'expected-nonce' })).toEqual({
    subject: 'user-1',
    email: 'a@example.com',
  });
  expect(() => assertIdTokenClaims(idToken, { clientId: 'oaiapp_x', nonce: 'wrong' })).toThrow(/nonce/);
});

it('persists issued client registration without tokens', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siwc-reg-'));
  roots.push(root);
  saveSiwcRegistration(
    { clientId: 'oaiapp_saved', subject: 'sub', email: 'e@example.com', savedAt: '2026-01-01T00:00:00.000Z' },
    root,
  );
  expect(loadSiwcRegistration(root)?.clientId).toBe('oaiapp_saved');
  const raw = fs.readFileSync(path.join(root, 'data/siwc/registration.json'), 'utf8');
  expect(raw).not.toMatch(/access_token|refresh_token/);
});

it('exchanges authorization code against the SIWC token endpoint', async () => {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') });
    return new Response(
      JSON.stringify({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: 'idt',
        scope: 'openid chatgpt.tokens.use.direct',
        expires_in: 3600,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const tokens = await exchangeAuthorizationCode({
    clientId: 'oaiapp_x',
    code: 'code',
    codeVerifier: 'verifier',
    redirectUri: 'http://127.0.0.1:1/auth/callback',
    fetchImpl,
  });
  expect(tokens.access_token).toBe('at');
  expect(calls[0]?.url).toBe('https://auth.openai.com/api/accounts/oauth/token');
  expect(calls[0]?.body).toContain('grant_type=authorization_code');
  expect(calls[0]?.body).toContain('resource=https%3A%2F%2Fapi.openai.com%2Fv1');
});
