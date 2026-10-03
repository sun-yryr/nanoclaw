# NanoClaw Migration Guide

Generated: 2026-10-03
Base: `36cbf17e107fd0f8daea4ceb2ac523d9f0d88915`
HEAD at generation: `5183f47ac903b36fa325d24900cfd5fb499149d1`
Upstream at generation: `6906434bcb13eaeca1a6d8b461a1f2c22e53359f` (`upstream/main`)

## How to use this guide

1. Read [`00-plan.md`](./00-plan.md) for order of operations and risks.
2. During Phase 2 Upgrade, work in the upgrade worktree on clean `upstream/main`.
3. Prefer **copy-from-source** for fork-only trees:
   ```bash
   SOURCE=5183f47ac903b36fa325d24900cfd5fb499149d1
   git show "$SOURCE:<path>" > "<worktree>/<path>"
   ```
4. For files that also exist upstream, apply the **surgical hooks** described in each section — do not blindly overwrite upstream with the old file.
5. Never touch `groups/`, `store/`, `data/`, or `.env` during code migration. DB MCP cleanup for GDrive is a post-cutover ops step (see plan).

## Sections

| File | Topic |
|------|--------|
| [`00-plan.md`](./00-plan.md) | Order, staging, risks, DROP list |
| [`01-skills.md`](./01-skills.md) | Applied skills to re-run / quarantine / skip |
| [`02-core-policy.md`](./02-core-policy.md) | Single-agent, host lock, mounts, message IDs, scheduling |
| [`03-discord.md`](./03-discord.md) | Discord channel + URL raw post + attachments |
| [`04-cline-provider.md`](./04-cline-provider.md) | Cline OpenAI-compatible provider (KEEP) |
| [`05-discord-voice.md`](./05-discord-voice.md) | Discord VC STT → routeInbound |
| [`06-local-voice.md`](./06-local-voice.md) | Local wake-word channel (quarantine — copy only) |
| [`07-mcp-tools.md`](./07-mcp-tools.md) | GCal, Gmail, GTasks, Mapbox, Brave, mnemon (no GDrive) |
| [`08-tablesnap.md`](./08-tablesnap.md) | tablesnap + CJK + discord-formatting |

## Operator decisions (confirmed 2026-10-03)

- Keep single-agent-group policy.
- Keep host lock, Discord URL handling, composite message-ID guards, mount hardening, attachment engage, schedule execute-mode.
- Keep Discord voice.
- Quarantine local-voice (ship code, do not wire/register).
- Keep Cline provider (do not switch to `/add-opencode` yet).
- Drop GDrive MCP; keep Calendar, Gmail, GTasks, Mapbox, Brave, mnemon.
- Keep tablesnap + discord-formatting.
- Drop fork OpenCode provider.