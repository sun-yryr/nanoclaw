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

const CHILD_EXCLUDED_TOOLS = new Set(['ask_question', 'spawn_agent']);

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
}

function resolveSpawnProviderId(apiEnv?: string | null): 'openai-compatible' | 'openai-native' {
  const raw = (apiEnv ?? '').trim().toLowerCase();
  if (!raw || raw === 'chat') return 'openai-compatible';
  if (raw === 'responses') return 'openai-native';
  throw new Error(
    `Invalid CLINE_SPAWN_API=${JSON.stringify(apiEnv)} (expected "chat", "responses", or unset)`,
  );
}

/**
 * Opt-in via CLINE_SPAWN_MODEL. Empty/unset → spawn disabled.
 * CLINE_SPAWN_API defaults to "chat" (fast models usually use chat/completions),
 * independent of the parent's CLINE_API — parent on responses + child on chat
 * is the common strong/fast split.
 * CLINE_SPAWN_BASE_URL selects a different endpoint; omit to share the parent's URL.
 */
export function resolveClineSpawnConfig(input: ResolveClineSpawnConfigInput): ClineSpawnConfig | null {
  const modelId = input.spawnModel?.trim();
  if (!modelId) return null;

  const baseUrl =
    input.spawnBaseUrl?.trim() ||
    input.parentBaseUrl?.trim() ||
    input.baseUrl?.trim() ||
    'https://opencode.ai/zen/go/v1';
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

export function buildSpawnChildTools(
  cwd: string,
  extras: AgentTool[] = [],
): AgentTool[] {
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
  log?: (msg: string) => void;
}

/**
 * Parent-only spawn_agent tool. Children do not receive this tool (no nesting).
 * Each spawn gets a fresh MCP deferral so external MCP schemas stay progressive.
 */
export function buildClineSpawnAgentTool(options: BuildClineSpawnAgentToolOptions): AgentTool {
  const { spawn, cwd, extraChildTools = [], log = () => {} } = options;

  const configProvider = createDelegatedAgentConfigProvider({
    providerId: spawn.providerId,
    modelId: spawn.modelId,
    apiKey: spawn.apiKey,
    baseUrl: spawn.baseUrl,
    cwd,
    maxIterations: spawn.maxIterations,
    headers: sessionHeaders(),
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

  // Fresh deferral per spawn; hooks close over the active instance.
  let childDeferral: McpToolDeferral | null = null;

  const inner = createSpawnAgentTool({
    configProvider,
    defaultMaxIterations: spawn.maxIterations,
    createSubAgentTools: () => {
      const base = buildSpawnChildTools(cwd, extraChildTools);
      childDeferral = new McpToolDeferral(base);
      log(
        `spawn child tools: ${childDeferral.alwaysLoad.length} always-load, ` +
          `${childDeferral.deferred.length} deferred MCP`,
      );
      return childDeferral.allRegisteredTools();
    },
    hooks: {
      beforeModel: (context: BeforeModelContext) => childDeferral?.beforeModel(context),
      beforeTool: (context: BeforeToolContext) => childDeferral?.beforeTool(context),
    },
    onSubAgentStart: (ctx: SubAgentStartContext) => {
      log(
        `spawn_agent start subAgentId=${ctx.subAgentId} model=${spawn.modelId} ` +
          `taskChars=${ctx.input.task.length}`,
      );
    },
    onSubAgentEnd: (ctx: SubAgentEndContext) => {
      if (ctx.error) {
        log(`spawn_agent end subAgentId=${ctx.subAgentId} error=${ctx.error.message}`);
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
    '## Sub-agents (spawn_agent) — REQUIRED for ALL tool use',
    `You have NO tools except spawn_agent, ask_question, and submit_and_exit. A faster model (${modelId}) has file/shell/web/edit/skills/memory/MCP (send_message, cards, search, fitness, …).`,
    'For ANY side effect or lookup — messaging Discord/Slack, web search, file ops, shell, memory, MCP — call spawn_agent with an explicit instruction, e.g. "Send this exact text to destination health via mcp__nanoclaw__send_message: …" or "Look up X and return a short summary."',
    'Keep for yourself only: planning, deciding what to ask the user (ask_question), and composing the final user-facing answer after the child returns.',
    'Pass a tight systemPrompt (role + constraints + allowed destinations/tools) and a concrete task. Prefer one focused spawn per job; spawn again if you need another step.',
    'Do not invent tool results. If a child reports failure (auth, lock, empty), tell the user or spawn a different approach — do not retry endlessly yourself.',
    'Child agents cannot spawn further and cannot ask the user — ask yourself if needed, then spawn again with the answer.',
  ].join('\n');
}
