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
  createDelegatedAgent,
  type AgentResult,
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

const CHILD_EXCLUDED_TOOLS = new Set(['ask_question', 'spawn_agent', 'delegate_tasks', 'resume_delegated_task']);

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
      typeof input.maxIterations === 'number' && input.maxIterations > 0 ? Math.floor(input.maxIterations) : 25;
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

  const baseUrl = spawnBaseUrl || parentBaseUrl || 'https://opencode.ai/zen/go/v1';
  const apiKey = input.apiKey?.trim() || 'placeholder';
  const maxIterations =
    typeof input.maxIterations === 'number' && input.maxIterations > 0 ? Math.floor(input.maxIterations) : 25;

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
export interface ClineSpawnAgentTool extends AgentTool {
  execute(input: { systemPrompt: string; task: string }, context: AgentToolContext): Promise<unknown>;
  canResume(): boolean;
  resume(
    instruction: string,
    context: AgentToolContext,
    wrap: (tool: AgentTool) => AgentTool,
  ): Promise<{
    text: string;
    finishReason: AgentResult['finishReason'];
    iterations: number;
    usage: { inputTokens: number; outputTokens: number };
  }>;
}
export function buildClineSpawnAgentTool(options: BuildClineSpawnAgentToolOptions): ClineSpawnAgentTool {
  const { spawn, cwd, extraChildTools = [], useMcpDeferral = true, log = () => {} } = options;

  // SDK 0.0.47 ignores SpawnAgentToolConfig.hooks; runtime config forwards them.
  let childDeferral: McpToolDeferral | null = null;
  let checkpoint: { messages: AgentResult['messages']; sessionId: string; activated: string[]; prompt: string } | null =
    null;
  // SDK 0.0.47's legacy adapter maps the modern iteration ceiling to "error".
  // Recognize only its exact diagnostic plus the actual iteration count.
  const iterationLimit = (result: { finishReason: string; text: string; iterations: number }) =>
    result.finishReason === 'max_iterations' ||
    (result.finishReason === 'error' &&
      result.iterations >= spawn.maxIterations &&
      result.text === `Agent runtime exceeded maxIterations (${spawn.maxIterations})`);
  const capture = (result: AgentResult, prompt: string): void => {
    checkpoint = null;
    if (!iterationLimit(result)) return;
    // Bound retained history; oversized transcripts are partial but not resumable.
    if (Buffer.byteLength(JSON.stringify(result.messages), 'utf8') > 2_000_000) return;
    checkpoint = {
      messages: result.messages,
      sessionId: childSessionStore.getStore()!,
      activated: [...(childDeferral?.activatedNames ?? [])],
      prompt,
    };
  };
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
        `spawn_agent start subAgentId=${ctx.subAgentId} model=${spawn.modelId} ` + `taskChars=${ctx.input.task.length}`,
      );
    },
    onSubAgentEnd: (ctx: SubAgentEndContext) => {
      if (ctx.agentResult) capture(ctx.agentResult, ctx.input.systemPrompt);
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
    canResume: () => checkpoint !== null,
    async resume(instruction, context, wrap) {
      const saved = checkpoint;
      if (!saved) throw new Error('Worker has no resumable iteration-limit checkpoint');
      checkpoint = null;
      return childSessionStore.run(saved.sessionId, async () => {
        const base = buildSpawnChildTools(cwd, extraChildTools).map(wrap);
        childDeferral = useMcpDeferral ? new McpToolDeferral(base) : null;
        childDeferral?.activate(saved.activated);
        const agent = createDelegatedAgent({
          kind: 'subagent',
          prompt: saved.prompt,
          configProvider,
          tools: childDeferral?.allRegisteredTools() ?? base,
          maxIterations: spawn.maxIterations,
          parentAgentId: context.agentId,
          abortSignal: context.signal,
          hookErrorMode: 'throw',
        });
        agent.restore(saved.messages);
        const result = await agent.continue(
          'Continue the original bounded objective from the retained history. Do not repeat successful side effects. ' +
            'Read back existing state before any uncertain write. Report completed work, remaining work, and uncertainty. ' +
            instruction,
        );
        return {
          text: result.text,
          finishReason: iterationLimit(result) ? 'max_iterations' : result.finishReason,
          iterations: result.iterations,
          usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
        };
      });
    },
    execute: async (input: { systemPrompt: string; task: string }, context: AgentToolContext) => {
      const childSessionId = crypto.randomUUID();
      return childSessionStore.run(childSessionId, async () => {
        const result = await inner.execute(input, context);
        return iterationLimit(result) ? { ...result, finishReason: 'max_iterations' } : result;
      });
    },
  };
}

