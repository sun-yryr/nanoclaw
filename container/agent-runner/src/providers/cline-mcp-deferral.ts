/**
 * Cline MCP tool deferral — Claude ToolSearch-shaped progressive disclosure.
 *
 * All AgentTool execute handlers stay registered on the Agent. beforeModel
 * only exposes always-load tools + previously activated deferred tools +
 * `tool_search`. Searching activates matches for subsequent model calls.
 */
import { createTool, type AgentTool } from '@cline/sdk';
import type {
  AgentBeforeModelResult,
  AgentBeforeToolResult,
  AgentRuntimeHooks,
  AgentToolDefinition,
} from '@cline/agents';

type BeforeModelContext = Parameters<NonNullable<AgentRuntimeHooks['beforeModel']>>[0];
type BeforeToolContext = Parameters<NonNullable<AgentRuntimeHooks['beforeTool']>>[0];

export const TOOL_SEARCH_NAME = 'tool_search';

/** Built-in NanoClaw MCP server — small and required every turn. */
export const ALWAYS_LOAD_MCP_SERVERS = new Set(['nanoclaw']);

const MCP_TOOL_PREFIX = 'mcp__';

export interface DeferredMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP server name from `mcp__<server>__<tool>`. */
  serverName: string;
}

export function parseMcpToolName(name: string): { serverName: string; toolName: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep === rest.length - 2) return null;
  const serverName = rest.slice(0, sep);
  const toolName = rest.slice(sep + 2);
  if (!serverName || !toolName) return null;
  return { serverName, toolName };
}

export function isAlwaysLoadTool(name: string): boolean {
  if (name === TOOL_SEARCH_NAME) return true;
  const mcp = parseMcpToolName(name);
  if (!mcp) return true; // builtins / memory / non-MCP
  return ALWAYS_LOAD_MCP_SERVERS.has(mcp.serverName);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatDeferredToolsCatalogXml(tools: readonly DeferredMcpTool[]): string {
  if (tools.length === 0) {
    return '<available_mcp_tools>\n</available_mcp_tools>';
  }
  const body = tools
    .map(
      (t) =>
        `  <tool>\n    <name>${escapeXml(t.name)}</name>\n    <server>${escapeXml(t.serverName)}</server>\n    <description>${escapeXml(t.description)}</description>\n  </tool>`,
    )
    .join('\n');
  return `<available_mcp_tools>\n${body}\n</available_mcp_tools>`;
}

function toDefinition(tool: AgentTool | AgentToolDefinition): AgentToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.lifecycle ? { lifecycle: tool.lifecycle } : {}),
  };
}

export function partitionTools(tools: readonly AgentTool[]): {
  alwaysLoad: AgentTool[];
  deferred: DeferredMcpTool[];
  deferredByName: Map<string, AgentTool>;
} {
  const alwaysLoad: AgentTool[] = [];
  const deferred: DeferredMcpTool[] = [];
  const deferredByName = new Map<string, AgentTool>();

  for (const tool of tools) {
    if (isAlwaysLoadTool(tool.name)) {
      alwaysLoad.push(tool);
      continue;
    }
    const parsed = parseMcpToolName(tool.name);
    if (!parsed) {
      alwaysLoad.push(tool);
      continue;
    }
    deferred.push({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema,
      serverName: parsed.serverName,
    });
    deferredByName.set(tool.name, tool);
  }

  deferred.sort((a, b) => a.name.localeCompare(b.name));
  return { alwaysLoad, deferred, deferredByName };
}

export function matchDeferredTools(tools: readonly DeferredMcpTool[], query: string): DeferredMcpTool[] {
  const q = query.trim().toLowerCase();
  if (!q || q === '*') return [];
  return tools.filter((t) => {
    const hay = `${t.name} ${t.serverName} ${t.description}`.toLowerCase();
    return hay.includes(q) || q.split(/\s+/).every((token) => token && hay.includes(token));
  });
}

export class McpToolDeferral {
  readonly alwaysLoad: AgentTool[];
  readonly deferred: DeferredMcpTool[];
  private readonly deferredByName: Map<string, AgentTool>;
  private readonly activated = new Set<string>();
  readonly toolSearch: AgentTool;

  constructor(tools: readonly AgentTool[]) {
    const parts = partitionTools(tools);
    this.alwaysLoad = parts.alwaysLoad;
    this.deferred = parts.deferred;
    this.deferredByName = parts.deferredByName;
    this.toolSearch = this.createToolSearchTool();
  }

  get activatedNames(): ReadonlySet<string> {
    return this.activated;
  }

