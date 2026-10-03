---
name: add-gtasks-tool
description: Add Google Tasks as an MCP tool (list/create/update/delete/complete tasks and task lists) using OneCLI-managed OAuth. Mirrors /add-gcal-tool's stub pattern — no raw credentials ever reach the container; OneCLI injects real tokens at request time.
---

# Add Google Tasks Tool (OneCLI-native)

This skill wires [`@scottie-will/google-tasks-mcp`](https://www.npmjs.com/package/@scottie-will/google-tasks-mcp) into selected agent groups. The MCP server reads stub credentials containing the `onecli-managed` placeholder; the OneCLI gateway intercepts outbound calls to `tasks.googleapis.com` / `oauth2.googleapis.com` and swaps the bearer for the real OAuth token from its vault.

Tools exposed (surfaced as `mcp__gtasks__<name>`): `authenticate`, `list-task-lists`, `list-tasks`, `get-task`, `create-task`, `update-task`, `delete-task`, `complete-task`.

**Why this package:** Actively maintained (2026), stdio-native, credential paths via env vars (`GOOGLE_OAUTH_CREDENTIALS`, `GOOGLE_TASKS_MCP_TOKEN_PATH`) — same stub pattern as Calendar. Full read/write Tasks API coverage with built-in agent instructions for date-only quirks and destructive-operation guardrails.

**Why this pattern:** v2's invariant is that containers never receive raw API keys (CHANGELOG 2.0.0). Same stub pattern `/add-gcal-tool` uses. This skill is deliberately a sibling, not a combined "Google Workspace" skill — installs independently and removes cleanly.

## Phase 1: Pre-flight

### Verify OneCLI has Google Tasks connected

```bash
onecli apps get --provider google-tasks
```

Expected: `"connection": { "status": "connected" }` with scopes including `tasks`.

If not connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Google Tasks, and click Connect. Sign in with the Google account the agent should act as. `https://www.googleapis.com/auth/tasks` is the required scope.

### Verify stub credentials exist

The stub lives at `~/.gtasks-mcp/` by convention (shared naming with `/add-gmail-tool`'s sibling skills). The server defaults to `~/.config/google-tasks-mcp/tokens.json` — we override via env vars below so it reads our stubs instead.

```bash
ls -la ~/.gtasks-mcp/gcp-oauth.keys.json ~/.gtasks-mcp/tokens.json 2>&1
```

If both exist with `onecli-managed`:

```bash
grep -l onecli-managed ~/.gtasks-mcp/gcp-oauth.keys.json ~/.gtasks-mcp/tokens.json
```

...skip to Phase 2. If either file has real credentials (no `onecli-managed`), **STOP** — back up and delete before proceeding.

If absent, write them:

```bash
mkdir -p ~/.gtasks-mcp
cat > ~/.gtasks-mcp/gcp-oauth.keys.json <<'EOF'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
EOF
cat > ~/.gtasks-mcp/tokens.json <<'EOF'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/tasks"
}
EOF
chmod 600 ~/.gtasks-mcp/*.json
```

### Verify mount allowlist covers the path

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

`~/.gtasks-mcp` must sit under an `allowedRoots` entry.

### Check agent secret-mode

For each target agent group, confirm OneCLI will inject the Google Tasks token:

```bash
onecli agents list
```

`secretMode: all` is sufficient. If `selective`, explicitly assign the Tasks secret.

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q 'GTASKS_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block and add:

```dockerfile
ARG GTASKS_MCP_VERSION=0.2.1
```

Append to an existing pnpm global-install block (or add a standalone block if no other Google MCP skills are applied):

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@scottie-will/google-tasks-mcp@${GTASKS_MCP_VERSION}"
```

`container/agent-runner/src/providers/claude.ts` derives the allow-pattern dynamically from each group's `mcpServers` map (`Object.keys(this.mcpServers).map(mcpAllowPattern)`), so registering `gtasks` in Phase 3 automatically allows `mcp__gtasks__*`.

### Install the dependency-guard test

Copy the guard test into the host test tree (vitest):

```bash
cp .claude/skills/add-gtasks-tool/gtasks-dockerfile.test.ts src/gtasks-dockerfile.test.ts
pnpm exec vitest run src/gtasks-dockerfile.test.ts
```

`cp` overwrites in place, so re-running this skill is safe.

### Rebuild the container image

```bash
./container/build.sh
```

## Phase 3: Wire Per-Agent-Group

For each agent group, persist two changes to the **central DB** (`data/v2.db`): the `mcpServers.gtasks` entry and an `additionalMounts` entry for `.gtasks-mcp`. Both flow through `materializeContainerJson` on every spawn, so editing `groups/<folder>/container.json` by hand does **not** stick — that file is regenerated from the DB.

### Register the MCP server

For each chosen `<group-id>` (use `ncl groups list` to enumerate):

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name gtasks \
  --command google-tasks-mcp \
  --args '[]' \
  --env '{"GOOGLE_OAUTH_CREDENTIALS":"/workspace/extra/.gtasks-mcp/gcp-oauth.keys.json","GOOGLE_TASKS_MCP_TOKEN_PATH":"/workspace/extra/.gtasks-mcp/tokens.json"}'
```

Approval behaviour depends on where you run it: from inside an agent's container `ncl` write verbs are approval-gated (admin approves before it lands); from a host operator shell with full scope, it executes immediately. Either way, the response tells you which path it took.

### Add the `.gtasks-mcp` mount

There is no `ncl groups config add-mount` verb yet (tracked in [#2395](https://github.com/nanocoai/nanoclaw/issues/2395)). Until that ships, edit the DB directly via the in-tree wrapper (`scripts/q.ts`):

```bash
GROUP_ID='<group-id>'
HOST_PATH="$HOME/.gtasks-mcp"
MOUNT=$(jq -cn --arg h "$HOST_PATH" '{hostPath:$h, containerPath:".gtasks-mcp", readonly:false}')
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
  SET additional_mounts = json_insert(additional_mounts, '\$[#]', json('$MOUNT')), \
      updated_at = datetime('now') \
  WHERE agent_group_id = '$GROUP_ID';"
```

Run from your NanoClaw project root (where `data/v2.db` lives). The `$[#]` placeholder is SQLite JSON1's append-to-end notation; it's `\$`-escaped so bash doesn't arithmetic-expand it before sqlite sees it.

**Switch to `ncl groups config add-mount` once #2395 lands.** Update this skill at that time.

`containerPath` is relative (mount-security rejects absolute paths — additional mounts land at `/workspace/extra/<relative>`).

**Same-group-as-gmail tip:** if this group already has gmail/calendar/drive MCP + mounts, all coexist — `json_insert` appends without disturbing existing entries.

## Phase 4: Build and Restart

```bash
pnpm run build
```

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

Kill any existing agent containers so they respawn with the new mcpServers config:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## Phase 5: Verify

### Test from a wired agent

> Send: **"list my Google Tasks"** or **"add a task to buy milk on my default list"**.
>
> First call takes 2–3s while the MCP server starts and OneCLI does the token exchange.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log | grep -iE 'gtasks|tasks|mcp'
```

Common signals:
- `command not found: google-tasks-mcp` → image not rebuilt.
- `ENOENT ...tokens.json` → mount missing. Check the mount allowlist.
- `401 Unauthorized` from `*.googleapis.com` → OneCLI isn't injecting; verify agent's secret mode and that Google Tasks is connected.
- Agent says "I don't have Tasks tools" → the `gtasks` MCP server isn't registered in this group's `mcpServers` (re-run Phase 3 and restart), or the agent-runner image is stale (`./container/build.sh`, `--no-cache` if suspicious).

## Removal

See [REMOVE.md](REMOVE.md) — unregisters the MCP server, drops the `.gtasks-mcp` mount, deletes the copied test, reverts the Dockerfile edits, and rebuilds.

## Credits & references

- **MCP server:** [`@scottie-will/google-tasks-mcp`](https://github.com/scottie-will/google-tasks-mcp) — MIT-licensed, modeled after google-calendar-mcp.
- **Skill pattern:** direct sibling of [`/add-gcal-tool`](../add-gcal-tool/SKILL.md) and [`/add-gmail-tool`](../add-gmail-tool/SKILL.md); same OneCLI stub mechanism.