/** Parent system-prompt when spawn is enabled — parent orchestrates; child does all tools. */
export function clineSpawnSystemPromptHint(modelId: string): string {
  return [
    '## Delegation (delegate_tasks) — REQUIRED for ALL tool use',
    `You have only delegate_tasks, resume_delegated_task, ask_question, and submit_and_exit. Workers use ${modelId} with file/shell/web/edit/skills/memory/MCP (including send_message).`,
    'You own interpretation, synthesis, final decisions, and the user-facing response. Execute through delegate_tasks or explicitly resume an existing worker.',
    'Decompose independent lookups into bounded objective-driven tasks in one batch. Do not pass the entire user request to one worker or split work into trivial one-tool steps.',
    'For a simple bounded operation, delegate one task. Use another batch only for work depending on previous results or missing results.',
    'Keep context minimal; specify expectedOutput. Workers cannot ask the user or delegate further.',
    'For a NEW independent task set followUpTo:null (or omit it). Only follow-ups may reference an actual taskRef returned earlier in this turn. Never fabricate a UUID or use an all-zero placeholder. If a tool rejects an input, correct the named field rather than repeating the same request.',
    'Give each delegate_tasks task a specific plain-language public title up to 60 characters describing the action and general target, e.g. 公式カレンダーで対象の収集日を確認 or 現在の通知設定と収集日を照合. Do not use generic category labels. Keep titles separate from objectives: no private data, personal names, email subjects/bodies, URLs, file paths, credentials, mentions, or copied objective/context/tool input/output. Omit title if you cannot describe the task safely; a numbered default will be shown.',
    'You own completion, not just aggregation. Define acceptance criteria from the original request; compare every worker result and completion report to them before finalizing. SDK status completed only means execution ended. Missing evidence or remaining work is not task completion.',
    'When required work is partial, failed, cancelled, timed out or unverified, recover before reporting: reuse checkpoints/evidence, narrow the missing work, and delegate a follow-up with followUpTo set to the earlier taskRef. Do not rerun completed siblings. A follow-up must cover all remaining work of its referenced task; split work into independent bounded tasks when needed.',
    'For exhaustive reviews, set requireCoverage:true and require all pages/IDs, exact window boundaries and enumerated/read/classified counts. Workers must pass actual ID sets and paginationComplete to report_task_result for harness reconciliation. A result estimate, capped listing, or unsupported completeness claim is insufficient. Separate enumeration, reading/classification and final reconciliation so a slow check can be recovered independently. A recovery must retain the original coverage requirement and combine prior reviewed IDs with the remainder.',
    'A max_iterations result may provide recovery.id: use resume_delegated_task with a narrow instruction to finish required work from its history. If no recovery ID exists (including timeouts), delegate missing work using prior evidence/checkpoints. Each resume consumes the same turn budget. Reserve attempts for validation and recovery; never blindly replay uncertain writes.',
    'Stop recovery for cancellation, an authorization/policy denial, a concrete external dependency, or exhausted bounded attempts. Explain what is verified, what remains and the exact blocker. A generic uncertainty disclaimer alone is not a substitute for available recovery. Always produce a final response, including when no worker completed.',
    'Respect external action permissions and approval requirements. Avoid conflicting writes and keep final integration and judgement yourself.',
  ].join('\n');
}
