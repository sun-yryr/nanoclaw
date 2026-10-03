/**
 * Agent Skills catalog — OpenCode / agentskills.io progressive disclosure Level 1.
 *
 * Level 1: name + description (this module)
 * Level 2: full SKILL.md via the skills tool
 * Level 3: scripts/references loaded by the agent as needed
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** Absolute path to the skill directory (contains SKILL.md). */
  dir: string;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
}

/**
 * Discovery roots, OpenCode/Claude-compatible order:
 * 1. ~/.claude/skills (NanoClaw symlink selection — preferred)
 * 2. /app/skills (shared RO mount — fallback)
 * 3. {cwd}/skills (optional project overlay)
 */
export function defaultSkillRoots(cwd?: string): string[] {
  const roots = [path.join(claudeConfigDir(), 'skills'), '/app/skills'];
  if (cwd) roots.push(path.join(cwd, 'skills'));
  return roots;
}

/** Parse YAML frontmatter name/description from a SKILL.md body. */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  // description may be a single line or a folded YAML string — take the first line value
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return {
    name: name?.replace(/^["']|["']$/g, ''),
    description: description?.replace(/^["']|["']$/g, ''),
  };
}

function readSkillEntry(skillDir: string, entryName: string): SkillCatalogEntry | null {
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;
  let content: string;
  try {
    content = fs.readFileSync(skillMd, 'utf-8');
  } catch {
    return null;
  }
  const { name: fmName, description } = parseSkillFrontmatter(content);
  const name = fmName || entryName;
  if (!NAME_RE.test(name)) return null;
  if (!description || description.length === 0 || description.length > 1024) return null;
  return { name, description, dir: skillDir };
}

/**
 * List skills with Level-1 metadata. First root that defines a name wins
 * (so .claude/skills overrides /app/skills for the same name).
 */
export function listSkillCatalog(roots: string[] = defaultSkillRoots()): SkillCatalogEntry[] {
  const byName = new Map<string, SkillCatalogEntry>();

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillDir = path.join(root, entry);
      let isDir = false;
      try {
        isDir = fs.statSync(skillDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      if (byName.has(entry)) continue; // earlier root wins
      const parsed = readSkillEntry(skillDir, entry);
      if (!parsed) continue;
      // Prefer directory name as the skill id when frontmatter name mismatches
      byName.set(entry, { ...parsed, name: entry, dir: skillDir });
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Escape text for embedding inside XML text nodes. */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * OpenCode-shaped Level-1 catalog for the skills tool description.
 * @see https://opencode.ai/docs/skills
 */
export function formatAvailableSkillsXml(entries: SkillCatalogEntry[]): string {
  if (entries.length === 0) {
    return '<available_skills>\n</available_skills>';
  }
  const body = entries
    .map(
      (e) =>
        `  <skill>\n    <name>${escapeXml(e.name)}</name>\n    <description>${escapeXml(e.description)}</description>\n  </skill>`,
    )
    .join('\n');
  return `<available_skills>\n${body}\n</available_skills>`;
}

export function loadSkillMarkdown(entry: SkillCatalogEntry, args?: string | null): string {
  const skillMd = path.join(entry.dir, 'SKILL.md');
  const body = fs.readFileSync(skillMd, 'utf-8');
  return args ? `${body}\n\n---\nArguments: ${args}` : body;
}

export function findSkillInCatalog(
  catalog: SkillCatalogEntry[],
  skill: string,
): SkillCatalogEntry | undefined {
  const normalized = skill.trim().toLowerCase();
  return (
    catalog.find((e) => e.name === skill.trim()) ||
    catalog.find((e) => e.name.toLowerCase() === normalized)
  );
}
