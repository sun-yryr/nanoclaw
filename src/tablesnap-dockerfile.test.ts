/**
 * Dependency guard for the tablesnap CLI integration point (host tree, vitest).
 *
 * add-tablesnap installs tablesnap from a GitHub release into the agent image via
 * `container/Dockerfile`. A release binary is not importable or typed, so neither
 * `tsc` nor a runtime import can catch its removal. This structural test parses
 * the Dockerfile and asserts the pinned `ARG TABLESNAP_VERSION=...` and the
 * download/install of `tablesnap-linux-${ARCH}` are present.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function dockerfile(): string {
  // Walk up from this test file to the repo root (the dir holding container/Dockerfile),
  // so the test works wherever it is copied (src/ on the host, or the skill folder).
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'container', 'Dockerfile');
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    dir = path.dirname(dir);
  }
  throw new Error('container/Dockerfile not found walking up from ' + __dirname);
}

describe('container/Dockerfile installs tablesnap', () => {
  const text = dockerfile();

  it('declares a pinned TABLESNAP_VERSION build arg', () => {
    expect(text).toMatch(/^ARG\s+TABLESNAP_VERSION=\S+/m);
  });

  it('downloads the tablesnap linux release tarball', () => {
    expect(text).toContain('joargp/tablesnap/releases/download');
    expect(text).toMatch(/tablesnap-linux-\$\{ARCH\}/);
  });

  it('installs the binary to /usr/local/bin/tablesnap', () => {
    expect(text).toContain('/usr/local/bin/tablesnap');
  });
});
