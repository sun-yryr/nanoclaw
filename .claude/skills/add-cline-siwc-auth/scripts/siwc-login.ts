/**
 * Sign in with ChatGPT (OSS / local) — browser PKCE on the host.
 * Spec: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 *
 * Does not depend on @siwc/local (not published on npm). Tokens stay in memory
 * until the caller saves them through the gateway vault helpers.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadOrCreateSiwcHostId } from './cline-siwc-vault.js';

export const SIWC_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const SIWC_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const SIWC_RESOURCE = 'https://api.openai.com/v1';
export const SIWC_DYNAMIC_CLIENT = 'dynamic_agent_client';
export const SIWC_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
].join(' ');

export const SIWC_AGENT_NAME_HINT = 'NanoClaw Cline';
export const SIWC_USAGE_URL = 'https://chatgpt.com/#settings/Usage';
/** Loopback callback port (SIWC / Codex convention). Fixed for SSH -L from a GUI host. */
export const SIWC_CALLBACK_PORT = 1455;

const REGISTRATION_RELATIVE = path.join('data', 'siwc', 'registration.json');

export type SiwcRegistration = {
  clientId: string;
  subject?: string;
  email?: string;
  savedAt: string;
};

export type SiwcLoginResult = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  scope: string;
  expiresIn?: number;
  hostId: string;
};

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function randomOAuthValue(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function resolveSiwcRegistrationPath(root = process.cwd()): string {
  return path.join(root, REGISTRATION_RELATIVE);
}

export function loadSiwcRegistration(root = process.cwd()): SiwcRegistration | null {
  const file = resolveSiwcRegistrationPath(root);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SiwcRegistration;
  if (!raw?.clientId || raw.clientId === SIWC_DYNAMIC_CLIENT) return null;
  return raw;
}

export function saveSiwcRegistration(reg: SiwcRegistration, root = process.cwd()): void {
  const file = resolveSiwcRegistrationPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  hostId: string;
  agentNameHint?: string;
  idTokenHint?: string;
  loginHint?: string;
}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: SIWC_SCOPES,
    resource: SIWC_RESOURCE,
    state: params.state,
    nonce: params.nonce,
    code_challenge_method: 'S256',
    code_challenge: params.codeChallenge,
    ext_agent_host_id: params.hostId,
  });
  if (params.clientId === SIWC_DYNAMIC_CLIENT) {
    q.set('agent_name_hint', params.agentNameHint ?? SIWC_AGENT_NAME_HINT);
  }
  if (params.idTokenHint) q.set('id_token_hint', params.idTokenHint);
  if (params.loginHint) q.set('login_hint', params.loginHint);
  return `${SIWC_AUTHORIZE_URL}?${q.toString()}`;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Invalid JWT');
  return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Lightweight ID-token checks (signature verification is Phase 4 hardening). */
export function assertIdTokenClaims(
  idToken: string,
  expected: { clientId: string; nonce: string },
): { subject: string; email?: string } {
  const payload = decodeJwtPayload(idToken);
  if (payload.nonce !== expected.nonce) throw new Error('SIWC id_token nonce mismatch.');
  const aud = payload.aud;
  const audOk =
    aud === expected.clientId || (Array.isArray(aud) && aud.includes(expected.clientId));
  if (!audOk) throw new Error('SIWC id_token audience does not match the issued client id.');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('SIWC id_token missing sub.');
  return {
    subject: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  };
}

export async function exchangeAuthorizationCode(params: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  access_token: string;
  refresh_token: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  token_type?: string;
}> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
    resource: SIWC_RESOURCE,
  });
  const res = await fetchImpl(SIWC_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`SIWC token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as Record<string, unknown>;
  if (typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string') {
    throw new Error('SIWC token response missing access_token or refresh_token.');
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    id_token: typeof json.id_token === 'string' ? json.id_token : undefined,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
    expires_in: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    token_type: typeof json.token_type === 'string' ? json.token_type : undefined,
  };
}

function openInBrowser(url: string): void {
  let cmd: [string, string[]] | undefined;
  if (process.platform === 'darwin') cmd = ['open', [url]];
  else if (process.platform === 'linux') {
    cmd = ['xdg-open', [url]];
  } else if (process.platform === 'win32') {
    cmd = ['cmd.exe', ['/c', 'start', '', url]];
  }
  if (!cmd) return;
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // URL is printed by the caller.
  }
}

function readCallback(req: IncomingMessage): Promise<URL> {
  return new Promise((resolve, reject) => {
    const host = req.headers.host ?? '127.0.0.1';
    try {
      resolve(new URL(req.url ?? '/', `http://${host}`));
    } catch (err) {
      reject(err);
    }
  });
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

/**
 * Run the SIWC browser login once. Prefer reusing a saved issued client id.
 */
