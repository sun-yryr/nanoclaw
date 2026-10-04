import { describe, expect, it } from 'bun:test';
import { createTool, type AgentTool } from '@cline/sdk';
import type { AgentModelRequest, AgentRuntimeHooks } from '@cline/agents';

type BeforeToolContext = Parameters<NonNullable<AgentRuntimeHooks['beforeTool']>>[0];
type BeforeModelContext = Parameters<NonNullable<AgentRuntimeHooks['beforeModel']>>[0];

import {
  ALWAYS_LOAD_MCP_SERVERS,
  composeDeferralAndModelIoHooks,
  formatDeferredToolsCatalogXml,
  isAlwaysLoadTool,
  matchDeferredTools,
  McpToolDeferral,
  parseMcpToolName,
  TOOL_SEARCH_NAME,
} from './cline-mcp-deferral.js';

function fakeTool(name: string, description = `${name} desc`, schemaExtra?: Record<string, unknown>): AgentTool {
  return createTool({
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'query' },
        ...schemaExtra,
      },
    },
    execute: async () => 'ok',
  });
}

function sampleTools(): AgentTool[] {
  return [
    fakeTool('bash', 'run shell'),
    fakeTool('mcp__nanoclaw__send_message', 'Send a message'),
    fakeTool('mcp__gmail__search_emails', 'Search Gmail inbox'),
    fakeTool('mcp__gmail__send_email', 'Send an email via Gmail'),
    fakeTool('mcp__mapbox__directions_tool', 'Get driving directions', {
      huge: { type: 'string', description: 'x'.repeat(200) },
    }),
    fakeTool('mcp__brave-search__brave_web_search', 'Brave web search'),
  ];
}

describe('parseMcpToolName / isAlwaysLoadTool', () => {
  it('parses mcp__server__tool names', () => {
    expect(parseMcpToolName('mcp__gmail__search_emails')).toEqual({
      serverName: 'gmail',
      toolName: 'search_emails',
    });
    expect(parseMcpToolName('mcp__brave-search__brave_web_search')).toEqual({
      serverName: 'brave-search',
      toolName: 'brave_web_search',
    });
    expect(parseMcpToolName('bash')).toBeNull();
  });

  it('always-loads builtins and nanoclaw', () => {
    expect(ALWAYS_LOAD_MCP_SERVERS.has('nanoclaw')).toBe(true);
    expect(isAlwaysLoadTool('bash')).toBe(true);
    expect(isAlwaysLoadTool('mcp__nanoclaw__send_message')).toBe(true);
    expect(isAlwaysLoadTool(TOOL_SEARCH_NAME)).toBe(true);
    expect(isAlwaysLoadTool('mcp__gmail__search_emails')).toBe(false);
    expect(isAlwaysLoadTool('mcp__mapbox__directions_tool')).toBe(false);
  });
});

describe('formatDeferredToolsCatalogXml', () => {
  it('lists name and description without inputSchema', () => {
    const xml = formatDeferredToolsCatalogXml([
      {
        name: 'mcp__gmail__search_emails',
        description: 'Search Gmail',
        inputSchema: { type: 'object', properties: { secretSchema: { type: 'string' } } },
        serverName: 'gmail',
      },
    ]);
    expect(xml).toContain('<name>mcp__gmail__search_emails</name>');
    expect(xml).toContain('<description>Search Gmail</description>');
    expect(xml).not.toContain('secretSchema');
    expect(xml).not.toContain('inputSchema');
  });
});

