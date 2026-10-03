/**
 * Persist Cline AgentModelRequest / afterModel context under the session
 * workspace (`/workspace` → host `data/v2-sessions/<group>/<session>/`).
 *
 * Captures the SDK-layer I/O (messages, systemPrompt, tool definitions,
 * assistant reply) — not raw HTTP payloads or API keys.
 */
import fs from 'fs';
import path from 'path';

import type {
  AgentModelFinishReason,
  AgentModelRequest,
  AgentRunResult,
  AgentRuntimeHooks,
  AgentToolDefinition,
} from '@cline/agents';

type BeforeModelContext = Parameters<NonNullable<AgentRuntimeHooks['beforeModel']>>[0];
type AfterModelContext = Parameters<NonNullable<AgentRuntimeHooks['afterModel']>>[0];
type AfterRunContext = Parameters<NonNullable<AgentRuntimeHooks['afterRun']>>[0];

function log(msg: string): void {
  console.error(`[cline-model-io] ${msg}`);
}

const DEFAULT_DIR = '/workspace/debug/model-io';
const DEFAULT_MAX_FILES = 100;

export function modelIoEnabled(): boolean {
  const raw = process.env.CLINE_MODEL_IO;
  if (raw === undefined || raw.trim() === '') return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

export function modelIoDir(): string {
  return process.env.CLINE_MODEL_IO_DIR?.trim() || DEFAULT_DIR;
}

function modelIoMaxFiles(): number {
  const raw = process.env.CLINE_MODEL_IO_MAX_FILES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_FILES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_FILES;
  return Math.floor(n);
}

/** Strip non-JSON bits (AbortSignal) and keep tool defs without execute. */
export function serializeModelRequest(request: AgentModelRequest): Record<string, unknown> {
  return {
    systemPrompt: request.systemPrompt,
    messages: request.messages,
    tools: request.tools.map(serializeToolDef),
    options: request.options ?? undefined,
  };
}

function serializeToolDef(tool: AgentToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.lifecycle ? { lifecycle: tool.lifecycle } : {}),
  };
}

function stampFileName(seq: number, status: string): string {
  // Filesystem-safe ISO: 2026-10-03T15-20-01.123Z
  const ts = new Date().toISOString().replace(/:/g, '-');
  const padded = String(seq).padStart(4, '0');
  return `${ts}-call${padded}-${status}.json`;
}

export interface ModelIoMeta {
  providerId: string;
  modelId: string;
  sessionId: string;
}

export interface ModelIoRecord {
  ts: string;
  call: number;
  status: string;
  provider: 'cline';
  providerId: string;
  modelId: string;
  sessionId: string;
  input: Record<string, unknown> | null;
  output: {
    assistantMessage: unknown;
    finishReason: string;
  } | null;
  error?: unknown;
}

export function writeModelIoRecord(dir: string, record: ModelIoRecord, maxFiles = modelIoMaxFiles()): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, stampFileName(record.call, record.status));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, filePath);
  rotateModelIoDir(dir, maxFiles);
  return filePath;
}

/** Keep the newest `maxFiles` JSON dumps; delete older ones by mtime. */
export function rotateModelIoDir(dir: string, maxFiles: number): number {
  if (!fs.existsSync(dir)) return 0;
  const entries = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const full = path.join(dir, name);
      try {
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { full: string; mtimeMs: number } => e !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  let removed = 0;
  for (const stale of entries.slice(maxFiles)) {
    try {
      fs.unlinkSync(stale.full);
      removed++;
    } catch (err) {
      log(`Failed to rotate ${stale.full}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return removed;
}

/**
 * Hook bag that pairs beforeModel → afterModel into one file per model call.
 * A pending input left when the run ends is flushed with the run status/error.
 */
export function createModelIoHooks(meta: ModelIoMeta): AgentRuntimeHooks {
  const dir = modelIoDir();
  let call = 0;
  let pendingInput: Record<string, unknown> | null = null;

  const flush = (parts: {
    status: string;
    output?: ModelIoRecord['output'];
    error?: unknown;
  }): void => {
    if (!modelIoEnabled()) {
      pendingInput = null;
      return;
    }
    call += 1;
    try {
      const written = writeModelIoRecord(dir, {
        ts: new Date().toISOString(),
        call,
        status: parts.status,
        provider: 'cline',
        providerId: meta.providerId,
        modelId: meta.modelId,
        sessionId: meta.sessionId,
        input: pendingInput,
        output: parts.output ?? null,
        ...(parts.error !== undefined ? { error: serializeError(parts.error) } : {}),
      });
      log(`Wrote ${written}`);
    } catch (err) {
      log(`Failed to write model I/O dump: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      pendingInput = null;
    }
  };

  return {
    beforeModel(context: BeforeModelContext) {
      pendingInput = serializeModelRequest(context.request);
      return undefined;
    },
    afterModel(context: AfterModelContext) {
      const finishReason = context.finishReason as AgentModelFinishReason;
      const status = finishReason === 'error' ? 'error' : 'ok';
      flush({
        status,
        output: {
          assistantMessage: context.assistantMessage,
          finishReason,
        },
      });
      return undefined;
    },
    afterRun(context: AfterRunContext) {
      if (!pendingInput) return;
      // Model call started but afterModel never ran (throw / abort mid-stream).
      const result = context.result as AgentRunResult;
      flush({
        status: result.status === 'completed' ? 'incomplete' : result.status,
        error: result.error ?? result.status,
      });
    },
  };
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 12).join('\n'),
    };
  }
  return err;
}
