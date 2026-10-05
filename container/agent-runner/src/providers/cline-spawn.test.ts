import { describe, expect, it } from 'bun:test';

import { buildClineParentToolsWithSpawn } from './cline-builtin-tools.js';
import {
  buildClineSpawnAgentTool,
  buildSpawnChildTools,
  clineSpawnSystemPromptHint,
  resolveClineSpawnConfig,
} from './cline-spawn.js';

describe('resolveClineSpawnConfig', () => {
  it('returns null when spawn model is unset/empty', () => {
    expect(resolveClineSpawnConfig({})).toBeNull();
    expect(resolveClineSpawnConfig({ spawnModel: '' })).toBeNull();
    expect(resolveClineSpawnConfig({ spawnModel: '  ' })).toBeNull();
  });

  it('defaults spawn API to chat and iterations to 25', () => {
    expect(
      resolveClineSpawnConfig({
        spawnModel: 'deepseek-v4.1-flash',
        parentBaseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'placeholder',
      }),
    ).toEqual({
      modelId: 'deepseek-v4.1-flash',
      providerId: 'openai-compatible',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'placeholder',
      maxIterations: 25,
    });
  });

  it('prefers CLINE_SPAWN_BASE_URL over the parent base URL', () => {
    const cfg = resolveClineSpawnConfig({
      spawnModel: 'deepseek-v4.1-flash',
      spawnBaseUrl: 'https://child.example/v1',
      parentBaseUrl: 'https://parent.example/v1',
    });
    expect(cfg?.baseUrl).toBe('https://child.example/v1');
  });

  it('falls back to parent base URL when spawn base URL is unset', () => {
    const cfg = resolveClineSpawnConfig({
      spawnModel: 'deepseek-v4.1-flash',
      parentBaseUrl: 'https://parent.example/v1',
    });
    expect(cfg?.baseUrl).toBe('https://parent.example/v1');
  });

  it('maps responses spawn API to openai-native', () => {
    const cfg = resolveClineSpawnConfig({
      spawnModel: 'gpt-6-luna-fast',
      spawnApi: 'responses',
    });
    expect(cfg?.providerId).toBe('openai-native');
    expect(cfg?.modelId).toBe('gpt-6-luna-fast');
  });

  it('throws on invalid spawn API', () => {
    expect(() =>
      resolveClineSpawnConfig({ spawnModel: 'x', spawnApi: 'auto' }),
    ).toThrow(/Invalid CLINE_SPAWN_API/);
  });
});

describe('buildSpawnChildTools', () => {
  it('excludes ask_question and never includes spawn_agent', () => {
    const tools = buildSpawnChildTools(process.cwd());
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('ask_question');
    expect(names).not.toContain('spawn_agent');
    expect(names).toContain('read_files');
    expect(names).toContain('run_commands');
  });
});

describe('buildClineParentToolsWithSpawn', () => {
  it('keeps only ask/submit — no file/shell/web tools', () => {
    const names = buildClineParentToolsWithSpawn(process.cwd()).map((t) => t.name);
    expect(names).toContain('ask_question');
    expect(names).toContain('submit_and_exit');
    expect(names).not.toContain('read_files');
    expect(names).not.toContain('run_commands');
    expect(names).not.toContain('fetch_web_content');
    expect(names).not.toContain('editor');
    expect(names).not.toContain('skills');
  });
});

describe('buildClineSpawnAgentTool', () => {
  it('creates a spawn_agent tool bound to the child model', () => {
    const tool = buildClineSpawnAgentTool({
      spawn: {
        modelId: 'deepseek-v4.1-flash',
        providerId: 'openai-compatible',
        baseUrl: 'https://example.com/v1',
        apiKey: 'placeholder',
        maxIterations: 10,
      },
      cwd: process.cwd(),
    });
    expect(tool.name).toBe('spawn_agent');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['systemPrompt', 'task'],
    });
  });
});

describe('clineSpawnSystemPromptHint', () => {
  it('requires spawn for non-MCP work', () => {
    const hint = clineSpawnSystemPromptHint('deepseek-v4.1-flash');
    expect(hint).toContain('deepseek-v4.1-flash');
    expect(hint).toContain('spawn_agent');
    expect(hint).toContain('do NOT have file/shell/web');
  });
});
