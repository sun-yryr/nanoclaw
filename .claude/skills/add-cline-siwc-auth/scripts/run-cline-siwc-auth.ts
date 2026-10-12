#!/usr/bin/env pnpm exec tsx
/**
 * Phase 2 CLI: SIWC browser login → gateway vault + local session (refresh).
 *
 *   pnpm exec tsx .claude/skills/add-cline-siwc-auth/scripts/run-cline-siwc-auth.ts
 *   pnpm exec tsx .claude/skills/add-cline-siwc-auth/scripts/run-cline-siwc-auth.ts --port 1455
 *
 * Stores a **generic** Bearer secret for api.openai.com (no ChatGPT-Account-Id)
 * and data/siwc/session.json for host-side automatic refresh.
 * Default callback is http://127.0.0.1:1455/auth/callback.
 */
import { execFileSync } from 'node:child_process';

import { getCredentialStore } from '../../../../setup/gateways/credential-store.js';
import { saveSiwcSession, sessionFromLogin } from '../../../../src/modules/siwc-refresh/index.js';
import {
  CLINE_SIWC_CONNECTION_NAME,
  accessTokenFromSiwcTokens,
  configureSiwcModelEndpoint,
  createClineSiwcVault,
  scopesIncludeSharing,
} from './cline-siwc-vault.js';
import { runSiwcBrowserLogin, SIWC_CALLBACK_PORT, SIWC_USAGE_URL } from './siwc-login.js';

function parsePort(argv: string[]): number {
  const flag = argv.findIndex((a) => a === '--port');
  if (flag >= 0) {
    const raw = argv[flag + 1];
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error('Usage: --port <1-65535>');
    }
    return n;
  }
  const fromEnv = process.env.SIWC_CALLBACK_PORT?.trim();
  if (fromEnv) {
    const n = Number(fromEnv);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error('SIWC_CALLBACK_PORT must be an integer 1-65535');
    }
    return n;
  }
  return SIWC_CALLBACK_PORT;
}

/**
 * Remove a legacy OneCLI `openai`-type "Cline SIWC" row. That type injects
 * ChatGPT-Account-Id and breaks SIWC (400 invalid_request).
 */
function deleteLegacyOpenaiSiwcSecret(): void {
  try {
    const raw = execFileSync('onecli', ['secrets', 'list', '--fields', 'id,name,type'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as Array<{ id?: string; name?: string; type?: string }>;
    const rows = Array.isArray(parsed) ? parsed : [];
    for (const row of rows) {
      if (row.name !== CLINE_SIWC_CONNECTION_NAME || row.type !== 'openai' || !row.id) continue;
      console.log(`Removing legacy openai-type vault entry ${row.id} (injects ChatGPT-Account-Id)…`);
      execFileSync('onecli', ['secrets', 'delete', '--id', row.id], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Could not auto-remove legacy openai SIWC secret (continuing): ${message}`);
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const port = parsePort(process.argv.slice(2));
  console.log('Starting Sign in with ChatGPT for Cline (host only)…');
  console.log(`Using fixed callback port ${port}\n`);

  const login = await runSiwcBrowserLogin({ root, port });
  if (!scopesIncludeSharing(login.scope)) {
    console.error(
      `\nLogin succeeded but ChatGPT plan usage was not granted (missing chatgpt.tokens.use.direct).\n` +
        `Re-run and enable plan usage, or manage access at:\n  ${SIWC_USAGE_URL}\n`,
    );
    process.exit(1);
  }

  const accessToken = accessTokenFromSiwcTokens({
    access_token: login.accessToken,
    refresh_token: login.refreshToken,
    id_token: login.idToken,
    scope: login.scope,
  });

  deleteLegacyOpenaiSiwcSecret();

  const store = await getCredentialStore(root);
  const vault = createClineSiwcVault(store);
  const existing = await vault.find({
    confirmHostChange: async (previous, next) => {
      console.log(`Vault host would move from ${previous} → ${next}. Accepting.`);
      return true;
    },
  });
  await vault.save(accessToken);

  const session = sessionFromLogin({
    clientId: login.clientId,
    accessToken,
    refreshToken: login.refreshToken,
    idToken: login.idToken,
    scope: login.scope,
    expiresIn: login.expiresIn,
  });
  saveSiwcSession(session, root);

  await configureSiwcModelEndpoint(store);

  console.log('\nSaved Cline SIWC credentials to the selected gateway vault.');
  console.log('  kind:      generic Bearer (Authorization only — no ChatGPT-Account-Id)');
  console.log(`  client_id: ${login.clientId}`);
  console.log(`  host id:   ${login.hostId}`);
  console.log(`  expires:   ${session.expiresAt}`);
  console.log(`  session:   data/siwc/session.json (refresh_token; host auto-refreshes)`);
  console.log(`  replaced:  ${existing ? 'yes' : 'new entry'}`);
  console.log(`\nManage ChatGPT plan usage:\n  ${SIWC_USAGE_URL}\n`);
  console.log('Host refresh loop updates the vault access token (~hourly). Re-run this');
  console.log('command only when refresh fails (needsReauth) or after 30 days without refresh.');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\nCline SIWC auth failed: ${message}\n`);
  process.exit(1);
});
