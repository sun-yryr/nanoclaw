import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  findSkillInCatalog,
  formatAvailableSkillsXml,
  listSkillCatalog,
  loadSkillMarkdown,
  parseSkillFrontmatter,
} from './catalog.js';

describe('skills/catalog', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-skills-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeSkill(root: string, name: string, description: string, body = '# hi'): void {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    );
  }

  it('parses name and description from frontmatter', () => {
    const parsed = parseSkillFrontmatter(
      '---\nname: tablesnap\ndescription: Convert tables to PNG. Use on Discord.\n---\n\n# Body\n',
    );
    expect(parsed.name).toBe('tablesnap');
    expect(parsed.description).toBe('Convert tables to PNG. Use on Discord.');
  });

  it('lists skills with descriptions and prefers the first root', () => {
    const claude = path.join(tmp, '.claude', 'skills');
    const app = path.join(tmp, 'app-skills');
    writeSkill(claude, 'tablesnap', 'From claude skills');
    writeSkill(app, 'tablesnap', 'From app skills');
    writeSkill(app, 'discord-formatting', 'Format Discord messages');

    const catalog = listSkillCatalog([claude, app]);
    expect(catalog.map((e) => e.name).sort()).toEqual(['discord-formatting', 'tablesnap']);
    expect(catalog.find((e) => e.name === 'tablesnap')?.description).toBe('From claude skills');
  });

  it('skips skills without a usable description', () => {
    const root = path.join(tmp, 'skills');
    writeSkill(root, 'ok-skill', 'Has a description');
    const bare = path.join(root, 'no-desc');
    fs.mkdirSync(bare, { recursive: true });
    fs.writeFileSync(path.join(bare, 'SKILL.md'), '---\nname: no-desc\n---\n\n# x\n');

    const catalog = listSkillCatalog([root]);
    expect(catalog.map((e) => e.name)).toEqual(['ok-skill']);
  });

  it('formats OpenCode-shaped available_skills XML', () => {
    const xml = formatAvailableSkillsXml([
      {
        name: 'tablesnap',
        description: 'Convert markdown tables to PNG. Use on Discord.',
        dir: '/x/tablesnap',
      },
    ]);
    expect(xml).toContain('<available_skills>');
    expect(xml).toContain('<name>tablesnap</name>');
    expect(xml).toContain(
      '<description>Convert markdown tables to PNG. Use on Discord.</description>',
    );
    expect(xml).toContain('</available_skills>');
  });

  it('escapes XML special characters in descriptions', () => {
    const xml = formatAvailableSkillsXml([
      { name: 'x', description: 'A <B> & C', dir: '/x' },
    ]);
    expect(xml).toContain('A &lt;B&gt; &amp; C');
  });

  it('loads skill markdown and finds by name case-insensitively', () => {
    const root = path.join(tmp, 'skills');
    writeSkill(root, 'tablesnap', 'Tables as images', '# Tablesnap\nDo the thing.');
    const catalog = listSkillCatalog([root]);
    const entry = findSkillInCatalog(catalog, 'TableSnap');
    expect(entry?.name).toBe('tablesnap');
    expect(loadSkillMarkdown(entry!, 'foo')).toContain('# Tablesnap');
    expect(loadSkillMarkdown(entry!, 'foo')).toContain('Arguments: foo');
  });
});
