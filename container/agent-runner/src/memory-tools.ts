import { tool, jsonSchema } from 'ai';
import { spawnSync } from 'child_process';

function log(msg: string): void {
  console.error(`[memory-tools] ${msg}`);
}

function runMnemon(args: string[], input?: string): { success: boolean; stdout: string; stderr: string } {
  const result = spawnSync('mnemon', args, {
    input: input ?? '',
    encoding: 'utf-8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const success = result.status === 0;
  if (!success) {
    log(`mnemon ${args.join(' ')} failed: ${stderr || stdout}`);
  } else {
    log(`mnemon ${args.join(' ')} succeeded (${stdout.length} chars)`);
  }
  return { success, stdout, stderr };
}

export const memoryReadTool = tool({
  description:
    'Recall relevant memories from the persistent knowledge graph. Use this at the start of each conversation to surface past context. ' +
    'Pass the user query or task description as the query. Returns structured JSON with relevant insights.',
  parameters: jsonSchema({
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The topic or question to search memory for. E.g., user preferences, past decisions, project context.',
      },
    },
    required: ['query'],
  }),
  execute: async ({ query }) => {
    const result = runMnemon(['recall', query]);
    if (!result.success) {
      return `Memory recall failed: ${result.stderr || result.stdout}`;
    }
    if (!result.stdout.trim()) {
      return 'No relevant memories found.';
    }
    return result.stdout;
  },
});

export const memoryWriteTool = tool({
  description:
    'Save a new insight or update an existing memory in the persistent knowledge graph. Use this when you learn something important ' +
    'about the user (preferences, facts, decisions, context) that should persist across sessions. ' +
    'Pass the insight as a concise, factual statement. The binary handles deduplication and linking automatically.',
  parameters: jsonSchema({
    type: 'object',
    properties: {
      insight: {
        type: 'string',
        description: 'The factual insight to remember. E.g., "User prefers TypeScript over Python" or "Project deadline is June 30"',
      },
    },
    required: ['insight'],
  }),
  execute: async ({ insight }) => {
    const result = runMnemon(['remember', insight]);
    if (!result.success) {
      return `Memory save failed: ${result.stderr || result.stdout}`;
    }
    return 'Memory saved successfully.';
  },
});
