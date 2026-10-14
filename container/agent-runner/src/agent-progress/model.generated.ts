/** Public progress wire contract. Copy to runner: Node and Bun share no runtime modules. */
export const PROGRESS_TITLE_MAX_LENGTH = 60;
/** Public title only; pattern checks supplement the parent's privacy instructions. */
export function safeProgressTitle(value: unknown, ordinal: number): string {
  const fallback = `タスク ${ordinal}`;
  if (typeof value !== 'string') return fallback;
  // Check controls before trimming so newlines cannot become an accepted title.
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(value)) return fallback;
  const title = value.trim();
  if (!title || [...title].length > PROGRESS_TITLE_MAX_LENGTH) return fallback;
  if (/[<>@`*_[\]\\/]/u.test(title)) return fallback;
  if (/https?:|www\.|bearer\b|sk-|api[ _-]?key|access[ _-]?token|password|パスワード|認証情報/i.test(title))
    return fallback;
  if (/[a-z0-9+/=_-]{32,}|\d[\d ()+-]{6,}\d/i.test(title)) return fallback;
  return title;
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type RunState = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type TaskState = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'timed_out' | 'cancelled';
export type ProgressPhase = 'preparing' | 'working' | 'delegating' | 'synthesizing';
export interface ProgressTask {
  title: string;
  id: string;
  batchId: string;
  ordinal: number;
  state: TaskState;
  durationMs?: number;
}
export interface ProgressBatch {
  id: string;
  ordinal: number;
  state: TaskState;
}
export interface ProgressSnapshot {
  version: 1;
  runId: string;
  revision: number;
  state: RunState;
  phase: ProgressPhase;
  batches: ProgressBatch[];
  tasks: ProgressTask[];
}
/** IDs are harness-generated; model task IDs/objectives/raw titles never enter this event. */
export type DelegationProgress =
  | { kind: 'batch'; batchId: string; ordinal: number; state: TaskState }
  | {
      kind: 'task';
      batchId: string;
      taskId: string;
      ordinal: number;
      title?: string;
      state: TaskState;
      durationMs?: number;
    };

const RUN_STATES: RunState[] = ['running', 'completed', 'failed', 'cancelled', 'interrupted'];
const TASK_STATES: TaskState[] = ['queued', 'running', 'completed', 'partial', 'failed', 'timed_out', 'cancelled'];
const PHASES: ProgressPhase[] = ['preparing', 'working', 'delegating', 'synthesizing'];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid progress record');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid progress ID');
  return value;
}
function integer(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new Error('Invalid progress number');
  return Number(value);
}
function state<T extends string>(value: unknown, allowed: T[]): T {
  if (!allowed.includes(value as T)) throw new Error('Invalid progress state');
  return value as T;
}
/** Allowlist rebuild discards every unexpected/raw field before persistence or rendering. */
export function parseProgressSnapshot(value: unknown): ProgressSnapshot {
  const obj = record(value);
  if (
    obj.version !== 1 ||
    !Array.isArray(obj.batches) ||
    !Array.isArray(obj.tasks) ||
    obj.batches.length > 32 ||
    obj.tasks.length > 32
  )
    throw new Error('Invalid progress version/size');
  const batches = obj.batches.map((v) => {
    const b = record(v);
    return { id: id(b.id), ordinal: integer(b.ordinal, 32), state: state(b.state, TASK_STATES) };
  });
  const tasks = obj.tasks.map((v) => {
    const t = record(v);
    const batchId = id(t.batchId);
    if (!batches.some((b) => b.id === batchId)) throw new Error('Unknown progress batch');
    const durationMs = t.durationMs === undefined ? undefined : Number(t.durationMs);
    if (durationMs !== undefined && (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 604800000))
      throw new Error('Invalid duration');
    return {
      id: id(t.id),
      title: safeProgressTitle(t.title, integer(t.ordinal, 32)),
      batchId,
      ordinal: integer(t.ordinal, 32),
      state: state(t.state, TASK_STATES),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  });
  if (
    new Set(batches.map((b) => b.id)).size !== batches.length ||
    new Set(tasks.map((t) => t.id)).size !== tasks.length
  )
    throw new Error('Duplicate progress ID');
  return {
    version: 1,
    runId: id(obj.runId),
    revision: integer(obj.revision, 1000000),
    state: state(obj.state, RUN_STATES),
    phase: state(obj.phase, PHASES),
    batches,
    tasks,
  };
}
