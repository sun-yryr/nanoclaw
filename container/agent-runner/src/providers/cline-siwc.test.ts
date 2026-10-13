import { afterEach, describe, expect, it } from 'bun:test';

import { resolveClineProviderId } from './cline.js';
import {
  CLINE_SIWC_API_KEY_SENTINEL,
  CLINE_SIWC_BASE_URL,
  CLINE_SIWC_DEFAULT_MODEL,
  formatClineAuthFailureNotice,
  installSiwcFetchRewrite,
  isClineAuthFailureMessage,
  isOpenCodeOrLunaModelId,
  isSiwcResponsesRequestUrl,
  resetSiwcFetchRewriteForTests,
  resolveClineAuthMode,
  resolveClineRuntime,
  rewriteSiwcResponsesBody,
} from './cline-siwc.js';

describe('resolveClineAuthMode', () => {
  it('defaults omitted/empty/default aliases to default', () => {
    expect(resolveClineAuthMode(undefined)).toBe('default');
    expect(resolveClineAuthMode(null)).toBe('default');
    expect(resolveClineAuthMode('')).toBe('default');
    expect(resolveClineAuthMode('default')).toBe('default');
    expect(resolveClineAuthMode('API-KEY')).toBe('default');
  });

  it('accepts siwc', () => {
    expect(resolveClineAuthMode('siwc')).toBe('siwc');
    expect(resolveClineAuthMode(' SIWC ')).toBe('siwc');
  });

  it('throws on unknown values', () => {
    expect(() => resolveClineAuthMode('codex')).toThrow(/Invalid CLINE_AUTH_MODE/);
  });
});

describe('formatClineAuthFailureNotice', () => {
  it('adds a re-login hint for SIWC expired tokens', () => {
    const msg = 'Provided authentication token is expired. Please try signing in again.';
    expect(isClineAuthFailureMessage(msg)).toBe(true);
    const notice = formatClineAuthFailureNotice(msg, 'siwc');
    expect(notice).toContain(msg);
    expect(notice).toContain('run-cline-siwc-auth.ts');
  });

  it('passes through non-auth errors unchanged', () => {
    expect(formatClineAuthFailureNotice('rate limited', 'siwc')).toBe('rate limited');
  });
});

describe('resolveClineRuntime', () => {
  const resolveProviderId = resolveClineProviderId;

  it('keeps default OpenCode-shaped settings', () => {
    const rt = resolveClineRuntime({
      resolveProviderId,
      sessionId: 'sess-1',
    });
    expect(rt.authMode).toBe('default');
    expect(rt.providerId).toBe('openai-compatible');
    expect(rt.baseUrl).toBe('https://opencode.ai/zen/go/v1');
    expect(rt.apiKey).toBe('placeholder');
    expect(rt.modelId).toBe('opencode-go/kimi-k2.6');
    expect(rt.headers).toEqual({ 'x-opencode-session': 'sess-1' });
    expect(rt.useMcpDeferral).toBe(true);
    expect(rt.installFetchRewrite).toBe(false);
  });

  it('maps responses API in default mode', () => {
    const rt = resolveClineRuntime({
      apiEnv: 'responses',
      baseUrlEnv: 'https://example.com/v1',
      modelEnv: 'gpt-6-luna',
      apiKeyEnv: 'placeholder',
      resolveProviderId,
      sessionId: 's',
    });
    expect(rt.providerId).toBe('openai-native');
    expect(rt.baseUrl).toBe('https://example.com/v1');
    expect(rt.headers['x-opencode-session']).toBe('s');
  });

  it('forces SIWC openai-native + sentinel + no session header', () => {
    const rt = resolveClineRuntime({
      authModeEnv: 'siwc',
      apiEnv: 'chat',
      modelEnv: 'gpt-5.4',
      openCodeModelEnv: 'opencode-go/kimi-k2.6',
      apiKeyEnv: 'should-ignore',
      resolveProviderId,
      sessionId: 'sess-ignored',
    });
    expect(rt).toMatchObject({
      authMode: 'siwc',
      providerId: 'openai-native',
      baseUrl: CLINE_SIWC_BASE_URL,
      apiKey: CLINE_SIWC_API_KEY_SENTINEL,
      modelId: 'gpt-5.4',
      useMcpDeferral: false,
      installFetchRewrite: true,
    });
    expect(rt.headers).toEqual({});
  });

  it('defaults SIWC model when unset', () => {
    const rt = resolveClineRuntime({
      authModeEnv: 'siwc',
      resolveProviderId,
    });
    expect(rt.modelId).toBe(CLINE_SIWC_DEFAULT_MODEL);
  });

  it('rejects OpenCode/Luna model ids in SIWC mode', () => {
    expect(() =>
      resolveClineRuntime({
        authModeEnv: 'siwc',
        modelEnv: 'opencode-go/kimi-k2.6',
        resolveProviderId,
      }),
    ).toThrow(/rejects OpenCode\/Luna/);
  });

  it('rejects non-api.openai.com base URL override in SIWC mode', () => {
    expect(() =>
      resolveClineRuntime({
        authModeEnv: 'siwc',
        baseUrlEnv: 'https://opencode.ai/zen/go/v1',
        resolveProviderId,
      }),
    ).toThrow(/api\.openai\.com/);
  });
});