export async function runSiwcBrowserLogin(options?: {
  root?: string;
  port?: number;
  timeoutMs?: number;
  openBrowser?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<SiwcLoginResult> {
  const root = options?.root ?? process.cwd();
  const hostId = loadOrCreateSiwcHostId(root);
  const existing = loadSiwcRegistration(root);
  const authorizingClientId = existing?.clientId ?? SIWC_DYNAMIC_CLIENT;

  const { verifier, challenge } = createPkcePair();
  const state = randomOAuthValue();
  const nonce = randomOAuthValue();

  const port = options?.port ?? SIWC_CALLBACK_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid SIWC callback port: ${String(options?.port)}`);
  }

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `SIWC callback port ${port} is already in use. Free it, or pass a different --port / SIWC_CALLBACK_PORT.`,
          ),
        );
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const authorizeUrl = buildAuthorizeUrl({
    clientId: authorizingClientId,
    redirectUri,
    state,
    nonce,
    codeChallenge: challenge,
    hostId,
    agentNameHint: SIWC_AGENT_NAME_HINT,
  });

  const timeoutMs = options?.timeoutMs ?? 10 * 60_000;
  const callback = new Promise<{
    code: string;
    issuedClientId: string;
    scopeFromCallback?: string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for the SIWC browser callback.'));
    }, timeoutMs);

    server.on('request', async (req, res) => {
      try {
        const url = await readCallback(req);
        if (url.pathname !== '/auth/callback') {
          sendHtml(res, 404, '<p>Not found</p>');
          return;
        }
        if (url.searchParams.get('error')) {
          const err = url.searchParams.get('error')!;
          const desc = url.searchParams.get('error_description') ?? '';
          sendHtml(
            res,
            400,
            `<p>Sign-in was denied (${err}). You can close this tab.</p><p>${desc}</p>`,
          );
          clearTimeout(timer);
          reject(new Error(`SIWC authorization error: ${err} ${desc}`.trim()));
          return;
        }
        const returnedState = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        if (returnedState !== state || !code) {
          sendHtml(res, 400, '<p>Invalid OAuth callback. You can close this tab.</p>');
          clearTimeout(timer);
          reject(new Error('SIWC callback missing code or state mismatch.'));
          return;
        }
        const issued =
          url.searchParams.get('client_id')?.trim() ||
          (authorizingClientId !== SIWC_DYNAMIC_CLIENT ? authorizingClientId : '');
        if (!issued || issued === SIWC_DYNAMIC_CLIENT) {
          sendHtml(res, 400, '<p>Registration incomplete (no issued client id). Close this tab and retry.</p>');
          clearTimeout(timer);
          reject(new Error('SIWC callback did not include an issued client_id.'));
          return;
        }
        if (
          authorizingClientId !== SIWC_DYNAMIC_CLIENT &&
          url.searchParams.has('client_id') &&
          url.searchParams.get('client_id') !== authorizingClientId
        ) {
          sendHtml(res, 400, '<p>Client id mismatch. Close this tab and retry.</p>');
          clearTimeout(timer);
          reject(new Error('SIWC callback client_id does not match the saved registration.'));
          return;
        }
        sendHtml(
          res,
          200,
          '<p>NanoClaw SIWC sign-in complete. You can close this tab and return to the terminal.</p>',
        );
        clearTimeout(timer);
        resolve({
          code,
          issuedClientId: issued,
          scopeFromCallback: url.searchParams.get('scope') ?? undefined,
        });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });

  console.log('\nSign in with ChatGPT (SIWC) for NanoClaw Cline');
  console.log(`Callback: ${redirectUri}`);
  console.log(`If this host has no GUI, from a GUI machine run:`);
  console.log(`  ssh -L ${port}:127.0.0.1:${port} <user@this-host>`);
  console.log('then open this URL in that machine\'s browser:\n');
  console.log(authorizeUrl);
  console.log('');
  if (options?.openBrowser !== false) openInBrowser(authorizeUrl);

  try {
    const { code, issuedClientId, scopeFromCallback } = await callback;
    const tokens = await exchangeAuthorizationCode({
      clientId: issuedClientId,
      code,
      codeVerifier: verifier,
      redirectUri,
      fetchImpl: options?.fetchImpl,
    });

    let subject: string | undefined;
    let email: string | undefined;
    if (tokens.id_token) {
      const id = assertIdTokenClaims(tokens.id_token, { clientId: issuedClientId, nonce });
      subject = id.subject;
      email = id.email;
    }

    const scope = tokens.scope ?? scopeFromCallback ?? '';
    saveSiwcRegistration(
      {
        clientId: issuedClientId,
        subject,
        email,
        savedAt: new Date().toISOString(),
      },
      root,
    );

    return {
      clientId: issuedClientId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      scope,
      expiresIn: tokens.expires_in,
      hostId,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
