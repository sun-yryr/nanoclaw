/**
 * Cap repeated MCP tool failures so models cannot burn turns retrying the
 * same broken call (e.g. brave SUBSCRIPTION_TOKEN_INVALID, send_message db lock).
 *
 * Limits are per Agent/query lifetime (one McpToolRegistry). Shared across
 * parent and spawn children that reuse the same tool execute wrappers.
 */

/** Same tool + same args may fail this many times before further calls are blocked. */
export const MCP_SAME_ARGS_FAILURE_LIMIT = 2;

/** Same tool (any args) may fail this many times before further calls are blocked. */
export const MCP_TOOL_FAILURE_LIMIT = 5;

export function stableArgsKey(args: unknown): string {
  try {
    return JSON.stringify(args ?? null, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
        return sorted;
      }
      return value;
    });
  } catch {
    return String(args);
  }
}

/** Heuristic: MCP execute returned a failure payload (not a thrown error). */
export function isMcpFailureResult(result: unknown): boolean {
  if (result == null) return false;
  if (typeof result !== 'string') {
    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      if (obj.isError === true || obj.error != null) return true;
    }
    return false;
  }
  const text = result.trim();
  if (!text) return false;
  if (/^error\b/i.test(text)) return true;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      if (parsed.isError === true) return true;
      if (typeof parsed.error === 'string' && parsed.error.trim()) return true;
      if (parsed.error && typeof parsed.error === 'object') return true;
      // MCP SDK envelope: { content: [{ type:'text', text:'...error...' }], isError?: bool }
      if (Array.isArray(parsed.content)) {
        const blob = JSON.stringify(parsed.content);
        if (
          /SUBSCRIPTION_TOKEN_INVALID|invalid_request_error|database is locked|MCP error\s*-?\d+/i.test(
            blob,
          )
        ) {
          return true;
        }
      }
    }
  } catch {
    // plain text
  }
  return /SUBSCRIPTION_TOKEN_INVALID|database is locked|MCP error\s*-?\d+/i.test(text);
}

export function retryLimitMessage(
  toolName: string,
  kind: 'same-args' | 'tool',
  failures: number,
  limit: number,
): string {
  const scope = kind === 'same-args' ? 'with the same arguments' : 'for this tool';
  return JSON.stringify({
    error: `Retry limit reached: ${toolName} failed ${failures} time(s) ${scope} (limit ${limit}). Do not call this tool again with the same approach. Report the failure to the parent/user or try a different tool/query.`,
    toolName,
    failures,
    limit,
    kind,
  });
}

export class McpRetryGuard {
  private readonly sameArgsFailures = new Map<string, number>();
  private readonly toolFailures = new Map<string, number>();
  private readonly sameArgsLimit: number;
  private readonly toolLimit: number;

  constructor(
    opts: { sameArgsLimit?: number; toolLimit?: number } = {},
  ) {
    this.sameArgsLimit = opts.sameArgsLimit ?? MCP_SAME_ARGS_FAILURE_LIMIT;
    this.toolLimit = opts.toolLimit ?? MCP_TOOL_FAILURE_LIMIT;
  }

  /**
   * Run an MCP execute. On repeated failures with the same args (or too many
   * failures for the tool), skip the call and return a structured error string.
   */
  async run(toolName: string, args: unknown, execute: () => Promise<unknown>): Promise<unknown> {
    const argsKey = `${toolName}\0${stableArgsKey(args)}`;
    const sameCount = this.sameArgsFailures.get(argsKey) ?? 0;
    if (sameCount >= this.sameArgsLimit) {
      return retryLimitMessage(toolName, 'same-args', sameCount, this.sameArgsLimit);
    }
    const toolCount = this.toolFailures.get(toolName) ?? 0;
    if (toolCount >= this.toolLimit) {
      return retryLimitMessage(toolName, 'tool', toolCount, this.toolLimit);
    }

    try {
      const result = await execute();
      if (isMcpFailureResult(result)) {
        this.recordFailure(toolName, argsKey);
      } else {
        this.sameArgsFailures.delete(argsKey);
      }
      return result;
    } catch (err) {
      this.recordFailure(toolName, argsKey);
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `MCP error: ${message}`, toolName });
    }
  }

  private recordFailure(toolName: string, argsKey: string): void {
    this.sameArgsFailures.set(argsKey, (this.sameArgsFailures.get(argsKey) ?? 0) + 1);
    this.toolFailures.set(toolName, (this.toolFailures.get(toolName) ?? 0) + 1);
  }

  /** Test helpers */
  sameArgsFailureCount(toolName: string, args: unknown): number {
    return this.sameArgsFailures.get(`${toolName}\0${stableArgsKey(args)}`) ?? 0;
  }

  toolFailureCount(toolName: string): number {
    return this.toolFailures.get(toolName) ?? 0;
  }
}
