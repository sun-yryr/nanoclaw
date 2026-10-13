/**
 * Cline spawn_agent wiring for NanoClaw.
 *
 * Keeps the parent on @cline/agents Agent (no ClineCore). Children run through
 * createSpawnAgentTool with a separate model (typically a fast/cheap one).
 */
import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';

import {
  createDelegatedAgentConfigProvider,
  createSpawnAgentTool,
  type AgentHooks,
  type AgentTool,
  type AgentToolContext,
  type SubAgentEndContext,
  type SubAgentStartContext,
} from '@cline/sdk';

import { buildClineBuiltinTools } from './cline-builtin-tools.js';
import { McpToolDeferral } from './cline-mcp-deferral.js';

type BeforeModelContext = Parameters<NonNullable<AgentHooks['beforeModel']>>[0];
type BeforeToolContext = Parameters<NonNullable<AgentHooks['beforeTool']>>[0];

const CHILD_EXCLUDED_TOOLS = new Set(['ask_question', 'spawn_agent', 'delegate_tasks']);

/** Per-execute OpenCode Go session header — avoids races on parallel spawn_agent. */
const childSessionStore = new AsyncLocalStorage<string>();

export interface ClineSpawnConfig {
  modelId: string;
  providerId: 'openai-compatible' | 'openai-native';
  baseUrl: string;
  apiKey: string;
  maxIterations: number;
}

export interface ResolveClineSpawnConfigInput {
  spawnModel?: string | null;
  /** Same values as CLINE_API: omitted/"chat" or "responses". Defaults to chat. */
  spawnApi?: string | null;
  /**
   * Child endpoint (CLINE_SPAWN_BASE_URL). When unset, falls back to
   * parentBaseUrl / CLINE_BASE_URL.
   */
  spawnBaseUrl?: string | null;
  /** Parent CLINE_BASE_URL — used when spawnBaseUrl is unset. */
  parentBaseUrl?: string | null;
  /** @deprecated Prefer parentBaseUrl; kept as alias for callers. */
  baseUrl?: string | null;
  apiKey?: string | null;
  maxIterations?: number | null;
  /**
   * Parent CLINE_AUTH_MODE. When `siwc`, children do not inherit plan usage
   * unless spawnAuthMode is also `siwc` (or an explicit non-SIWC spawnBaseUrl).
   */
  parentAuthMode?: 'default' | 'siwc' | null;
  /** CLINE_SPAWN_AUTH_MODE — opt children into SIWC explicitly. */
  spawnAuthMode?: 'default' | 'siwc' | null;
}

function resolveSpawnProviderId(apiEnv?: string | null): 'openai-compatible' | 'openai-native' {
  const raw = (apiEnv ?? '').trim().toLowerCase();
  if (!raw || raw === 'chat') return 'openai-compatible';
  if (raw === 'responses') return 'openai-native';
  throw new Error(`Invalid CLINE_SPAWN_API=${JSON.stringify(apiEnv)} (expected "chat", "responses", or unset)`);
}

/**
 * Opt-in via CLINE_SPAWN_MODEL. Empty/unset → spawn disabled.
 * CLINE_SPAWN_API defaults to "chat" (fast models usually use chat/completions),
 * independent of the parent's CLINE_API — parent on responses + child on chat
 * is the common strong/fast split.
 * CLINE_SPAWN_BASE_URL selects a different endpoint; omit to share the parent's URL.
 *
 * SIWC parent: children stay off plan usage by default. Enable with
 * CLINE_SPAWN_AUTH_MODE=siwc, or set CLINE_SPAWN_BASE_URL to a non-api.openai.com
 * endpoint (API-key / OpenCode path). Inheriting the parent's SIWC base URL
 * alone is refused.
 */
export function resolveClineSpawnConfig(input: ResolveClineSpawnConfigInput): ClineSpawnConfig | null {
  const modelId = input.spawnModel?.trim();
  if (!modelId) return null;

  const parentAuthMode = input.parentAuthMode ?? 'default';
  const spawnAuthMode = input.spawnAuthMode ?? 'default';
  const spawnBaseUrl = input.spawnBaseUrl?.trim() || '';
  const parentBaseUrl = input.parentBaseUrl?.trim() || input.baseUrl?.trim() || '';

  if (spawnAuthMode === 'siwc') {
    const maxIterations =
      typeof input.maxIterations === 'number' && input.maxIterations > 0
        ? Math.floor(input.maxIterations)
        : 25;
    return {
      modelId,
      providerId: 'openai-native',
      baseUrl: spawnBaseUrl || 'https://api.openai.com/v1',
      apiKey: 'siwc-sentinel',
      maxIterations,
    };
  }

  if (parentAuthMode === 'siwc') {
    // Parent is on ChatGPT plan usage — do not silently put children there.
    if (!spawnBaseUrl) return null;
    if (isApiOpenAiBaseUrl(spawnBaseUrl)) return null;
  }

  const baseUrl =
    spawnBaseUrl || parentBaseUrl || 'https://opencode.ai/zen/go/v1';
  const apiKey = input.apiKey?.trim() || 'placeholder';
  const maxIterations =
    typeof input.maxIterations === 'number' && input.maxIterations > 0
      ? Math.floor(input.maxIterations)
      : 25;

  return {
    modelId,
    providerId: resolveSpawnProviderId(input.spawnApi),
    baseUrl,
    apiKey,
    maxIterations,
  };
}

function isApiOpenAiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

export function buildSpawnChildTools(cwd: string, extras: AgentTool[] = []): AgentTool[] {
  const builtins = buildClineBuiltinTools(cwd).filter((t) => !CHILD_EXCLUDED_TOOLS.has(t.name));
  return [...builtins, ...extras.filter((t) => !CHILD_EXCLUDED_TOOLS.has(t.name))];
}

