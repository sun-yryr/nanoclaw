# Remove secretary

For each group where this skill was installed, run:

```bash
bun .claude/skills/add-secretary/scripts/install.ts --group GROUP_ID --remove true
```

This cancels the recorded hourly and one-shot tasks, disables sending in the retained ledger, and removes the skill-owned memory note and tagged index line. Unrelated tasks and memory are preserved. Retain `groups/FOLDER/secretary/` (records, drafts and handoffs) and task run logs. If an unrecorded task exists after an interrupted installation, identify its exact `secretary-hourly-*`/`sec-rem-*` series against the ledger and cancel it too.

If a group's skill selection is explicit, remove only `secretary` from it with `ncl groups config update`, preserving the others. Once every installed group is removed, delete `container/skills/secretary/` and `container/agent-runner/src/secretary.test.ts`. No packages, Dockerfile edits, env vars, or gateway grants were added. Restart idle group containers so old inlined instructions disappear. Keep the install skill itself as the replayable fork recipe, or delete `.claude/skills/add-secretary/` only if the operator wants to discard that recipe.
