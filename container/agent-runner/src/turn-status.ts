/**
 * Progressive turn-status posts for long-running agent turns (esp. spawn_agent).
 *
 * Writes `kind: 'turn_status'` outbound rows. The host sticky-edits one Discord
 * (or other) message per session destination so the user sees tool progress
 * without a flood of new bubbles. Not counted as a user-facing chat reply.
 */
import { writeMessageOut } from './db/messages-out.js';
import type { RoutingContext } from './formatter.js';

const DEBOUNCE_MS = 1500;
const MAX_LINES = 8;
const MAX_DETAIL = 120;
const MAX_MESSAGE = 1800;

/** Tools that are the reply itself — never surface as status. */
const SKIP_TOOLS = new Set([
  'send_message',
  'send_file',
  'edit_message',
  'add_reaction',
  'send_card',
  'ask_user_question',
  'ask_question',
  'submit',
  'submit_and_exit',
]);

export function shouldSkipToolStatus(toolName: string): boolean {
  if (SKIP_TOOLS.has(toolName)) return true;
  // MCP tools arrive as mcp__<server>__<tool> — match the bare tool suffix.
  const sep = toolName.lastIndexOf('__');
  if (sep >= 0 && sep + 2 < toolName.length) {
    return SKIP_TOOLS.has(toolName.slice(sep + 2));
  }
  return false;
}

/** One-line detail from a tool call input (spawn task, bash command, …). */
export function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  if (toolName === 'spawn_agent') {
    const task = typeof obj.task === 'string' ? obj.task : '';
    return clip(task.replace(/\s+/g, ' ').trim(), MAX_DETAIL);
  }

  for (const key of ['command', 'path', 'file_path', 'url', 'query', 'pattern', 'glob']) {
    if (typeof obj[key] === 'string' && obj[key].trim()) {
      return clip(String(obj[key]).replace(/\s+/g, ' ').trim(), MAX_DETAIL);
    }
  }

  try {
    return clip(JSON.stringify(input).replace(/\s+/g, ' '), MAX_DETAIL);
  } catch {
    return '';
  }
}

export function formatToolStatusLine(phase: 'start' | 'end', toolName: string, input: unknown): string | null {
  if (shouldSkipToolStatus(toolName)) return null;
  const detail = summarizeToolInput(toolName, input);
  if (phase === 'start') {
    return detail ? `→ ${toolName} — ${detail}` : `→ ${toolName}`;
  }
  return detail ? `✓ ${toolName} — ${detail}` : `✓ ${toolName}`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface TurnStatusPoster {
  /** Append a progress line (debounced). No-op for task / incomplete routes. */
  update(line: string): Promise<void>;
  /** Flush pending debounce and mark the sticky status done. */
  finish(finalLine?: string): Promise<void>;
}

export type TurnStatusWriter = (row: {
  id: string;
  in_reply_to?: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}) => Promise<unknown>;

/**
 * Build a poster bound to one turn's reply route. Returns null when the route
 * cannot receive channel status (task runs, missing platform, agent-to-agent).
 */
export function createTurnStatusPoster(
  routing: RoutingContext,
  write: TurnStatusWriter = writeMessageOut,
): TurnStatusPoster | null {
  if (routing.taskRun) return null;
  if (!routing.platformId || !routing.channelType) return null;
  if (routing.channelType === 'agent') return null;

  const lines: string[] = [];
  let lastPosted = '';
  let lastWriteAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const render = (): string => {
    const body = (lines.length ? lines : ['Working…']).slice(-MAX_LINES).join('\n');
    return body.length <= MAX_MESSAGE ? body : `${body.slice(0, MAX_MESSAGE - 1)}…`;
  };

  const flush = async (done: boolean): Promise<void> => {
    if (finished && !done) return;
    const text = render();
    if (!done && text === lastPosted) return;
    lastPosted = text;
    lastWriteAt = Date.now();
    await write({
      id: generateId(),
      in_reply_to: routing.inReplyTo,
      kind: 'turn_status',
      platform_id: routing.platformId,
      channel_type: routing.channelType,
      thread_id: routing.threadId,
      content: JSON.stringify({ text, done }),
    });
  };

  const schedule = (): void => {
    if (finished) return;
    const wait = Math.max(0, DEBOUNCE_MS - (Date.now() - lastWriteAt));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush(false).catch((err) => {
        console.error(
          `[turn-status] write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, wait);
  };

  return {
    async update(line: string): Promise<void> {
      if (finished || !line.trim()) return;
      const trimmed = line.trim();
      // Immediate flush for spawn_agent — that's the long wait the user cares about.
      const urgent = /\bspawn_agent\b/.test(trimmed);
      if (lines[lines.length - 1] === trimmed) {
        if (urgent) {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          await flush(false);
        }
        return;
      }
      lines.push(trimmed);
      if (urgent || lastPosted === '') {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        await flush(false);
      } else {
        schedule();
      }
    },

    async finish(finalLine?: string): Promise<void> {
      if (finished) return;
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Never posted anything user-visible — skip a lone "Done".
      if (lastPosted === '' && lines.length === 0) return;
      if (finalLine?.trim()) lines.push(finalLine.trim());
      else if (!lines.some((l) => l.startsWith('✓') || l === 'Done')) lines.push('Done');
      await flush(true);
    },
  };
}