function sessionHeaders(): Record<string, string> {
  const id = childSessionStore.getStore() ?? crypto.randomUUID();
  return { 'x-opencode-session': id };
}

export interface BuildClineSpawnAgentToolOptions {
  spawn: ClineSpawnConfig;
  cwd: string;
  /**
   * Tools only the child may use (MCP, memory, …). Parent must not register these.
   * Child also gets full builtins (minus ask_question / spawn_agent).
   */
  extraChildTools?: AgentTool[];
  /**
   * When false (SIWC child), skip MCP deferral / tool_search — SIWC Responses
   * rejects a tool named tool_search. Default true.
   */
  useMcpDeferral?: boolean;
  log?: (msg: string) => void;
  /** Harness-owned execution lock; never chosen by the model. */
  wrapChildTool?: (tool: AgentTool) => AgentTool;
}

/**
 * Parent-only spawn_agent tool. Children do not receive this tool (no nesting).
 * Each spawn gets a fresh MCP deferral so external MCP schemas stay progressive.
 */
export function buildClineSpawnAgentTool(options: BuildClineSpawnAgentToolOptions): AgentTool {
  const { spawn, cwd, extraChildTools = [], useMcpDeferral = true, log = () => {} } = options;

  // SDK 0.0.47 ignores SpawnAgentToolConfig.hooks; runtime config forwards them.
  let childDeferral: McpToolDeferral | null = null;
  const configProvider = createDelegatedAgentConfigProvider({
    providerId: spawn.providerId,
    modelId: spawn.modelId,
    apiKey: spawn.apiKey,
    baseUrl: spawn.baseUrl,
    cwd,
    maxIterations: spawn.maxIterations,
    headers: sessionHeaders(),
    hooks: {
      beforeModel: (context: BeforeModelContext) => childDeferral?.beforeModel(context),
      beforeTool: (context: BeforeToolContext) => childDeferral?.beforeTool(context),
    },
  });

  // Stamp a fresh session id into connection defaults on every config read so
  // OpenCode Go gets a valid x-opencode-session even outside AsyncLocalStorage.
  const baseGetConnection = configProvider.getConnectionConfig.bind(configProvider);
  const baseGetRuntime = configProvider.getRuntimeConfig.bind(configProvider);
  configProvider.getConnectionConfig = () => {
    const headers = sessionHeaders();
    configProvider.updateConnectionDefaults({ headers });
    return { ...baseGetConnection(), headers };
  };
  configProvider.getRuntimeConfig = () => {
    const headers = sessionHeaders();
    configProvider.updateConnectionDefaults({ headers });
    return { ...baseGetRuntime(), headers };
  };

  const inner = createSpawnAgentTool({
    configProvider,
    defaultMaxIterations: spawn.maxIterations,
    createSubAgentTools: () => {
      const base = buildSpawnChildTools(cwd, extraChildTools).map((tool) => options.wrapChildTool?.(tool) ?? tool);
      if (!useMcpDeferral) {
        log(`spawn child tools: ${base.length} (no MCP deferral)`);
        childDeferral = null;
        return base;
      }
      childDeferral = new McpToolDeferral(base);
      log(
        `spawn child tools: ${childDeferral.alwaysLoad.length} always-load, ` +
          `${childDeferral.deferred.length} deferred MCP`,
      );
      return childDeferral.allRegisteredTools();
    },
    hookErrorMode: 'throw',
    onSubAgentStart: (ctx: SubAgentStartContext) => {
      log(
        `spawn_agent start subAgentId=${ctx.subAgentId} model=${spawn.modelId} ` +
          `taskChars=${ctx.input.task.length}`,
      );
    },
    onSubAgentEnd: (ctx: SubAgentEndContext) => {
      if (ctx.error) {
        log(`spawn_agent end subAgentId=${ctx.subAgentId} error=${ctx.error.name}`);
        return;
      }
      log(
        `spawn_agent end subAgentId=${ctx.subAgentId} finish=${ctx.result?.finishReason ?? '?'} ` +
          `iters=${ctx.result?.iterations ?? '?'} outTokens=${ctx.result?.usage.outputTokens ?? '?'}`,
      );
    },
  });

  return {
    ...inner,
    execute: async (input: { systemPrompt: string; task: string }, context: AgentToolContext) => {
      const childSessionId = crypto.randomUUID();
      return childSessionStore.run(childSessionId, () => inner.execute(input, context));
    },
  };
}

/** Parent system-prompt when spawn is enabled — parent orchestrates; child does all tools. */
export function clineSpawnSystemPromptHint(modelId: string): string {
  return [
    '## Delegation (delegate_tasks) — REQUIRED for ALL tool use',
    `You have only delegate_tasks, ask_question, and submit_and_exit. Workers use ${modelId} with file/shell/web/edit/skills/memory/MCP (including send_message).`,
    'You own interpretation, synthesis, final decisions, and the user-facing response. Your only execution tool is delegate_tasks.',
    'Decompose independent lookups into bounded objective-driven tasks in one batch. Do not pass the entire user request to one worker or split work into trivial one-tool steps.',
    'For a simple bounded operation, delegate one task. Use another batch only for work depending on previous results or missing results.',
    'Keep context minimal; specify expectedOutput. Workers cannot ask the user or delegate further.',
    'Review partial, failed, and cancelled results before concluding. Never invent success or retry side effects blindly.',
    'Respect external action permissions and approval requirements. Avoid conflicting writes and keep final integration and judgement yourself.',
  ].join('\n');
}
