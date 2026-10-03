# Migration Plan (Tier 3)

## Order of operations

### Stage A — Clean base + stock skills

1. Worktree on `upstream/main`.
2. Re-apply `/add-discord` from `upstream/channels` (or `origin/channels` if that remote tracks nanocoai). Prefer the remote that has the `channels` branch (`upstream` after fetch).
3. Do **not** re-apply `/add-opencode` or fork OpenCode files.
4. Do **not** re-apply `/add-gdrive-tool`.
5. Re-apply MCP skill applies that still exist on the new base (or copy Dockerfile blocks from SOURCE if skill recipes are fork-only):
   - Calendar, Gmail, GTasks, Mapbox, tablesnap
   - Brave Search has no skill — copy Dockerfile ARG/install from SOURCE (omit GDrive lines)
   - mnemon binary install from SOURCE Dockerfile (Cline memory tools come with Cline port)

### Stage B — Core host policy (before providers)

1. Copy + wire `single-agent.ts` and all create/wiring guards (`02-core-policy.md`).
2. Copy + wire `host-lock.ts` in `src/index.ts`.
3. Port mount-security / container-config hardening.
4. Port attachment download + router engage-on-attachment.
5. Port composite message-ID strip (container) + delivery guard (bridge).
6. Port scheduling execute-mode (container formatter + instructions).

### Stage C — Discord customizations

1. After stock Discord adapter is installed, apply URL/`postAsRaw` patches (`03-discord.md`).
2. Copy `discord-formatting` container skill + tablesnap CJK (`08-tablesnap.md`).

### Stage D — Cline provider

1. Copy entire Cline file tree + `@cline/sdk` dep (`04-cline-provider.md`).
2. Port `poll-loop.ts` multimodal / error-rethrow hunks required by Cline.
3. Register barrels; ensure groups stay `provider=cline` in DB (data/ is not rewritten by git — verify after cutover).

### Stage E — Voice

1. Copy Discord voice module + command-gate + `index.ts` startup (`05-discord-voice.md`). Enable still gated by `DISCORD_VOICE_ENABLED`.
2. Copy local-voice tree but **omit** `import './local-voice.js'` from `src/channels/index.ts` (`06-local-voice.md`).

### Stage F — Validate

1. `pnpm install && pnpm run build && pnpm test` in worktree.
2. Container: `bun install` in agent-runner if lock changed; typecheck; `./container/build.sh` when ready.
3. Post-cutover DB ops: remove `gdrive` from `container_configs.mcpServers` / mounts for live groups; remove fork `opencode` if any; consolidate stray agent groups with `scripts/consolidate-agent-groups.ts` if needed.

## Staging / validation checkpoints

| After | Validate |
|-------|----------|
| Stage A | Discord adapter registers; build passes |
| Stage B | Unit tests for host-lock / single-agent / mounts |
| Stage D | Container typecheck; cline provider loads in tests |
| Stage E | `discord-voice-wiring.test.ts` passes; local-voice **not** in channel barrel |

## Risk areas

| Risk | Why | Mitigation |
|------|-----|------------|
| `chat-sdk-bridge.ts` / `router.ts` / `index.ts` | Heavy upstream churn | Surgical hooks only; re-read upstream before patching |
| Cline vs agent-runner APIs | `poll-loop` / provider types may have moved | Port against new types; keep Cline query shape |
| MCP skill recipes | Some Google/Mapbox skills may be fork-only or moved upstream | Prefer SOURCE Dockerfile blocks if skill apply fails |
| Brave API key in DB | Was stored inline | After cutover, move to OneCLI / vault; never commit keys |
| Data dirs | Live sessions / OAuth stubs | Do not overwrite `groups/fushi`, `data/`, `.env` |

## Skill interactions

- Discord voice requires Discord channel + same `DISCORD_BOT_TOKEN`; separate Discord.js client.
- Cline loads MCP from per-group `container_configs` — skill Dockerfile installs binaries; DB wiring remains.
- `discord-formatting` instructs tablesnap; tablesnap needs IPA Gothic patch in image.
- `memory_read`/`memory_write` on Cline call `mnemon` CLI — binary must be in image.
- Do not re-introduce fork OpenCode alongside Cline (duplicate deps / confusion).

## DROP list (do not migrate)

- Fork OpenCode: `src/providers/opencode.ts`, container `opencode.ts`, `mcp-to-opencode.*`, `@opencode-ai/sdk` / unused `ai` deps if only used by OpenCode, Dockerfile `OPENCODE_VERSION` / `opencode-ai@…` install.
- GDrive: Dockerfile `GDRIVE_MCP_VERSION` + `@modelcontextprotocol/server-gdrive`, `src/gdrive-dockerfile.test.ts`, skill apply, DB `mcpServers.gdrive` + `.gdrive-mcp` mounts.
- local-voice **registration** (code may exist, barrel import must stay off).
- Debug-only `container-runner` log noise unless useful.