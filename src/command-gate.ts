/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Normal messages: pass through unchanged
 */
import { hasAdminPrivilege } from './modules/permissions/db/user-roles.js';
import { readEnvFile } from './env.js';
import './provider-contracts/index.js';
import { listProviderHostContracts } from './provider-contracts/registry.js';

export type GateResult = { action: 'pass' } | { action: 'filter' } | { action: 'deny'; command: string };

const FILTERED_COMMANDS = new Set(
  listProviderHostContracts().flatMap((contract) => contract.commands?.nativeFiltered ?? []),
);
const ADMIN_COMMANDS = new Set([
  '/clear',
  '/upload-trace',
  ...listProviderHostContracts().flatMap((contract) => contract.commands?.nativeAdmin ?? []),
]);
const DEFAULT_DISCORD_VOICE_COMMAND_PREFIX = '!nc voice';
let cachedDiscordVoiceCommandPrefix: string | undefined;

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands,
 * 'filter' for silently-dropped commands, 'deny' for unauthorized
 * admin commands.
 */
export async function gateCommand(content: string, userId: string | null, agentGroupId: string): Promise<GateResult> {
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
    if (await isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

async function isAdmin(userId: string | null, agentGroupId: string): Promise<boolean> {
  if (!userId) return false;
  return hasAdminPrivilege(userId, agentGroupId);
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