describe('isOpenCodeOrLunaModelId', () => {
  it('detects known non-SIWC ids', () => {
    expect(isOpenCodeOrLunaModelId('opencode-go/kimi-k2.6')).toBe(true);
    expect(isOpenCodeOrLunaModelId('gpt-6-luna')).toBe(true);
    expect(isOpenCodeOrLunaModelId('gpt-5.4')).toBe(false);
  });
});

describe('rewriteSiwcResponsesBody', () => {
  it('sets store:false and strips truncation', () => {
    expect(
      rewriteSiwcResponsesBody({
        model: 'gpt-5.4',
        input: [],
        stream: true,
        truncation: 'auto',
        temperature: 0.2,
      }),
    ).toEqual({
      model: 'gpt-5.4',
      input: [],
      stream: true,
      store: false,
    });
  });
});

describe('isSiwcResponsesRequestUrl', () => {
  it('matches /v1/responses', () => {
    expect(isSiwcResponsesRequestUrl('https://api.openai.com/v1/responses')).toBe(true);
    expect(isSiwcResponsesRequestUrl('https://api.openai.com/v1/chat/completions')).toBe(false);
    expect(isSiwcResponsesRequestUrl('https://child.example/v1/responses')).toBe(false);
    expect(isSiwcResponsesRequestUrl('/v1/responses')).toBe(false);
    expect(isSiwcResponsesRequestUrl('https://api.openai.com.attacker.example/responses')).toBe(false);
  });
});

describe('installSiwcFetchRewrite', () => {
  afterEach(() => {
    resetSiwcFetchRewriteForTests();
  });

  it('rewrites Responses JSON bodies on the wire', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push({ url, body: String(init?.body ?? '') });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const uninstall = installSiwcFetchRewrite(fakeFetch);
    await globalThis.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5.4', stream: true, truncation: 'auto' }),
    });
    uninstall();

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body)).toEqual({
      model: 'gpt-5.4',
      stream: true,
      store: false,
    });
  });

  it('SIWC parent does not rewrite a different Responses child host', async () => {
    const bodies: string[] = [];
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response('{}');
    }) as typeof fetch;
    const uninstall = installSiwcFetchRewrite(fakeFetch);
    const original = JSON.stringify({ model: 'child', store: true, temperature: 0.2, truncation: 'auto' });
    try {
      await Promise.all([
        fetch('https://api.openai.com/v1/responses', { method: 'POST', body: original }),
        fetch('https://child.example/v1/responses', { method: 'POST', body: original }),
      ]);
      expect(JSON.parse(bodies[0]!)).toEqual({ model: 'child', store: false });
      expect(bodies[1]).toBe(original);
    } finally {
      uninstall();
    }
  });

  it('leaves non-Responses requests alone', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: typeof input === 'string' ? input : String(input),
        body: String(init?.body ?? ''),
      });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const uninstall = installSiwcFetchRewrite(fakeFetch);
    const original = JSON.stringify({ truncation: 'auto' });
    await globalThis.fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      body: original,
    });
    uninstall();

    expect(calls[0]!.body).toBe(original);
  });
});
