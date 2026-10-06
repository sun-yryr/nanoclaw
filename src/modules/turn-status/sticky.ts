/**
 * Sticky turn-status delivery — one channel message per session destination,
 * edited in place as the agent-runner posts `kind: 'turn_status'` updates.
 *
 * Used so long spawn_agent / tool runs show progressive Discord status without
 * flooding the channel. In-memory only: a host restart just starts a new sticky
 * bubble on the next update (acceptable for progress UI).
 */
const stickyIds = new Map<string, string>();

export function turnStatusKey(sessionId: string, platformId: string, threadId: string | null | undefined): string {
  return `${sessionId}:${platformId}:${threadId ?? ''}`;
}

export function getStickyTurnStatusId(key: string): string | undefined {
  return stickyIds.get(key);
}

export function setStickyTurnStatusId(key: string, platformMessageId: string): void {
  stickyIds.set(key, platformMessageId);
}

export function clearStickyTurnStatus(key: string): void {
  stickyIds.delete(key);
}

/** Test helper — drop all sticky slots. */
export function resetStickyTurnStatus(): void {
  stickyIds.clear();
}
