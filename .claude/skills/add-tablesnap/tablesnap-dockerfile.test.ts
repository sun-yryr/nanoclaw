/**
 * Dependency guard for the tablesnap CLI integration point (host tree, vitest).
 *
 * tablesnap is built from source (CJK font patch) in a golang stage and copied
 * into the agent image. A release binary is not importable or typed, so this
 * structural test asserts the build stage, IPA Gothic font, and binary install.
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

describe('container/Dockerfile installs tablesnap with CJK fonts', () => {
  const text = dockerfile();

  it('declares a pinned TABLESNAP_VERSION build arg', () => {
    expect(text).toMatch(/^ARG\s+TABLESNAP_VERSION=\S+/m);
  });

  it('builds tablesnap from source with the CJK font patch', () => {
    expect(text).toMatch(/AS\s+tablesnap-build/);
    expect(text).toContain('tablesnap/cjk-font.patch');
    expect(text).toContain('joargp/tablesnap.git');
  });

  it('installs IPA Gothic for Japanese table text', () => {
    expect(text).toMatch(/fonts-ipafont-gothic/);
    expect(text).toMatch(/TABLESNAP_FONT=.*ipag\.ttf/);
  });

  it('installs the binary to /usr/local/bin/tablesnap', () => {
    expect(text).toContain('/usr/local/bin/tablesnap');
  });
});
