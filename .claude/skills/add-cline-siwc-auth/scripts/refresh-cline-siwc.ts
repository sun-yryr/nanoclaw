#!/usr/bin/env pnpm exec tsx
/**
 * Manually refresh the Cline SIWC access token (updates session.json + vault).
 *
 *   pnpm exec tsx .claude/skills/add-cline-siwc-auth/scripts/refresh-cline-siwc.ts
 *   pnpm exec tsx .claude/skills/add-cline-siwc-auth/scripts/refresh-cline-siwc.ts --force
 */
import { refreshSiwcSessionIfNeeded } from '../../../../src/modules/siwc-refresh/index.js';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const result = await refreshSiwcSessionIfNeeded({ root: process.cwd(), force });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'error' || result.status === 'reauth_required') {
    process.exit(1);
  }
  if (result.status === 'skipped' && result.reason === 'no_session') {
    console.error(
      'No data/siwc/session.json — run run-cline-siwc-auth.ts once to create a refreshable session.',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
