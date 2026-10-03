import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AgentModelRequest } from '@cline/agents';

import {
  createModelIoHooks,
  modelIoEnabled,
  rotateModelIoDir,
  serializeModelRequest,
  writeModelIoRecord,
} from './cline-model-io.js';

describe('serializeModelRequest', () => {
  it('keeps systemPrompt, messages, tools, options and drops signal', () => {
    const request = {
      systemPrompt: 'be helpful',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        {
          name: 'send_card',
          description: 'show a card',
          inputSchema: {
            type: 'object',
            properties: { url: { type: 'string', pattern: '^[hH][tT][tT][pP][sS]?://.+$' } },
          },
        },
      ],
      options: { temperature: 0.2 },
      signal: AbortSignal.abort(),
    } as unknown as AgentModelRequest;

    expect(serializeModelRequest(request)).toEqual({
      systemPrompt: 'be helpful',
      messages: request.messages,
      tools: [
        {
          name: 'send_card',
          description: 'show a card',
          inputSchema: {
            type: 'object',
            properties: { url: { type: 'string', pattern: '^[hH][tT][tT][pP][sS]?://.+$' } },
          },
        },
      ],
      options: { temperature: 0.2 },
    });
  });
});

describe('writeModelIoRecord + rotate', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-model-io-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a JSON dump and rotates older files', () => {
    for (let i = 1; i <= 3; i++) {
      writeModelIoRecord(
        dir,
        {
          ts: new Date().toISOString(),
          call: i,
          status: 'ok',
          provider: 'cline',
          providerId: 'openai-compatible',
          modelId: 'test-model',
          sessionId: 'sess-1',
          input: { messages: [] },
          output: { assistantMessage: { role: 'assistant', content: [] }, finishReason: 'stop' },
        },
        2,
      );
      // Ensure distinct mtimes for rotation ordering.
      Bun.sleepSync(5);
    }

    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(2);
    expect(rotateModelIoDir(dir, 1)).toBe(1);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  });
});

describe('createModelIoHooks', () => {
  let dir: string;
  let prevDir: string | undefined;
  let prevEnabled: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-model-io-hooks-'));
    prevDir = process.env.CLINE_MODEL_IO_DIR;
    prevEnabled = process.env.CLINE_MODEL_IO;
    process.env.CLINE_MODEL_IO_DIR = dir;
    delete process.env.CLINE_MODEL_IO;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.CLINE_MODEL_IO_DIR;
    else process.env.CLINE_MODEL_IO_DIR = prevDir;
    if (prevEnabled === undefined) delete process.env.CLINE_MODEL_IO;
    else process.env.CLINE_MODEL_IO = prevEnabled;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to enabled', () => {
    expect(modelIoEnabled()).toBe(true);
  });

  it('pairs beforeModel + afterModel into one dump (success)', async () => {
    const hooks = createModelIoHooks({
      providerId: 'openai-compatible',
      modelId: 'deepseek',
      sessionId: 'sess-abc',
    });

    await hooks.beforeModel?.({
      snapshot: { messages: [], pendingToolCalls: [] } as never,
      request: {
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        tools: [],
      },
    });

    await hooks.afterModel?.({
      snapshot: { messages: [], pendingToolCalls: [] } as never,
      assistantMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'pong' }],
      },
      finishReason: 'stop',
    });

    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('-ok.json');
    const body = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf-8'));
    expect(body.input.systemPrompt).toBe('sys');
    expect(body.input.messages[0].content[0].text).toBe('ping');
    expect(body.output.assistantMessage.content[0].text).toBe('pong');
    expect(body.output.finishReason).toBe('stop');
    expect(body.modelId).toBe('deepseek');
    expect(body.sessionId).toBe('sess-abc');
  });

  it('flushes pending input on afterRun when afterModel never fired', async () => {
    const hooks = createModelIoHooks({
      providerId: 'openai-compatible',
      modelId: 'deepseek',
      sessionId: 'sess-err',
    });

    await hooks.beforeModel?.({
      snapshot: { messages: [], pendingToolCalls: [] } as never,
      request: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'boom' }] }],
        tools: [
          {
            name: 'send_card',
            description: 'card',
            inputSchema: { type: 'object', properties: { url: { type: 'string', pattern: 'https?://.+' } } },
          },
        ],
      },
    });

    await hooks.afterRun?.({
      snapshot: { messages: [], pendingToolCalls: [] } as never,
      result: {
        agentId: 'a',
        runId: 'r',
        status: 'failed',
        iterations: 1,
        outputText: '',
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        error: new Error('Bad Request'),
      },
    });

    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(files).toHaveLength(1);
    const body = JSON.parse(fs.readFileSync(path.join(dir, files[0]!), 'utf-8'));
    expect(body.status).toBe('failed');
    expect(body.input.tools[0].inputSchema.properties.url.pattern).toBe('https?://.+');
    expect(body.error.message).toBe('Bad Request');
    expect(body.output).toBeNull();
  });

  it('can be disabled via CLINE_MODEL_IO=0', async () => {
    process.env.CLINE_MODEL_IO = '0';
    expect(modelIoEnabled()).toBe(false);

    const hooks = createModelIoHooks({
      providerId: 'openai-compatible',
      modelId: 'deepseek',
      sessionId: 'sess-off',
    });

    await hooks.beforeModel?.({
      snapshot: { messages: [], pendingToolCalls: [] } as never,
      request: { messages: [], tools: [] },
    });
    await hooks.afterModel?.({
      snapshot: { messages: [], pendingToolCalls: [] } as never,
      assistantMessage: { role: 'assistant', content: [] },
      finishReason: 'stop',
    });

    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(0);
  });
});
