import crypto from 'node:crypto';
import { writeMessageOut } from '../db/messages-out.js';
import type { RoutingContext } from '../formatter.js';
import type { TurnStatusWriter } from '../turn-status.js';
import { safeProgressTitle, type DelegationProgress, ProgressSnapshot, RunState } from './model.generated.js';

export interface AgentProgressPoster {
  update(event?: DelegationProgress): Promise<void>;
  finish(state: Exclude<RunState, 'running'>): Promise<void>;
}
export function createAgentProgressPoster(
  route: RoutingContext,
  write: TurnStatusWriter = writeMessageOut,
): AgentProgressPoster | null {
  if (route.taskRun || route.channelType !== 'discord' || !route.platformId) return null;
  // Freeze the route: pushed turns cannot change the destination of an in-flight write.
  const routing = { ...route };
  const state: ProgressSnapshot = {
    version: 1,
    runId: crypto.randomUUID(),
    revision: 0,
    state: 'running',
    phase: 'preparing',
    batches: [],
    tasks: [],
  };
  let chain = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastWrite = 0;
  let finished = false;
  const flush = () => {
    state.revision++;
    const content = JSON.stringify(state);
    lastWrite = Date.now();
    const pending = chain
      .then(() =>
        write({
          id: `msg-${crypto.randomUUID()}`,
          kind: 'agent_progress',
          in_reply_to: routing.inReplyTo,
          platform_id: routing.platformId,
          channel_type: 'discord',
          thread_id: routing.threadId,
          content,
        }),
      )
      .then(() => {});
    // Retain sequencing after an error; callers observe their own write failure.
    chain = pending.catch(() => {});
    return pending;
  };
  return {
    async update(event) {
      if (finished) return;
      if (event?.kind === 'batch') {
        const old = state.batches.find((b) => b.id === event.batchId);
        if (old) old.state = event.state;
        else if (state.batches.length < 32)
          state.batches.push({ id: event.batchId, ordinal: state.batches.length + 1, state: event.state });
      }
      if (event?.kind === 'task') {
        const old = state.tasks.find((t) => t.id === event.taskId);
        const next = {
          id: event.taskId,
          batchId: event.batchId,
          title: safeProgressTitle(event.title ?? old?.title, old?.ordinal ?? state.tasks.length + 1),
          ordinal: old?.ordinal ?? state.tasks.length + 1,
          state: event.state,
          durationMs: event.durationMs,
        };
        if (old) Object.assign(old, next);
        else if (state.tasks.length < 32) state.tasks.push(next);
      }
      state.phase = state.batches.some((batch) => batch.state === 'queued' || batch.state === 'running')
        ? 'delegating'
        : state.batches.length
          ? 'synthesizing'
          : 'working';
      if (!lastWrite) {
        await flush();
        return;
      }
      if (!timer)
        timer = setTimeout(
          () => {
            timer = undefined;
            void flush().catch(() => {});
          },
          Math.max(0, 1500 - (Date.now() - lastWrite)),
        );
    },
    async finish(terminal) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      state.state = terminal;
      for (const task of state.tasks)
        if (task.state === 'queued' || task.state === 'running')
          task.state = terminal === 'failed' ? 'failed' : 'cancelled';
      for (const batch of state.batches)
        if (batch.state === 'queued' || batch.state === 'running')
          batch.state = terminal === 'failed' ? 'failed' : 'cancelled';
      await flush();
    },
  };
}
