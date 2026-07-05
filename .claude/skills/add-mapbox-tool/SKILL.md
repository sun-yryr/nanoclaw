---
name: add-mapbox-tool
description: Add Mapbox as an MCP tool for geocoding, search, route directions, travel-time matrices, route optimization, map matching, isochrones, static maps, and offline geospatial calculations using a OneCLI-managed access token.
---

# Add Mapbox Tool (OneCLI-native)

This skill wires [`@mapbox/mcp-server`](https://www.npmjs.com/package/@mapbox/mcp-server) into selected agent groups. The MCP server reads `MAPBOX_ACCESS_TOKEN` from its environment; NanoClaw stores only the `onecli-managed` placeholder, and the OneCLI gateway swaps the real Mapbox access token into requests.

Tools exposed (surfaced as `mcp__mapbox__<name>`, exact set depends on package version): geocoding, reverse geocoding, search, directions, matrix, optimization, map matching, isochrone, static maps, and offline Turf.js-style geospatial calculations such as distance, area, bearing, buffer, bbox, centroid, and simplify.

**Why this pattern:** v2's invariant is that containers never receive raw API keys. Unlike Google OAuth MCP servers, Mapbox needs no local credential stub files; the only credential-shaped value persisted in NanoClaw is `MAPBOX_ACCESS_TOKEN=onecli-managed`.

## Phase 1: Pre-flight

### Verify OneCLI has a Mapbox credential

Do not print or paste the token. Check metadata only:

```bash
onecli secrets list | jq -r '.data[] | select((.name // "") | test("(?i)mapbox")) | {id,name,hostPattern}'
```

Expected: at least one Mapbox secret whose host pattern matches Mapbox API calls, typically `api.mapbox.com`. If the agent uses selective secret mode, assign that secret to each target OneCLI agent with the safe merge pattern (`set-secrets` replaces the whole list):

```bash
MAPBOX_SECRET_ID=$(onecli secrets list | jq -r '.data[] | select((.name // "") | test("(?i)mapbox")) | .id' | head -1)
for agent in $(onecli agents list | jq -r '.data[].id'); do
  CURRENT=$(onecli agents secrets --id "$agent" | jq -r '[.data[]] | join(",")')
  MERGED=$(printf '%s' "$CURRENT,$MAPBOX_SECRET_ID" | tr ',' '\n' | sort -u | paste -sd ',' -)
  onecli agents set-secrets --id "$agent" --secret-ids "$MERGED"
done
```

`secretMode: all` is sufficient if the host pattern matches the Mapbox API hosts. If no Mapbox secret exists, create it through OneCLI using your normal credential workflow; do not store the raw token in NanoClaw config.

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q 'MAPBOX_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED - skip to Phase 3"
```

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block and add:

```dockerfile
ARG MAPBOX_MCP_VERSION=0.12.5
```

Append the package to an existing pnpm global-install block (or add a standalone block if no other MCP packages are applied):

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@mapbox/mcp-server@${MAPBOX_MCP_VERSION}"
```

The npm package's bin is `mcp-server`. `container/agent-runner/src/providers/claude.ts` derives the allow-pattern dynamically from each group's `mcpServers` map (`Object.keys(this.mcpServers).map(mcpAllowPattern)`), so registering `mapbox` in Phase 3 automatically allows `mcp__mapbox__*`.

### Install the dependency-guard test

Copy the guard test into the host test tree (vitest):

```bash
cp .claude/skills/add-mapbox-tool/mapbox-dockerfile.test.ts src/mapbox-dockerfile.test.ts
pnpm exec vitest run src/mapbox-dockerfile.test.ts
```

`cp` overwrites in place, so re-running this skill is safe.

### Rebuild the container image

```bash
./container/build.sh
```

## Phase 3: Wire Per-Agent-Group

For each agent group that should have Mapbox (use `ncl groups list` to enumerate), persist `mcpServers.mapbox` to the **central DB** (`data/v2.db`). This flows through `materializeContainerJson` on every spawn, so editing `groups/<folder>/container.json` by hand does **not** stick.

### Register the MCP server

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name mapbox \
  --command mcp-server \
  --args '[]' \
  --env '{"MAPBOX_ACCESS_TOKEN":"onecli-managed","ENABLE_MCP_UI":"false","CLIENT_NEEDS_RESOURCE_FALLBACK":"true"}'
```

Why these env vars:

- `MAPBOX_ACCESS_TOKEN=onecli-managed` keeps the real token in OneCLI.
- `ENABLE_MCP_UI=false` avoids UI-resource responses that are not useful in chat-only agents.
- `CLIENT_NEEDS_RESOURCE_FALLBACK=true` exposes resource fallback tools for providers that only bridge MCP tools.

Approval behaviour depends on where you run it: from inside an agent's container `ncl` write verbs are approval-gated (admin approves before it lands); from a host operator shell with full scope, it executes immediately. Either way, the response tells you which path it took.

## Phase 4: Build, Validate, and Restart

```bash
pnpm run build
pnpm exec vitest run src/mapbox-dockerfile.test.ts
```

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

Kill any existing agent containers so they respawn with the new image and `mcpServers` config:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## Phase 5: Verify

### Test from a wired agent

Send one of:

> "Get driving directions from Shibuya Station to Tokyo Skytree."
>
> "Find the optimal route visiting Tokyo Station, Senso-ji, and Tokyo Tower."
>
> "How long would it take to walk from Central Park to Times Square?"

The agent should use `mcp__mapbox__*` tools such as directions, matrix, optimization, geocoding, or search. First call may take a few seconds while the MCP server starts and OneCLI injects the token.

### Check logs if the tool is not working

```bash
tail -100 logs/nanoclaw.log logs/nanoclaw.error.log | grep -iE 'mapbox|mcp'
```

Common signals:

- `command not found: mcp-server` -> image not rebuilt or global install failed.
- `MAPBOX_ACCESS_TOKEN` missing -> the MCP server was registered without the env block.
- `401 Unauthorized` / `403 Forbidden` from Mapbox -> OneCLI is not injecting, the token lacks required scopes, or the token has URL restrictions incompatible with server-side calls.
- Agent says "I do not have Mapbox tools" -> the `mapbox` MCP server is not registered in this group's `mcpServers`, or the running container has not restarted.

## Removal

See [REMOVE.md](REMOVE.md) - unregisters the MCP server, deletes the copied test, reverts the Dockerfile edits, and rebuilds.

## Credits & references

- **MCP server:** [`@mapbox/mcp-server`](https://github.com/mapbox/mcp-server) by Mapbox.
- **Mapbox docs:** https://docs.mapbox.com/api/guides/mcp-server/
- **Skill pattern:** direct sibling of [`/add-gmail-tool`](../add-gmail-tool/SKILL.md), [`/add-gcal-tool`](../add-gcal-tool/SKILL.md), and [`/add-gdrive-tool`](../add-gdrive-tool/SKILL.md), but without credential stub mounts.