describe('McpToolDeferral', () => {
  it('keeps nanoclaw and builtins always visible; defers external MCP', () => {
    const deferral = new McpToolDeferral(sampleTools());
    const visible = deferral.selectToolsForModel().map((t) => t.name);

    expect(visible).toContain('bash');
    expect(visible).toContain('mcp__nanoclaw__send_message');
    expect(visible).toContain(TOOL_SEARCH_NAME);
    expect(visible).not.toContain('mcp__gmail__search_emails');
    expect(visible).not.toContain('mcp__mapbox__directions_tool');
    expect(visible).not.toContain('mcp__brave-search__brave_web_search');

    const gmail = deferral.selectToolsForModel().find((t) => t.name === 'mcp__nanoclaw__send_message');
    expect(gmail?.inputSchema).toBeDefined();

    // Catalog must not embed deferred schemas
    expect(deferral.toolSearch.description).toContain('mcp__gmail__search_emails');
    expect(deferral.toolSearch.description).not.toContain('x'.repeat(200));
  });

  it('activates matching tools via tool_search and exposes their schemas', async () => {
    const deferral = new McpToolDeferral(sampleTools());
    const result = await deferral.toolSearch.execute({ query: 'gmail' }, {
      agentId: 'a',
      iteration: 1,
    });
    const parsed = JSON.parse(String(result)) as {
      activated: string[];
      tools: Array<{ name: string; inputSchema: unknown }>;
    };

    expect(parsed.activated.sort()).toEqual(['mcp__gmail__search_emails', 'mcp__gmail__send_email']);
    expect(parsed.tools.every((t) => t.inputSchema)).toBe(true);

    const visible = deferral.selectToolsForModel().map((t) => t.name);
    expect(visible).toContain('mcp__gmail__search_emails');
    expect(visible).toContain('mcp__gmail__send_email');
    expect(visible).not.toContain('mcp__mapbox__directions_tool');
  });

  it('empty or * query lists catalog without activating', async () => {
    const deferral = new McpToolDeferral(sampleTools());
    for (const query of ['', '  ', '*']) {
      const result = await deferral.toolSearch.execute({ query }, { agentId: 'a', iteration: 1 });
      expect(String(result)).toContain('available_mcp_tools');
      expect(deferral.activatedNames.size).toBe(0);
    }
  });

  it('denies unactivated deferred tools in beforeTool', () => {
    const deferral = new McpToolDeferral(sampleTools());
    const gmail = sampleTools().find((t) => t.name === 'mcp__gmail__search_emails')!;
    const blocked = deferral.beforeTool({
      tool: gmail,
      toolCall: { type: 'tool-call', toolCallId: '1', toolName: gmail.name, input: {} },
      input: {},
      snapshot: {} as BeforeToolContext['snapshot'],
    } as BeforeToolContext);

    expect(blocked).toEqual({
      skip: true,
      reason: expect.stringContaining(TOOL_SEARCH_NAME),
    });

    deferral.activate(['mcp__gmail__search_emails']);
    expect(deferral.beforeTool({
      tool: gmail,
      toolCall: { type: 'tool-call', toolCallId: '1', toolName: gmail.name, input: {} },
      input: {},
      snapshot: {} as BeforeToolContext['snapshot'],
    } as BeforeToolContext)).toBeUndefined();
  });

  it('registers all tools including deferred for Agent execute map', () => {
    const deferral = new McpToolDeferral(sampleTools());
    const names = deferral.allRegisteredTools().map((t) => t.name);
    expect(names).toContain('mcp__mapbox__directions_tool');
    expect(names).toContain(TOOL_SEARCH_NAME);
    expect(names.filter((n) => n === TOOL_SEARCH_NAME)).toHaveLength(1);
  });
});

describe('matchDeferredTools', () => {
  it('matches server, name, or description substrings', () => {
    const tools = [
      {
        name: 'mcp__mapbox__directions_tool',
        description: 'Get driving directions',
        inputSchema: {},
        serverName: 'mapbox',
      },
    ];
    expect(matchDeferredTools(tools, 'mapbox').map((t) => t.name)).toEqual([
      'mcp__mapbox__directions_tool',
    ]);
    expect(matchDeferredTools(tools, 'driving').map((t) => t.name)).toEqual([
      'mcp__mapbox__directions_tool',
    ]);
    expect(matchDeferredTools(tools, 'nomatch')).toEqual([]);
    expect(matchDeferredTools(tools, '*')).toEqual([]);
  });
});

describe('composeDeferralAndModelIoHooks', () => {
  it('filters tools before model-io sees the request', async () => {
    const deferral = new McpToolDeferral(sampleTools());
    let seenToolNames: string[] = [];

    const composed = composeDeferralAndModelIoHooks(deferral, {
      beforeModel(context) {
        seenToolNames = context.request.tools.map((t) => t.name);
        return undefined;
      },
    });

    const request: AgentModelRequest = {
      messages: [],
      tools: deferral.allRegisteredTools().map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };

    const result = await composed.beforeModel?.({
      request,
      snapshot: {} as BeforeModelContext['snapshot'],
    } as BeforeModelContext);

    expect(seenToolNames).not.toContain('mcp__gmail__search_emails');
    expect(seenToolNames).toContain('mcp__nanoclaw__send_message');
    expect(seenToolNames).toContain(TOOL_SEARCH_NAME);
    expect(result?.tools?.map((t) => t.name)).toEqual(seenToolNames);
  });
});
