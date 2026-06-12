import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const dotenv = readEnvFile(['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL', 'ANTHROPIC_BASE_URL']);

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
    OPENCODE_PROVIDER: dotenv.OPENCODE_PROVIDER || ctx.hostEnv.OPENCODE_PROVIDER || '',
    OPENCODE_MODEL: dotenv.OPENCODE_MODEL || ctx.hostEnv.OPENCODE_MODEL || '',
    OPENCODE_SMALL_MODEL: dotenv.OPENCODE_SMALL_MODEL || ctx.hostEnv.OPENCODE_SMALL_MODEL || '',
    ANTHROPIC_BASE_URL: dotenv.ANTHROPIC_BASE_URL || ctx.hostEnv.ANTHROPIC_BASE_URL || '',
  };

  if (!env.OPENCODE_PROVIDER) delete env.OPENCODE_PROVIDER;
  if (!env.OPENCODE_MODEL) delete env.OPENCODE_MODEL;
  if (!env.OPENCODE_SMALL_MODEL) delete env.OPENCODE_SMALL_MODEL;
  if (!env.ANTHROPIC_BASE_URL) delete env.ANTHROPIC_BASE_URL;

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
