/**
 * Point every channel wiring at one agent group with session_mode=shared.
 *
 * Does not delete leftover agent groups — review with `ncl groups list`
 * then `ncl groups delete --id <id>` after confirming.
 *
 * Usage:
 *   pnpm exec tsx scripts/consolidate-agent-groups.ts [--keep <id-or-folder>] [--dry-run]
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { consolidateAgentGroups, resolveKeepAgentGroup } from '../src/single-agent.js';

function parseArgs(argv: string[]): { keep?: string; dryRun: boolean } {
  let keep: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep') {
      keep = argv[++i];
    } else if (argv[i] === '--dry-run') {
      dryRun = true;
    }
  }
  return { keep, dryRun };
}

function main(): void {
  const { keep, dryRun } = parseArgs(process.argv.slice(2));
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const target = resolveKeepAgentGroup(keep);
  if (dryRun) {
    const wirings = getDb()
      .prepare(
        `SELECT mga.messaging_group_id, mga.agent_group_id, mga.session_mode, ag.folder
         FROM messaging_group_agents mga
         JOIN agent_groups ag ON ag.id = mga.agent_group_id`,
      )
      .all() as Array<{
      messaging_group_id: string;
      agent_group_id: string;
      session_mode: string;
      folder: string;
    }>;
    console.log(`Would keep ${target.id} (${target.folder} / ${target.name})`);
    for (const row of wirings) {
      const action =
        row.agent_group_id === target.id
          ? row.session_mode === 'shared'
            ? 'keep'
            : 'set session_mode=shared'
          : `rewire ${row.folder} → ${target.folder}`;
      console.log(`  ${row.messaging_group_id}  ${action}`);
    }
    return;
  }

  const result = consolidateAgentGroups(target.id);
  console.log(`Kept ${result.keep.id} (${result.keep.folder} / ${result.keep.name})`);
  console.log(`Already on keep: ${result.alreadyOnKeep}`);
  console.log(`Rewired: ${result.rewired.length}`);
  for (const row of result.rewired) {
    console.log(`  ${row.messagingGroupId}  from ${row.fromAgentGroupId}`);
  }
  if (result.otherGroups.length > 0) {
    console.log('Leftover agent groups (not deleted):');
    for (const g of result.otherGroups) {
      console.log(`  ${g.id}  ${g.folder}  ${g.name}`);
    }
    console.log('Review then: ncl groups delete --id <id>');
  }
}

main();
