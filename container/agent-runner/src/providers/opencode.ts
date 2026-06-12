import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { jsonSchema, streamText, tool } from 'ai';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { memoryReadTool, memoryWriteTool } from '../memory-tools.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

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
      const client = new Client({ name: 'nanoclaw-opencode', version: '1.0.0' });
      await client.connect(transport);
      this.clients.push({ client, serverName });
      log(`MCP server connected: ${serverName}`);
    }
  }

  async buildTools(): Promise<Record<string, any>> {
    const tools: Record<string, any> = {};
    for (const { client, serverName } of this.clients) {
      const response = await client.listTools();
      for (const t of response.tools) {
        const toolName = `mcp__${serverName}__${t.name}`;
        log(`Registering tool: ${toolName}`);
        tools[toolName] = tool({
          description: t.description || '',
          parameters: jsonSchema(t.inputSchema as any),
          execute: async (args) => {
            log(`Executing tool: ${toolName} with args: ${JSON.stringify(args)}`);
            const result = await client.callTool({
              name: t.name,
              arguments: args as { [x: string]: unknown },
            });
            log(`Tool result: ${JSON.stringify(result).substring(0, 200)}...`);
            return JSON.stringify(result);
          },
        });
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

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  private messages: Array<{ role: string; content: string }> = [];
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
    log(`ENV: ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`);
    log(`ENV: OPENCODE_MODEL=${process.env.OPENCODE_MODEL}`);
    log(`ENV: OPENCODE_PROVIDER=${process.env.OPENCODE_PROVIDER}`);

    const baseURL = process.env.ANTHROPIC_BASE_URL;
    const modelId = process.env.OPENCODE_MODEL || 'opencode-go/kimi-k2.6';

    log(`Creating provider with baseURL=${baseURL}, modelId=${modelId}`);

    let provider;
    try {
      provider = createOpenAICompatible({
        name: 'opencode-go',
        apiKey: 'placeholder',
        baseURL: baseURL || '',
      });
      log('Provider created successfully');
    } catch (err) {
      log(`Failed to create provider: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    let model: ReturnType<typeof provider>;
    try {
      model = provider(modelId);
      log(`Model created successfully: ${modelId}`);
    } catch (err) {
      log(`Failed to create model: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    // Build the initial message list from the input prompt
    const systemInstructions = input.systemContext?.instructions;
    this.messages = [];
    if (systemInstructions) {
      this.messages.push({ role: 'system', content: systemInstructions });
      log(`System instructions added: ${systemInstructions.substring(0, 100)}...`);
    }
    // Inject memory management prompt
    this.messages.push({
      role: 'system',
      content:
        'You have a persistent memory system powered by mnemon. At the start of each conversation, use memory_read to recall relevant past context. ' +
        'When you learn something important about the user (preferences, facts, decisions, context), use memory_write to save it. ' +
        'Memory is stored as a knowledge graph with deduplication and linking — just pass the insight, the system handles the rest. ' +
        'Memory persists across sessions.',
    });
    this.messages.push({ role: 'user', content: input.prompt });
    log(`User prompt added: ${input.prompt.substring(0, 100)}...`);

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const kick = (): void => {
      waiting?.();
    };

    const self = this;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      log('gen() started');
      let mcpRegistry: McpToolRegistry | null = null;
      try {
        const continuation = crypto.randomUUID();
        log(`Yielding init with continuation=${continuation}`);
        yield { type: 'init', continuation };

        // Initialize MCP tools if configured
        let tools: Record<string, any> = {};
        if (Object.keys(self.mcpServers).length > 0) {
          mcpRegistry = new McpToolRegistry();
          await mcpRegistry.init(self.mcpServers);
          tools = await mcpRegistry.buildTools();
          log(`Loaded ${Object.keys(tools).length} MCP tools`);
        }
        // Inject memory tools
        tools['memory_read'] = memoryReadTool;
        tools['memory_write'] = memoryWriteTool;
        log('Memory tools injected');

        // Process the initial prompt immediately (it's already in messages)
        let firstTurn = true;

        while (firstTurn || pending.length > 0 || !ended) {
          if (aborted) {
            log('gen() aborted');
            return;
          }

          // Wait for follow-up messages on subsequent turns
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
            self.messages.push({ role: 'user', content: userText });
            log(`Processing follow-up: ${userText.substring(0, 100)}...`);
          }

          firstTurn = false;

          log(`Calling streamText with ${self.messages.length} messages`);
          let result;
          try {
            result = streamText({
              model,
              messages: self.messages as any,
              tools: Object.keys(tools).length > 0 ? tools : undefined,
              maxSteps: 5,
            });
            log('streamText() returned');
          } catch (err) {
            log(`streamText() threw: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
          }

          let fullText = '';
          let chunkCount = 0;
          try {
            log('Starting to iterate textStream...');
            for await (const chunk of result.textStream) {
              if (aborted) {
                log('gen() aborted during stream');
                return;
              }
              fullText += chunk;
              chunkCount++;
              yield { type: 'activity' };
            }
            log(`Stream completed: ${chunkCount} chunks, ${fullText.length} chars`);
          } catch (err) {
            log(`textStream iteration threw: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
          }

          self.messages.push({ role: 'assistant', content: fullText });
          log(`Yielding result: ${fullText.substring(0, 100)}...`);
          yield { type: 'result', text: fullText };
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
        self.messages = [];
        kick();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
