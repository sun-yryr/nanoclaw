---
name: add-reaction-feedback
description: Read human reactions on NanoClaw Discord answers as silent read receipts and answer quality feedback, including secretary reviews across sessions.
---

# Add reaction feedback

Fork-local utility skill. Requires an installed Discord Chat SDK adapter and the permissions module. No dependencies or credentials are added. This recipe owns `src/modules/reaction-feedback/`; `integration.patch` carries the small host/bridge/instruction connections. Its module registers its migration, read-only `ncl groups feedback` command and history import. Read CONTRIBUTING.md before adapting the recipe.

## Apply

Run `python3 .claude/skills/add-reaction-feedback/scripts/install.py`. It checks the full integration patch before applying, accepts an already applied patch, and refuses to overwrite divergent connections. The payload is authoritative for the skill-owned module. Inspect any local changes to that module before replacing it.

Behavior:

- 👀 = seen. Avoid unchanged routine repeats.
- 👍 / `+1` = good answer; 👎 / `-1` = bad answer. Ratings concern answer quality, never task read/completion state. Do not invent the reason for a rating.
- 🆗 / `ok` / 👌 = acknowledged, never task completion.
- Other emoji are retained without invented meaning. Removals revoke only that person's reaction on that message part.
- Only known members/admins/owners of the target group can provide feedback. Bots and messages sent by other bots/humans are ignored. There is no approval or task-completion action attached to a reaction.
- Reactions write trigger=0 ambient context to the original session. No model wake, typing, response or reaction acknowledgment. Durable group-scoped reads support scheduled tasks and other sessions.
- Unfinished deadline reminders remain active. With the secretary capability, copy the current `add-secretary/payload/secretary/` into `container/skills/secretary/` after preserving any local changes. Its context command reads host feedback through ncl and associates reactions with exact notification IDs. Repeat suppression is an agent instruction grounded in that context, not a text-matching filter. `feedbackError` and truncation are explicit; absent feedback must not be interpreted as unread.

At startup the default SQLite mailbox imports up to 200 recent delivery receipts per session (no network fetch). For old split answers only the first part's receipt is available. All parts of newly sent answers are tracked. Existing reactions are not fetched retrospectively; new add/remove events are observed while the host is online. Other mailbox backends track new messages but skip this SQLite history import.

## Validate and activate

Run:

```bash
pnpm run build
pnpm exec vitest run src/modules/reaction-feedback/reaction-feedback.test.ts src/channels/chat-sdk-bridge.test.ts src/channels/channel-registry.test.ts src/delivery.test.ts src/guard/conformance.test.ts
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

With secretary installed, also run its Bun tests and `pnpm exec tsc -p container/skills/secretary/tsconfig.json --noEmit`.

Before restarting, compare `scripts/upgrade-state.ts get` with the current checkout. If earlier local commits changed the identity, follow `docs/upgrade-recovery.md`: inspect those changes, complete their relevant validation/migrations/image work, and only then stamp the verified local customization. Do not clear the tripwire to skip a failed upgrade.

Detect this checkout's actual host service; do not assume its name. Restart when no agent turn is processing. The host applies the additive central migration automatically. Shared source/skill mounts need no image rebuild. Restart idle agent containers to refresh their inlined instructions. Verify that Discord reconnects and `ncl groups feedback --id GROUP --json` succeeds. A live check needs a human to react to an answer; do not send test messages without authorization. Never claim the simulated SDK tests validate a real human interaction.

The stored snapshots and ratings are group-private central data. `--json` timestamps stay ISO UTC. Human CLI output uses the install timezone. Removal is in [REMOVE.md](REMOVE.md).
