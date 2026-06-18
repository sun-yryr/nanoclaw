/**
 * Host-side command gate. Classifies inbound host commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Normal messages: pass through unchanged
 */
import { getDb, hasTable } from './db/connection.js';
import { readEnvFile } from './env.js';

export type GateResult = { action: 'pass' } | { action: 'filter' } | { action: 'deny'; command: string };

const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);
const DEFAULT_DISCORD_VOICE_COMMAND_PREFIX = '!nc voice';
let cachedDiscordVoiceCommandPrefix: string | undefined;

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  let text: string;
  try {
    const parsed = JSON.parse(content);
    text = (parsed.text || '').trim();
  } catch {
    text = content.trim();
  }

  if (isDiscordVoiceCommand(text)) return { action: 'filter' };

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

export function isDiscordVoiceCommand(text: string, prefix = getDiscordVoiceCommandPrefix()): boolean {
  const commandPrefix = prefix.trim();
  if (!commandPrefix) return false;

  const trimmed = text.trim();
  if (!trimmed.startsWith(commandPrefix)) return false;

  const next = trimmed.charAt(commandPrefix.length);
  return next === '' || /\s/.test(next);
}

function getDiscordVoiceCommandPrefix(): string {
  const processValue = process.env.DISCORD_VOICE_COMMAND_PREFIX?.trim();
  if (processValue) return processValue;

  if (cachedDiscordVoiceCommandPrefix !== undefined) return cachedDiscordVoiceCommandPrefix;

  const env = readEnvFile(['DISCORD_VOICE_COMMAND_PREFIX']);
  cachedDiscordVoiceCommandPrefix = env.DISCORD_VOICE_COMMAND_PREFIX?.trim() || DEFAULT_DISCORD_VOICE_COMMAND_PREFIX;
  return cachedDiscordVoiceCommandPrefix;
}

function isAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  if (!hasTable(getDb(), 'user_roles')) return true; // no permissions module = allow all
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM user_roles
       WHERE user_id = ?
         AND (role = 'owner' OR role = 'admin')
         AND (agent_group_id IS NULL OR agent_group_id = ?)
       LIMIT 1`,
    )
    .get(userId, agentGroupId);
  return row != null;
}
