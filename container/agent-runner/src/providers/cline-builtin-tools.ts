/**
 * Cline SDK built-in tools for the NanoClaw Cline provider.
 *
 * @cline/agents Agent does not ship host tools — they come from
 * @cline/core via createDefaultTools / createBuiltinTools. Some tools are
 * mutually exclusive in a single createDefaultTools call (editor vs
 * apply_patch; ask_question vs submit_and_exit), so we merge targeted
 * passes to expose the full documented suite.
 */
import fs from 'fs';
import path from 'path';

import {
  ALL_DEFAULT_TOOL_NAMES,
  createDefaultExecutors,
  createDefaultTools,
  type AgentTool,
} from '@cline/sdk';

import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';

const SKILL_SEARCH_DIRS = ['/app/skills'];
const ASK_TIMEOUT_MS = 300_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface SkillMeta {
  id: string;
  name: string;
  disabled: boolean;
}

type SkillsExecutor = ((skill: string, args: string | undefined) => Promise<string>) & {
  configuredSkills?: SkillMeta[];
};

function discoverSkills(cwd: string): SkillsExecutor {
  const configuredSkills: SkillMeta[] = [];
  const roots = [...SKILL_SEARCH_DIRS, path.join(cwd, 'skills')];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const skillDir = path.join(root, entry);
      if (!fs.statSync(skillDir).isDirectory()) continue;
      const skillMd = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      configuredSkills.push({ id: entry, name: entry, disabled: false });
    }
  }

  const executor = (async (skill: string, args: string | undefined) => {
    const normalized = skill.trim().toLowerCase();
    for (const root of roots) {
      const skillMd = path.join(root, skill, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        const body = fs.readFileSync(skillMd, 'utf-8');
        return args ? `${body}\n\n---\nArguments: ${args}` : body;
      }
    }
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        if (entry.toLowerCase() !== normalized) continue;
        const skillMd = path.join(root, entry, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          const body = fs.readFileSync(skillMd, 'utf-8');
          return args ? `${body}\n\n---\nArguments: ${args}` : body;
        }
      }
    }
    const available = configuredSkills.map((s: SkillMeta) => s.name).join(', ') || '(none)';
    throw new Error(`Skill "${skill}" not found. Available: ${available}`);
  }) as SkillsExecutor;

  executor.configuredSkills = configuredSkills;
  return executor;
}

async function askQuestionViaChannel(question: string, options: string[]): Promise<string> {
  if (options.length < 2) {
    throw new Error('ask_question requires at least 2 options');
  }

  const questionId = generateId();
  const routing = getSessionRouting();
  const cardOptions = options.map((label) => ({ label, selectedLabel: label, value: label }));

  writeMessageOut({
    id: questionId,
    kind: 'chat-sdk',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id,
    content: JSON.stringify({
      type: 'ask_question',
      questionId,
      title: 'Question',
      question,
      options: cardOptions,
    }),
  });

  const deadline = Date.now() + ASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = findQuestionResponse(questionId);
    if (response) {
      markCompleted([response.id]);
      const parsed = JSON.parse(response.content) as { selectedOption?: string };
      if (parsed.selectedOption) return parsed.selectedOption;
      return response.content;
    }
    await sleep(1000);
  }

  throw new Error(`Question timed out after ${ASK_TIMEOUT_MS / 1000}s`);
}

function mergeTools(...groups: AgentTool[][]): AgentTool[] {
  const byName = new Map<string, AgentTool>();
  for (const group of groups) {
    for (const tool of group) {
      byName.set(tool.name, tool);
    }
  }
  return [...byName.values()];
}

/**
 * Build the full Cline built-in tool suite documented at
 * https://docs.cline.bot/sdk/tools
 */
export function buildClineBuiltinTools(cwd: string): AgentTool[] {
  const executors = {
    ...createDefaultExecutors(),
    skills: discoverSkills(cwd),
    askQuestion: askQuestionViaChannel,
    submit: async (summary: string, _verified: boolean) => summary,
  };

  const shared = {
    executors,
    cwd,
    enableReadFiles: true,
    enableSearch: true,
    enableBash: true,
    enableWebFetch: true,
    enableSkills: true,
  } as const;

  const disabled = {
    enableReadFiles: false,
    enableSearch: false,
    enableBash: false,
    enableWebFetch: false,
    enableSkills: false,
    enableAskQuestion: false,
    enableSubmitAndExit: false,
    enableApplyPatch: false,
    enableEditor: false,
  } as const;

  const main = createDefaultTools({
    ...shared,
    enableEditor: true,
    enableApplyPatch: false,
    enableAskQuestion: false,
    enableSubmitAndExit: true,
  });

  const patch = createDefaultTools({
    ...shared,
    ...disabled,
    enableApplyPatch: true,
  });

  const ask = createDefaultTools({
    ...shared,
    ...disabled,
    enableAskQuestion: true,
  });

  return mergeTools(main, patch, ask);
}

export function expectedClineBuiltinToolNames(): readonly string[] {
  return ALL_DEFAULT_TOOL_NAMES;
}
