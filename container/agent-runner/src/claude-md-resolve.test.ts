import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'bun:test';

import { resolveComposedClaudeMd } from './claude-md-resolve.js';

describe('resolveComposedClaudeMd', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('expands @import lines into fragment contents', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-'));
    const sharedDir = path.join(tmpDir, 'shared');
    fs.mkdirSync(sharedDir);

    fs.writeFileSync(path.join(sharedDir, 'base.md'), '# Shared base\nBe concise.');
    fs.symlinkSync(path.join(sharedDir, 'base.md'), path.join(tmpDir, '.claude-shared.md'), 'file');

    const fragmentsDir = path.join(tmpDir, '.claude-fragments');
    fs.mkdirSync(fragmentsDir);
    fs.writeFileSync(path.join(fragmentsDir, 'module-core.md'), '## MCP\nWrap messages in <message>.');

    fs.writeFileSync(
      path.join(tmpDir, 'CLAUDE.md'),
      ['<!-- Composed at spawn -->', '@./.claude-shared.md', '@./.claude-fragments/module-core.md', ''].join('\n'),
    );

    const resolved = resolveComposedClaudeMd(tmpDir);

    expect(resolved).toContain('# Shared base');
    expect(resolved).toContain('Be concise.');
    expect(resolved).toContain('## MCP');
    expect(resolved).toContain('<message>');
    expect(resolved).not.toContain('@./.claude-shared.md');
  });

  it('appends non-empty CLAUDE.local.md as group memory', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-'));
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '@./note.md\n');
    fs.writeFileSync(path.join(tmpDir, 'note.md'), 'Workspace rules.');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.local.md'), 'User prefers Japanese.');

    const resolved = resolveComposedClaudeMd(tmpDir);

    expect(resolved).toContain('Workspace rules.');
    expect(resolved).toContain('## Group memory');
    expect(resolved).toContain('User prefers Japanese.');
  });

  it('returns empty string when no CLAUDE files exist', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-'));
    expect(resolveComposedClaudeMd(tmpDir)).toBe('');
  });
});
