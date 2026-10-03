/**
 * Dependency guard for the Google Tasks MCP server (host/vitest tree).
 *
 * `@scottie-will/google-tasks-mcp` is a stdio CLI installed globally in the image,
 * not an imported module, so no behavior test can drive it and `tsc` never sees
 * it. The only in-tree footprint of this skill is the Dockerfile edit, so the
 * guard is structural: assert the pinned `ARG` and the pnpm global-install line
 * both exist. Drop either Phase 2 Dockerfile edit and this goes red.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function dockerfile(): string {
  const p = path.resolve(process.cwd(), 'container/Dockerfile');
  return fs.readFileSync(p, 'utf8');
}

describe('container/Dockerfile installs @scottie-will/google-tasks-mcp', () => {
  const text = dockerfile();

  it('pins the version via an ARG', () => {
    expect(text).toMatch(/^\s*ARG\s+GTASKS_MCP_VERSION=/m);
  });

  it('installs the package pinned to that ARG in a pnpm global-install block', () => {
    const installsGtasks = /pnpm\s+install\s+-g[\s\S]*?@scottie-will\/google-tasks-mcp@\$\{GTASKS_MCP_VERSION\}/.test(
      text,
    );
    expect(installsGtasks).toBe(true);
  });
});