  activate(names: readonly string[]): string[] {
    const added: string[] = [];
    for (const name of names) {
      if (!this.deferredByName.has(name)) continue;
      if (this.activated.has(name)) continue;
      this.activated.add(name);
      added.push(name);
    }
    return added;
  }

  isDeferred(name: string): boolean {
    return this.deferredByName.has(name);
  }

  isActivated(name: string): boolean {
    return this.activated.has(name);
  }

  selectToolsForModel(): AgentToolDefinition[] {
    const defs: AgentToolDefinition[] = this.alwaysLoad.map(toDefinition);
    defs.push(toDefinition(this.toolSearch));
    for (const name of [...this.activated].sort()) {
      const tool = this.deferredByName.get(name);
      if (tool) defs.push(toDefinition(tool));
    }
    return defs;
  }

  /** Full AgentTool list for Agent construction (execute registry). */
  allRegisteredTools(): AgentTool[] {
    return [...this.alwaysLoad, this.toolSearch, ...this.deferredByName.values()];
  }

  beforeModel(_context: BeforeModelContext): AgentBeforeModelResult {
    return { tools: this.selectToolsForModel() };
  }

  beforeTool(context: BeforeToolContext): AgentBeforeToolResult | undefined {
    const name = context.tool.name;
    if (!this.isDeferred(name)) return undefined;
    if (this.isActivated(name)) return undefined;
    return {
      skip: true,
      reason:
        `Tool "${name}" is deferred. Call ${TOOL_SEARCH_NAME} with a query matching this tool ` +
        `(e.g. its server or name) to load its schema, then retry.`,
    };
  }

  createHooks(): Pick<AgentRuntimeHooks, 'beforeModel' | 'beforeTool'> {
    return {
      beforeModel: (ctx: BeforeModelContext) => this.beforeModel(ctx),
      beforeTool: (ctx: BeforeToolContext) => this.beforeTool(ctx),
    };
  }

  private createToolSearchTool(): AgentTool {
    const catalog = formatDeferredToolsCatalogXml(this.deferred);
    const description =
      'Search and activate deferred MCP tools. Level-1 catalog lists name + description only; ' +
      'calling this tool with a non-empty query activates matching tools so their full input schemas ' +
      'appear on the next model turn and you can call them by their real mcp__<server>__<tool> names. ' +
      'Empty query or "*" returns the catalog without activating anything.\n\n' +
      catalog;

    return createTool({
      name: TOOL_SEARCH_NAME,
      description,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Substring to match against deferred tool names, server names, or descriptions. ' +
              'Empty or "*" lists the catalog without activating tools.',
          },
        },
        required: ['query'],
      },
      execute: async ({ query }: { query: unknown }) => {
        const q = String(query ?? '');
        const trimmed = q.trim();
        if (!trimmed || trimmed === '*') {
          return [
            'Deferred MCP tool catalog (not activated). Re-call with a specific query to load schemas.',
            catalog,
          ].join('\n\n');
        }

        const matches = matchDeferredTools(this.deferred, trimmed);
        if (matches.length === 0) {
          return `No deferred MCP tools matched query ${JSON.stringify(trimmed)}. Catalog:\n\n${catalog}`;
        }

        const activated = this.activate(matches.map((m) => m.name));
        const schemas = matches.map((m) => ({
          name: m.name,
          description: m.description,
          inputSchema: m.inputSchema,
          newlyActivated: activated.includes(m.name),
        }));

        return JSON.stringify(
          {
            query: trimmed,
            activatedCount: activated.length,
            activated,
            tools: schemas,
            note: 'These tools are now available by name on the next model turn.',
          },
          null,
          2,
        );
      },
    });
  }
}

/**
 * Run deferral beforeModel first so model-io dumps the filtered tool set,
 * then forward other model-io hooks unchanged.
 */
export function composeDeferralAndModelIoHooks(
  deferral: McpToolDeferral,
  modelIo: AgentRuntimeHooks,
): AgentRuntimeHooks {
  const deferralHooks = deferral.createHooks();
  return {
    ...modelIo,
    async beforeModel(context: BeforeModelContext) {
      const filtered = await deferralHooks.beforeModel?.(context);
      const tools = filtered && 'tools' in filtered && filtered.tools ? filtered.tools : undefined;
      const nextRequest = tools ? { ...context.request, tools } : context.request;
      const ioResult = await modelIo.beforeModel?.({ ...context, request: nextRequest });
      return {
        ...ioResult,
        ...(tools ? { tools } : {}),
        ...(filtered && 'stop' in filtered && filtered.stop ? { stop: filtered.stop, reason: filtered.reason } : {}),
      };
    },
    beforeTool(context: BeforeToolContext) {
      return deferralHooks.beforeTool?.(context);
    },
  };
}
