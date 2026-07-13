/**
 * On-disk Cline session transcripts — Claude-shaped resume.
 *
 * Claude stores an opaque session id in outbound.db and the conversation body
 * under ~/.claude/projects/.../<id>.jsonl. Cline mirrors that: opaque id in DB,
 * snapshot JSON under ~/.claude/cline-sessions/<id>.json (same CLAUDE_CONFIG_DIR
 * / .claude-shared mount, so it survives container restarts).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AgentRuntimeStateSnapshot } from '@cline/agents';

function log(msg: string): void {
  console.error(`[cline-sessions] ${msg}`);
}

/** UUID (any version) — continuation token shape. Rejects legacy inline JSON blobs. */
const OPAQUE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOpaqueSessionId(value: string): boolean {
  return OPAQUE_SESSION_ID_RE.test(value);
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
}

export function clineSessionsDir(): string {
  return path.join(claudeConfigDir(), 'cline-sessions');
}

export function sessionTranscriptPath(sessionId: string): string {
  return path.join(clineSessionsDir(), `${sessionId}.json`);
}

function transcriptRotateBytes(): number {
  return Number(process.env.CLINE_TRANSCRIPT_ROTATE_BYTES) || 12 * 1024 * 1024;
}

function transcriptRotateAgeMs(): number {
  const raw = process.env.CLINE_TRANSCRIPT_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  return days > 0 ? days * 86_400_000 : Infinity;
}

/** True when continuation is the pre-fix inline JSON snapshot stored in session_state. */
export function isLegacyInlineContinuation(continuation: string): boolean {
  const trimmed = continuation.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

export function loadSessionSnapshot(sessionId: string): AgentRuntimeStateSnapshot | null {
  const filePath = sessionTranscriptPath(sessionId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as AgentRuntimeStateSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    log(`Failed to load ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Atomic write of the agent snapshot for a session id. */
export function saveSessionSnapshot(sessionId: string, snapshot: AgentRuntimeStateSnapshot): void {
  const dir = clineSessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = sessionTranscriptPath(sessionId);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf-8');
  fs.renameSync(tmp, filePath);
  const msgCount = Array.isArray(snapshot.messages) ? snapshot.messages.length : 0;
  log(`Wrote ${filePath} (${msgCount} messages)`);
}

/**
 * Decide whether a stored continuation should be dropped before resume.
 * Returns a human-readable reason, or null to keep the session.
 */
export function maybeRotateClineContinuation(continuation: string): string | null {
  if (isLegacyInlineContinuation(continuation)) {
    return 'legacy inline snapshot in session_state';
  }
  if (!isOpaqueSessionId(continuation)) {
    return 'malformed continuation id';
  }

  const filePath = sessionTranscriptPath(continuation);
  if (!fs.existsSync(filePath)) {
    // Missing file: let query start fresh (init will overwrite the id). Don't
    // treat as rotate-with-archive — there's nothing to archive.
    return 'missing transcript file';
  }

  let size: number;
  let mtimeMs: number;
  try {
    const st = fs.statSync(filePath);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return 'unreadable transcript file';
  }

  const maxBytes = transcriptRotateBytes();
  const maxAgeMs = transcriptRotateAgeMs();
  const ageMs = Date.now() - mtimeMs;

  let reason: string | null = null;
  if (size > maxBytes) {
    reason = `transcript ${(size / 1_048_576).toFixed(1)}MB > ${(maxBytes / 1_048_576).toFixed(0)}MB cap`;
  } else if (ageMs > maxAgeMs) {
    reason = `transcript ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
  }
  if (!reason) return null;

  try {
    fs.renameSync(filePath, `${filePath}.rotated-${Date.now()}`);
  } catch (err) {
    log(`Failed to move rotated transcript aside: ${err instanceof Error ? err.message : String(err)}`);
  }
  return reason;
}
