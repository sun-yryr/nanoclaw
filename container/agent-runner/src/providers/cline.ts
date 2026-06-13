import { Agent, createTool } from '@cline/sdk';
import type { AgentRunResult, AgentRuntimeEvent, AgentRuntimeStateSnapshot } from '@cline/agents';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'child_process';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[cline-provider] ${msg}`);
}

// ── Memory tools (inline to avoid ai-sdk / cline-sdk type mismatch) ──

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

const memoryReadTool = createTool({
  name: 'memory_read',
  description:
    'Recall relevant memories from the persistent knowledge graph. Use this at the start of each conversation to surface past context. ' +
    'Pass the user query or task description as the query. Returns structured JSON with relevant insights.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The topic or question to search memory for. E.g., user preferences, past decisions, project context.',
      },
    },
    required: ['query'],
  },
  execute: async ({ query }: { query: unknown }) => {
    const result = runMnemon(['recall', query as string]);
    if (!result.success) {
      return `Memory recall failed: ${result.stderr || result.stdout}`;
    }
    if (!result.stdout.trim()) {
      return 'No relevant memories found.';
    }
    return result.stdout;
  },
});

const memoryWriteTool = createTool({
  name: 'memory_write',
  description:
    'Save a new insight or update an existing memory in the persistent knowledge graph. Use this when you learn something important ' +
    'about the user (preferences, facts, decisions, context) that should persist across sessions. ' +
    'Pass the insight as a concise, factual statement. The binary handles deduplication and linking automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      insight: {
        type: 'string',
        description: 'The factual insight to remember. E.g., "User prefers TypeScript over Python" or "Project deadline is June 30"',
      },
    },
    required: ['insight'],
  },
  execute: async ({ insight }: { insight: unknown }) => {
    const result = runMnemon(['remember', insight as string]);
    if (!result.success) {
      return `Memory save failed: ${result.stderr || result.stdout}`;
    }
    return 'Memory saved successfully.';
  },
});

// ── MCP Tool Registry ──

interface McpClientEntry {
  client: Client;
  serverName: string;
}

class McpToolRegistry {
  private clients: McpClientEntry[] = [];

  async init(servers: Record<string, McpServerConfig>): Promise<void> {
    for (const [serverName, cfg] of Object.entries(servers)) {
      log(`Starting MCP server: ${serverName} (${cfg.command})`);
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: { ...process.env, ...cfg.env } as Record<string, string>,
      });
      const client = new Client({ name: 'nanoclaw-cline', version: '1.0.0' });
      await client.connect(transport);
      this.clients.push({ client, serverName });
      log(`MCP server connected: ${serverName}`);
    }
  }

  async buildTools(): Promise<ReturnType<typeof createTool>[]> {
    const tools: ReturnType<typeof createTool>[] = [];
    for (const { client, serverName } of this.clients) {
      const response = await client.listTools();
      for (const t of response.tools) {
        const toolName = `mcp__${serverName}__${t.name}`;
        log(`Registering tool: ${toolName}`);
        tools.push(
          createTool({
            name: toolName,
            description: t.description || '',
            inputSchema: t.inputSchema as Record<string, unknown>,
            execute: async (args: unknown) => {
              log(`Executing tool: ${toolName} with args: ${JSON.stringify(args)}`);
              const result = await client.callTool({
                name: t.name,
                arguments: args as { [x: string]: unknown },
              });
              log(`Tool result: ${JSON.stringify(result).substring(0, 200)}...`);
              return JSON.stringify(result);
            },
          }),
        );
      }
    }
    return tools;
  }

  async close(): Promise<void> {
    for (const { client } of this.clients) {
      try {
        await client.close();
      } catch (err) {
        log(`Error closing MCP client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.clients = [];
  }
}

// ── Provider ──

