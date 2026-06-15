/**
 * Resolve composed CLAUDE.md (@import entries) into a flat system-prompt string.
 *
 * Claude Code expands `@./path` imports via settingSources. Non-Claude providers
 * (e.g. Cline) need this resolver to inject the same instructions.
 */
import fs from 'fs';
import path from 'path';

const IMPORT_RE = /^@(\.\/.+)$/;
const MAX_RESOLVED_BYTES = 64 * 1024;

function log(msg: string): void {
  console.error(`[claude-md-resolve] ${msg}`);
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function resolveImportPath(cwd: string, importPath: string): string | null {
  const relative = importPath.startsWith('./') ? importPath.slice(2) : importPath;
  const candidate = path.resolve(cwd, relative);
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

function parseImportLines(content: string): string[] {
  const imports: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('<!--')) continue;
    const match = trimmed.match(IMPORT_RE);
    if (match) imports.push(match[1]);
  }
  return imports;
}

function appendSection(sections: string[], content: string): void {
  const trimmed = content.trim();
  if (trimmed) sections.push(trimmed);
}

function truncateToLimit(text: string): string {
  if (Buffer.byteLength(text, 'utf-8') <= MAX_RESOLVED_BYTES) return text;
  log(`Resolved CLAUDE.md exceeds ${MAX_RESOLVED_BYTES} bytes — truncating`);
  const buf = Buffer.from(text, 'utf-8');
  return buf.subarray(0, MAX_RESOLVED_BYTES).toString('utf-8').trimEnd() + '\n\n[... truncated ...]';
}

/**
 * Flatten composed CLAUDE.md imports and append CLAUDE.local.md group memory.
 */
export function resolveComposedClaudeMd(cwd: string): string {
  const sections: string[] = [];
  const entryPath = path.join(cwd, 'CLAUDE.md');
  const entryContent = readFileIfExists(entryPath);

  if (entryContent) {
    for (const importPath of parseImportLines(entryContent)) {
      const resolved = resolveImportPath(cwd, importPath);
      if (!resolved) {
        log(`Skipping missing import: ${importPath}`);
        continue;
      }
      const body = readFileIfExists(resolved);
      if (body === null) {
        log(`Skipping unreadable import: ${importPath} -> ${resolved}`);
        continue;
      }
      appendSection(sections, body);
    }
  }

  const localPath = path.join(cwd, 'CLAUDE.local.md');
  const localContent = readFileIfExists(localPath);
  if (localContent?.trim()) {
    appendSection(sections, ['## Group memory', '', localContent.trim()].join('\n'));
  }

  return truncateToLimit(sections.join('\n\n---\n\n'));
}
