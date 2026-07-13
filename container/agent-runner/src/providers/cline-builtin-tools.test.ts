import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildClineBuiltinTools, createSkillsTool, expectedClineBuiltinToolNames } from './cline-builtin-tools.js';

describe('buildClineBuiltinTools', () => {
  it('includes every documented built-in tool name', () => {
    const tools = buildClineBuiltinTools('/tmp/nanoclaw-test');
    const names = new Set(tools.map((t) => t.name));
    for (const expected of expectedClineBuiltinToolNames()) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it('skills tool description includes OpenCode-shaped available_skills catalog', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cline-skills-'));
    try {
      const skillDir = path.join(root, 'tablesnap');
      fs.mkdirSync(skillDir);
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: tablesnap\ndescription: Convert markdown tables to PNG for Discord.\n---\n\n# Body\n',
      );

      const tool = createSkillsTool([
        {
          name: 'tablesnap',
          description: 'Convert markdown tables to PNG for Discord.',
          dir: skillDir,
        },
      ]);

      expect(tool.name).toBe('skills');
      expect(tool.description).toContain('<available_skills>');
      expect(tool.description).toContain('<name>tablesnap</name>');
      expect(tool.description).toContain('Convert markdown tables to PNG for Discord.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