export class ClineProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private mcpServers: Record<string, McpServerConfig>;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /no conversation found|session.*not found|NotFoundError|401|403|Unauthorized|api key|model not found/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    log('query() called');
    log(`ENV: OPENCODE_GO_API_KEY=${process.env.OPENCODE_GO_API_KEY ? '***' : 'undefined'}`);
    log(`ENV: ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`);
    log(`ENV: CLINE_MODEL=${process.env.CLINE_MODEL}`);
    log(`ENV: OPENCODE_MODEL=${process.env.OPENCODE_MODEL}`);

    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://opencode.ai/zen/go/v1';
    const modelId = process.env.CLINE_MODEL || process.env.OPENCODE_MODEL || 'opencode-go/kimi-k2.6';
    // OneCLI generic-secret proxy overwrites the Authorization header on the
    // wire, so the container only needs a placeholder value to make the SDK
    // emit the header in the first place.
    const apiKey = process.env.OPENCODE_GO_API_KEY || 'placeholder';

    log(`Creating Agent with baseUrl=${baseUrl}, modelId=${modelId}`);

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const events: ProviderEvent[] = [];
    let eventWaiting: (() => void) | null = null;

    const kick = (): void => {
      waiting?.();
    };

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      log('gen() started');
      let mcpRegistry: McpToolRegistry | null = null;
      try {
        let tools: any[] = [memoryReadTool, memoryWriteTool];
        if (Object.keys(self.mcpServers).length > 0) {
          mcpRegistry = new McpToolRegistry();
          await mcpRegistry.init(self.mcpServers);
          const mcpTools = await mcpRegistry.buildTools();
          tools = [...tools, ...mcpTools];
          log(`Loaded ${mcpTools.length} MCP tools`);
        }

        const agent = new Agent({
          providerId: 'openai-compatible',
          modelId,
          apiKey,
          baseUrl,
          systemPrompt: input.systemContext?.instructions,
          tools,
          maxIterations: 10,
        });

        // Restore previous conversation if continuation is provided
        if (input.continuation) {
          try {
            const snapshot = JSON.parse(input.continuation) as AgentRuntimeStateSnapshot;
            if (snapshot.messages && snapshot.messages.length > 0) {
              agent.restore(snapshot.messages);
              log(`Restored ${snapshot.messages.length} messages from continuation`);
            }
          } catch (err) {
            log(`Failed to restore continuation: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        agent.subscribe((event: AgentRuntimeEvent) => {
          if (aborted) return;
          let providerEvent: ProviderEvent | null = null;

          switch (event.type) {
            case 'run-started':
            case 'turn-started':
            case 'tool-started':
            case 'tool-finished':
            case 'usage-updated':
            case 'message-added':
            case 'turn-finished':
            case 'assistant-text-delta':
            case 'assistant-reasoning-delta':
              providerEvent = { type: 'activity' };
              break;
            case 'assistant-message':
              providerEvent = { type: 'activity' };
              break;
            case 'run-finished': {
              const result = (event as any).result;
              providerEvent = { type: 'result', text: result?.outputText ?? null };
              break;
            }
            case 'run-failed': {
              const error = (event as any).error;
              providerEvent = { type: 'error', message: error?.message ?? 'Run failed', retryable: true };
              break;
            }
            case 'status-notice': {
              const notice = (event as any).message;
              providerEvent = { type: 'progress', message: notice || 'Status notice' };
              break;
            }
          }

          if (providerEvent) {
            events.push(providerEvent);
            eventWaiting?.();
          }
        });

        const continuation = JSON.stringify(agent.snapshot());
        log(`Yielding init with continuation length=${continuation.length}`);
        yield { type: 'init', continuation };

        // ── First turn ──
        let runDone = false;
        let runResult: Awaited<ReturnType<typeof agent.run>> | undefined;
        const runPromise = agent.run(input.prompt).then((r: AgentRunResult) => {
          runDone = true;
          runResult = r;
          eventWaiting?.();
          return r;
        });

        while (!runDone) {
          while (events.length > 0) {
            yield events.shift()!;
          }
          if (runDone) break;
          await new Promise<void>((r) => {
            eventWaiting = r;
          });
        }

        while (events.length > 0) {
          yield events.shift()!;
        }

        if (runResult) {
          if (runResult.status !== 'completed') {
            yield { type: 'error', message: runResult.error?.message ?? 'Run failed', retryable: true };
          }
        }

        // ── Follow-up turns ──
        let firstTurn = true;
        while (firstTurn || pending.length > 0 || !ended) {
          if (aborted) {
            log('gen() aborted');
            return;
          }

          if (!firstTurn) {
            while (pending.length === 0 && !ended && !aborted) {
              log('gen() waiting for input...');
              await new Promise<void>((resolve) => {
                waiting = resolve;
              });
              waiting = null;
            }

            if (aborted) {
              log('gen() aborted after wait');
              return;
            }
            if (pending.length === 0 && ended) {
              log('gen() ended');
              break;
            }

            const userText = pending.shift()!;
            log(`Processing follow-up: ${userText.substring(0, 100)}...`);

            let continueDone = false;
            let continueResult: Awaited<ReturnType<typeof agent.continue>> | undefined;
            const continuePromise = agent.continue(userText).then((r: AgentRunResult) => {
              continueDone = true;
              continueResult = r;
              eventWaiting?.();
              return r;
            });

            while (!continueDone) {
              while (events.length > 0) {
                yield events.shift()!;
              }
              if (continueDone) break;
              await new Promise<void>((r) => {
                eventWaiting = r;
              });
            }

            while (events.length > 0) {
              yield events.shift()!;
            }

            if (continueResult) {
              if (continueResult.status !== 'completed') {
                yield { type: 'error', message: continueResult.error?.message ?? 'Continue failed', retryable: true };
              }
            }
          }

          firstTurn = false;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`gen() caught error: ${message}`);
        yield { type: 'error', message, retryable: true };
      } finally {
        if (mcpRegistry) {
          await mcpRegistry.close();
          log('MCP registry closed');
        }
      }
      log('gen() exiting');
    }

    return {
      push: (message: string) => {
        log(`push() called: ${message.substring(0, 100)}...`);
        pending.push(message);
        kick();
      },
      end: () => {
        log('end() called');
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        log('abort() called');
        aborted = true;
        kick();
      },
    };
  }
}

registerProvider('cline', (opts) => new ClineProvider(opts));
