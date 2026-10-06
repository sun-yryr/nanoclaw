import { describe, expect, it } from 'bun:test';

import {
  isMcpFailureResult,
  McpRetryGuard,
  MCP_SAME_ARGS_FAILURE_LIMIT,
  MCP_TOOL_FAILURE_LIMIT,
  stableArgsKey,
} from './cline-mcp-retry.js';

describe('stableArgsKey', () => {
  it('is order-independent for object keys', () => {
    expect(stableArgsKey({ b: 1, a: 2 })).toBe(stableArgsKey({ a: 2, b: 1 }));
  });
});

describe('isMcpFailureResult', () => {
  it('detects JSON error envelopes', () => {
    expect(isMcpFailureResult(JSON.stringify({ error: 'database is locked' }))).toBe(true);
    expect(
      isMcpFailureResult(
        JSON.stringify({
          content: [{ type: 'text', text: 'SUBSCRIPTION_TOKEN_INVALID' }],
        }),
      ),
    ).toBe(true);
    expect(isMcpFailureResult(JSON.stringify({ isError: true, content: [] }))).toBe(true);
  });

  it('treats normal payloads as success', () => {
    expect(isMcpFailureResult(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }))).toBe(
      false,
    );
    expect(isMcpFailureResult('hello')).toBe(false);
  });
});

describe('McpRetryGuard', () => {
  it('allows same-args failures up to the limit then blocks without calling execute', async () => {
    const guard = new McpRetryGuard();
    let calls = 0;
    const fail = async () => {
      calls += 1;
      return JSON.stringify({ error: 'database is locked' });
    };
    const args = { to: 'health', text: 'hi' };

    for (let i = 0; i < MCP_SAME_ARGS_FAILURE_LIMIT; i++) {
      const r = await guard.run('mcp__nanoclaw__send_message', args, fail);
      expect(String(r)).toContain('database is locked');
    }
    expect(calls).toBe(MCP_SAME_ARGS_FAILURE_LIMIT);

    const blocked = await guard.run('mcp__nanoclaw__send_message', args, fail);
    expect(String(blocked)).toContain('Retry limit reached');
    expect(calls).toBe(MCP_SAME_ARGS_FAILURE_LIMIT);
  });

  it('blocks after per-tool failure limit across different args', async () => {
    const guard = new McpRetryGuard({ sameArgsLimit: 100, toolLimit: MCP_TOOL_FAILURE_LIMIT });
    let calls = 0;
    for (let i = 0; i < MCP_TOOL_FAILURE_LIMIT; i++) {
      await guard.run('mcp__brave__search', { query: `q${i}` }, async () => {
        calls += 1;
        return JSON.stringify({
          content: [{ type: 'text', text: 'SUBSCRIPTION_TOKEN_INVALID' }],
        });
      });
    }
    expect(calls).toBe(MCP_TOOL_FAILURE_LIMIT);

    const blocked = await guard.run('mcp__brave__search', { query: 'another' }, async () => {
      calls += 1;
      return 'should not run';
    });
    expect(String(blocked)).toContain('Retry limit reached');
    expect(calls).toBe(MCP_TOOL_FAILURE_LIMIT);
  });

  it('resets same-args counter after a success', async () => {
    const guard = new McpRetryGuard({ sameArgsLimit: 2 });
    const args = { q: 'x' };
    await guard.run('t', args, async () => JSON.stringify({ error: 'fail' }));
    expect(guard.sameArgsFailureCount('t', args)).toBe(1);
    await guard.run('t', args, async () => JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
    expect(guard.sameArgsFailureCount('t', args)).toBe(0);
  });

  it('turns thrown errors into failure results and counts them', async () => {
    const guard = new McpRetryGuard({ sameArgsLimit: 1 });
    const args = {};
    const first = await guard.run('t', args, async () => {
      throw new Error('boom');
    });
    expect(String(first)).toContain('boom');
    const blocked = await guard.run('t', args, async () => 'nope');
    expect(String(blocked)).toContain('Retry limit reached');
  });
});
