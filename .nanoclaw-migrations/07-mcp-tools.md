# MCP Tools & Memory

`SOURCE=5183f47ac903b36fa325d24900cfd5fb499149d1`

**Intent:** Keep Calendar, Gmail, GTasks, Mapbox, Brave Search, and mnemon. **Drop GDrive.**

Data/`groups/*/container.json` are runtime — after cutover, edit DB/`ncl` rather than hoping git restores wiring.

## Dockerfile (image installs)

Port from SOURCE `container/Dockerfile`, with edits:

### KEEP blocks

- `CALENDAR_MCP_VERSION` + `@cocal/google-calendar-mcp`
- `GMAIL_MCP_VERSION` + `@gongrzhe/server-gmail-autoauth-mcp`
- `GTASKS_MCP_VERSION` + `@scottie-will/google-tasks-mcp` (+ `zod-to-json-schema` pin if required)
- `MAPBOX_MCP_VERSION` + `@mapbox/mcp-server`
- `BRAVE_SEARCH_MCP_VERSION` + `@brave/brave-search-mcp-server`
- `MNEMON_VERSION` binary install + `ENV MNEMON_DATA_DIR=/workspace/agent/.claude/mnemon`

### DROP from Dockerfile

- `GDRIVE_MCP_VERSION` and `@modelcontextprotocol/server-gdrive@…`
- `OPENCODE_VERSION` / `opencode-ai@…` (unless something else needs it — Cline does not)

### Related host tests to copy (omit GDrive)

- `src/gcal-dockerfile.test.ts`
- `src/gtasks-dockerfile.test.ts`
- `src/mapbox-dockerfile.test.ts`
- `container/agent-runner/src/providers/gmail-dockerfile.test.ts`
- `container/agent-runner/src/providers/gmail-allow-pattern.test.ts`
- Do **not** keep `src/gdrive-dockerfile.test.ts` as a required guard (or delete GDrive expectations).

## Skill recipes

If present on new base or copied from SOURCE, re-run apply for: gcal, gmail, gtasks, mapbox. Skip gdrive.

Brave has no `/add-*` skill — Dockerfile + DB only.

## Per-group DB wiring (post-cutover ops)

For the live agent group (historically `fushi`):

**KEEP mcpServers:** `calendar`, `gmail`, `gtasks`, `mapbox`, `brave-search`

**KEEP mounts:** `~/.calendar-mcp`, `~/.gmail-mcp`, `~/.gtasks-mcp` (paths as currently used)

**REMOVE:** `gdrive` mcpServer entry and `~/.gdrive-mcp` mount

**Mapbox:** keep OneCLI-style JWT placeholder token pattern (`pk.eyJ…placeholder`), not a real key in git.

**Brave:** migrate inline API key out of DB into OneCLI/vault when possible. Do not write secrets into the migration guide or commits.

## Memory

- mnemon binary in image (above).
- Cline provider registers `memory_read` / `memory_write` that shell out to `mnemon` (see `04-cline-provider.md`).
- Do not require full upstream `/add-mnemon` Claude-Code hook setup unless you intentionally switch providers later.
- Persona/ops text in `container/CLAUDE.md` / `groups/<folder>/CLAUDE.md` is user content — copy from live tree if desired; do not overwrite blindly from SOURCE if local has newer persona edits.

## Verification

- Image build lists calendar/gmail/gtasks/mapbox/brave/mnemon; no gdrive package.
- `ncl groups config get` for live group shows expected MCP set without gdrive.