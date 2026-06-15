import { describe, expect, it } from 'bun:test';

import { buildClineBuiltinTools, expectedClineBuiltinToolNames } from './cline-builtin-tools.js';

describe('buildClineBuiltinTools', () => {
  it('includes every documented built-in tool name', () => {
    const tools = buildClineBuiltinTools('/tmp/nanoclaw-test');
    const names = new Set(tools.map((t) => t.name));
    for (const expected of expectedClineBuiltinToolNames()) {
      expect(names.has(expected)).toBe(true);
    }
  });
});
