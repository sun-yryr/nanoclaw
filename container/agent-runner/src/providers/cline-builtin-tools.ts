/**
 * Cline SDK built-in tools for the NanoClaw Cline provider.
 *
 * @cline/agents Agent does not ship host tools — they come from
 * @cline/core via createDefaultTools / createBuiltinTools. Some tools are
 * mutually exclusive in a single createDefaultTools call (editor vs
 * apply_patch; ask_question vs submit_and_exit), so we merge targeted
 * passes to expose the full documented suite.
 *
 * Skills follow OpenCode / Agent Skills progressive disclosure: Level-1
 * name+description live in the skills tool description; Level-2 SKILL.md
 * body loads on demand when the agent calls skills({ skill }).
 */
import {
  ALL_DEFAULT_TOOL_NAMES,
  createDefaultExecutors,
  createDefaultTools,
  createTool,
  type AgentTool,
} from '@cline/sdk';

import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import {
  defaultSkillRoots,
  findSkillInCatalog,
  formatAvailableSkillsXml,
  listSkillCatalog,
  loadSkillMarkdown,
  type SkillCatalogEntry,
} from '../skills/catalog.js';

const ASK_TIMEOUT_MS = 300_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
 * OpenCode-shaped skills tool: Level-1 catalog in description, Level-2 body on call.
 * Replaces the SDK default which only lists skill names.
 */
export function createSkillsTool(catalog: SkillCatalogEntry[]): AgentTool {
  const xml = formatAvailableSkillsXml(catalog);
  const description =
    'Load a skill by name to get full instructions for a specialized workflow. ' +
    'Match the user task against skill descriptions, then call this tool before acting. ' +
    'After loading, follow the skill body; read linked references/scripts only as needed.\n\n' +
    xml;

  return createTool({
    name: 'skills',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name from <available_skills> (directory / frontmatter name).',
        },
        args: {
          type: 'string',
          description: 'Optional arguments to append when loading the skill.',
        },
      },
      required: ['skill'],
    },
    execute: async ({ skill, args }: { skill: unknown; args?: unknown }) => {
      const name = String(skill ?? '').trim();
      const entry = findSkillInCatalog(catalog, name);
      if (!entry) {
        const available = catalog.map((e) => e.name).join(', ') || '(none)';
        throw new Error(`Skill "${name}" not found. Available: ${available}`);
      }
      const argStr = args == null || args === '' ? undefined : String(args);
      return loadSkillMarkdown(entry, argStr);
    },
  });
}

/**
 * Build the full Cline built-in tool suite documented at
 * https://docs.cline.bot/sdk/tools
 */
export function buildClineBuiltinTools(cwd: string): AgentTool[] {
  const catalog = listSkillCatalog(defaultSkillRoots(cwd));

  const executors = {
    ...createDefaultExecutors(),
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
    // SDK skills tool only exposes names — we inject OpenCode-shaped skills below.
    enableSkills: false,
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

  return mergeTools(main, patch, ask, [createSkillsTool(catalog)]);
}

export function expectedClineBuiltinToolNames(): readonly string[] {
  return ALL_DEFAULT_TOOL_NAMES;
}
