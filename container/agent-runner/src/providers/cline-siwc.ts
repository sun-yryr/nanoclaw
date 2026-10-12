/**
 * Cline + Sign in with ChatGPT (SIWC) runtime helpers.
 *
 * Auth stays on the gateway vault (Authorization rewrite). This module only
 * shapes the container Agent: openai-native → api.openai.com/v1, sentinel key,
 * no OpenCode session header, and a fetch rewrite for SIWC preview field rules.
 */
export const CLINE_SIWC_BASE_URL = 'https://api.openai.com/v1';
export const CLINE_SIWC_API_KEY_SENTINEL = 'siwc-sentinel';
/** Default when CLINE_MODEL is unset in SIWC mode — not an OpenCode / Luna id. */
export const CLINE_SIWC_DEFAULT_MODEL = 'gpt-5.4';

export type ClineAuthMode = 'default' | 'siwc';

const SIWC_STRIP_BODY_KEYS = new Set([
  'truncation',
  'temperature',
  'top_p',
  'top_logprobs',
  'user',
  'metadata',
  'previous_response_id',
  'max_output_tokens',
  'max_tool_calls',
  'prompt_cache_retention',
  'safety_identifier',
  'background',
  'conversation',
  'moderation',
  'multi_agent',
  'prompt',
]);

const OPENCODE_OR_LUNA_MODEL =
  /^(opencode-go\/|opencode\/|gpt-.*-luna|kimi-k|deepseek-v)/i;

export function resolveClineAuthMode(env?: string | null): ClineAuthMode {
  const raw = (env ?? '').trim().toLowerCase();
  if (!raw || raw === 'default' || raw === 'api-key' || raw === 'generic') return 'default';
  if (raw === 'siwc') return 'siwc';
  throw new Error(
    `Invalid CLINE_AUTH_MODE=${JSON.stringify(env)} (expected "siwc", "default", or unset)`,
  );
}

export function isOpenCodeOrLunaModelId(modelId: string): boolean {
  return OPENCODE_OR_LUNA_MODEL.test(modelId.trim());
}

export interface ClineSiwcRuntime {
  authMode: ClineAuthMode;
  providerId: 'openai-compatible' | 'openai-native';
  baseUrl: string;
  apiKey: string;
  modelId: string;
  /** Empty for SIWC — x-opencode-session is not required on api.openai.com. */
  headers: Record<string, string>;
  /** SIWC preview forbids Responses tool_search; skip MCP deferral. */
  useMcpDeferral: boolean;
  installFetchRewrite: boolean;
}

export interface ResolveClineSiwcRuntimeInput {
  authModeEnv?: string | null;
  apiEnv?: string | null;
  baseUrlEnv?: string | null;
  modelEnv?: string | null;
  openCodeModelEnv?: string | null;
  apiKeyEnv?: string | null;
  /**
   * Resolve CLINE_API the same way as the default path.
   * Injected so this module stays free of a circular import with cline.ts.
   */
  resolveProviderId: (apiEnv?: string | null) => 'openai-compatible' | 'openai-native';
  /** Opaque session id for OpenCode Go header when not SIWC. */
  sessionId?: string;
}

/**
 * Resolve container Agent connection settings for the active auth mode.
 * SIWC forces openai-native + api.openai.com/v1 + sentinel; default keeps
 * existing OpenCode Go / generic-secret behavior.
 */
export function resolveClineRuntime(input: ResolveClineSiwcRuntimeInput): ClineSiwcRuntime {
  const authMode = resolveClineAuthMode(input.authModeEnv);

  if (authMode === 'siwc') {
    const override = input.baseUrlEnv?.trim();
    const baseUrl = override || CLINE_SIWC_BASE_URL;
    if (override && !isSiwcCompatibleBaseUrl(override)) {
      throw new Error(
        `CLINE_AUTH_MODE=siwc requires CLINE_BASE_URL on api.openai.com (got ${JSON.stringify(override)})`,
      );
    }

    const modelId =
      input.modelEnv?.trim() || CLINE_SIWC_DEFAULT_MODEL;
    if (isOpenCodeOrLunaModelId(modelId)) {
      throw new Error(
        `CLINE_AUTH_MODE=siwc rejects OpenCode/Luna model id ${JSON.stringify(modelId)}; set CLINE_MODEL to a ChatGPT plan model (e.g. gpt-5.4)`,
      );
    }

    // Ignore CLINE_API — SIWC is Responses-only on api.openai.com.
    void input.apiEnv;
    void input.openCodeModelEnv;

    return {
      authMode,
      providerId: 'openai-native',
      baseUrl,
      apiKey: CLINE_SIWC_API_KEY_SENTINEL,
      modelId,
      headers: {},
      useMcpDeferral: false,
      installFetchRewrite: true,
    };
  }

  const baseUrl = input.baseUrlEnv?.trim() || 'https://opencode.ai/zen/go/v1';
  const modelId =
    input.modelEnv?.trim() || input.openCodeModelEnv?.trim() || 'opencode-go/kimi-k2.6';
  const apiKey = input.apiKeyEnv?.trim() || 'placeholder';
  const sessionId = input.sessionId?.trim();
  const headers: Record<string, string> = sessionId
    ? { 'x-opencode-session': sessionId }
    : {};

  return {
    authMode,
    providerId: input.resolveProviderId(input.apiEnv),
    baseUrl,
    apiKey,
    modelId,
    headers,
    useMcpDeferral: true,
    installFetchRewrite: false,
  };
}

export function isSiwcCompatibleBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.openai.com';
  } catch {
    return false;
  }
}

/** True when the request URL is a Responses call we should rewrite for SIWC. */
export function isSiwcResponsesRequestUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /\/v1\/responses\/?$/.test(parsed.pathname) || /\/responses\/?$/.test(parsed.pathname);
  } catch {
    return /\/responses(?:\?|$)/.test(url);
  }
}

/**
 * Force SIWC-safe Responses body: store:false, strip preview-forbidden keys.
 */
export function rewriteSiwcResponsesBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const next: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  next.store = false;
  for (const key of SIWC_STRIP_BODY_KEYS) {
    delete next[key];
  }
  return next;
}

type FetchLike = typeof globalThis.fetch;

let installedOriginal: FetchLike | null = null;
let installDepth = 0;

/**
 * Patch globalThis.fetch so openai-native Responses bodies satisfy SIWC
 * preview rules. Nested install/uninstall is refcounted. Returns uninstall.
 */
export function installSiwcFetchRewrite(fetchImpl: FetchLike = globalThis.fetch): () => void {
  if (installDepth === 0) {
    const original = fetchImpl.bind(globalThis) as FetchLike;
    installedOriginal = original;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;

      if (!init?.body || typeof init.body !== 'string' || !isSiwcResponsesRequestUrl(url)) {
        return original(input, init);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(init.body);
      } catch {
        return original(input, init);
      }

      const rewritten = rewriteSiwcResponsesBody(parsed);
      return original(input, {
        ...init,
        body: JSON.stringify(rewritten),
      });
    }) as FetchLike;
  }
  installDepth += 1;

  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    installDepth = Math.max(0, installDepth - 1);
    if (installDepth === 0 && installedOriginal) {
      globalThis.fetch = installedOriginal;
      installedOriginal = null;
    }
  };
}

/** Test helper — reset module install state. */
export function resetSiwcFetchRewriteForTests(): void {
  if (installedOriginal) {
    globalThis.fetch = installedOriginal;
  }
  installedOriginal = null;
  installDepth = 0;
}
