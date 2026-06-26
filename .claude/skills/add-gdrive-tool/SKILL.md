---
name: add-gdrive-tool
description: Add Google Drive as an MCP tool (search, list, read files including Docs/Sheets export) using OneCLI-managed OAuth. Mirrors /add-gmail-tool's stub pattern — no raw credentials ever reach the container; OneCLI injects real tokens at request time.
---

# Add Google Drive Tool (OneCLI-native)

This skill wires [`@modelcontextprotocol/server-gdrive`](https://www.npmjs.com/package/@modelcontextprotocol/server-gdrive) into selected agent groups. The MCP server reads stub credentials containing the `onecli-managed` placeholder; the OneCLI gateway intercepts outbound calls to `drive.googleapis.com` / `oauth2.googleapis.com` and swaps the bearer for the real OAuth token from its vault.

Tools exposed (surfaced as `mcp__gdrive__<name>`): `search` — search Drive files by query. Resources: `gdrive:///<file_id>` — read file contents (Docs → Markdown, Sheets → CSV, Slides → plain text, other files in native format).

**Why this package:** Official MCP reference server, stdio-native, credential paths via env vars (`GDRIVE_OAUTH_PATH`, `GDRIVE_CREDENTIALS_PATH`) — same stub pattern as Gmail. Read/search only (`drive.readonly` scope); no create/upload/delete in this server.

**Why this pattern:** v2's invariant is that containers never receive raw API keys (CHANGELOG 2.0.0). Same stub pattern `/add-gmail-tool` uses. This skill is deliberately a sibling, not a combined "Google Workspace" skill — installs independently and removes cleanly.

## Phase 1: Pre-flight

### Verify OneCLI has Google Drive connected

```bash
onecli apps get --provider google-drive
```

Expected: `"connection": { "status": "connected" }` with scopes including `drive.readonly`.

If not connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Google Drive, and click Connect. Sign in with the Google account the agent should act as. `drive.readonly` is the minimum useful scope for search and read.

### Verify stub credentials exist

```bash
ls -la ~/.gdrive-mcp/gcp-oauth.keys.json ~/.gdrive-mcp/credentials.json 2>&1
```

If both exist with `onecli-managed`:

```bash
grep -l onecli-managed ~/.gdrive-mcp/gcp-oauth.keys.json ~/.gdrive-mcp/credentials.json
```

...skip to Phase 2. If either file has real credentials (no `onecli-managed`), **STOP** — back up and delete before proceeding.

If absent, write them:

```bash
mkdir -p ~/.gdrive-mcp
cat > ~/.gdrive-mcp/gcp-oauth.keys.json <<'EOF'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
EOF
cat > ~/.gdrive-mcp/credentials.json <<'EOF'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/drive.readonly"
}
EOF
chmod 600 ~/.gdrive-mcp/*.json
```

### Verify mount allowlist covers the path

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

`~/.gdrive-mcp` must sit under an `allowedRoots` entry.

### Check agent secret-mode

For each target agent group, confirm OneCLI will inject the Google Drive token:

```bash
onecli agents list
```

`secretMode: all` is sufficient. If `selective`, explicitly assign the Drive secret.

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q 'GDRIVE_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block and add:

```dockerfile
ARG GDRIVE_MCP_VERSION=2025.1.14
```

Append to an existing pnpm global-install block (or add a standalone block if no other Google MCP skills are applied):

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@modelcontextprotocol/server-gdrive@${GDRIVE_MCP_VERSION}"
```

`container/agent-runner/src/providers/claude.ts` derives the allow-pattern dynamically from each group's `mcpServers` map (`Object.keys(this.mcpServers).map(mcpAllowPattern)`), so registering `gdrive` in Phase 3 automatically allows `mcp__gdrive__*`.

### Install the dependency-guard test

Copy the guard test into the host test tree (vitest):

```bash
cp .claude/skills/add-gdrive-tool/gdrive-dockerfile.test.ts src/gdrive-dockerfile.test.ts
pnpm exec vitest run src/gdrive-dockerfile.test.ts
```

`cp` overwrites in place, so re-running this skill is safe.

### Rebuild the container image

```bash
./container/build.sh
```

## Phase 3: Wire Per-Agent-Group

For each agent group, persist two changes to the **central DB** (`data/v2.db`): the `mcpServers.gdrive` entry and an `additionalMounts` entry for `.gdrive-mcp`. Both flow through `materializeContainerJson` on every spawn, so editing `groups/<folder>/container.json` by hand does **not** stick — that file is regenerated from the DB.

### Register the MCP server

For each chosen `<group-id>` (use `ncl groups list` to enumerate):

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name gdrive \
  --command mcp-server-gdrive \
  --args '[]' \
  --env '{"GDRIVE_OAUTH_PATH":"/workspace/extra/.gdrive-mcp/gcp-oauth.keys.json","GDRIVE_CREDENTIALS_PATH":"/workspace/extra/.gdrive-mcp/credentials.json"}'
```

Approval behaviour depends on where you run it: from inside an agent's container `ncl` write verbs are approval-gated (admin approves before it lands); from a host operator shell with full scope, it executes immediately. Either way, the response tells you which path it took.

### Add the `.gdrive-mcp` mount

There is no `ncl groups config add-mount` verb yet (tracked in [#2395](https://github.com/nanocoai/nanoclaw/issues/2395)). Until that ships, edit the DB directly via the in-tree wrapper (`scripts/q.ts`):

```bash
GROUP_ID='<group-id>'
HOST_PATH="$HOME/.gdrive-mcp"
MOUNT=$(jq -cn --arg h "$HOST_PATH" '{hostPath:$h, containerPath:".gdrive-mcp", readonly:false}')
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
  SET additional_mounts = json_insert(additional_mounts, '\$[#]', json('$MOUNT')), \
      updated_at = datetime('now') \
  WHERE agent_group_id = '$GROUP_ID';"
```

Run from your NanoClaw project root (where `data/v2.db` lives). The `$[#]` placeholder is SQLite JSON1's append-to-end notation; it's `\$`-escaped so bash doesn't arithmetic-expand it before sqlite sees it.

**Switch to `ncl groups config add-mount` once #2395 lands.** Update this skill at that time.

`containerPath` is relative (mount-security rejects absolute paths — additional mounts land at `/workspace/extra/<relative>`).

**Same-group-as-gmail tip:** if this group already has gmail/calendar MCP + mounts, all coexist — `json_insert` appends without disturbing existing entries.

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

> Send: **"search my Google Drive for budget spreadsheet"** or **"read the contents of my project plan doc in Drive"**.
>
> First call takes 2–3s while the MCP server starts and OneCLI does the token exchange.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log | grep -iE 'gdrive|drive|mcp'
```

Common signals:
- `command not found: mcp-server-gdrive` → image not rebuilt.
- `ENOENT ...credentials.json` → mount missing. Check the mount allowlist.
- `401 Unauthorized` from `*.googleapis.com` → OneCLI isn't injecting; verify agent's secret mode and that Google Drive is connected.
- Agent says "I don't have Drive tools" → the `gdrive` MCP server isn't registered in this group's `mcpServers` (re-run Phase 3 and restart), or the agent-runner image is stale (`./container/build.sh`, `--no-cache` if suspicious).

## Removal

See [REMOVE.md](REMOVE.md) — unregisters the MCP server, drops the `.gdrive-mcp` mount, deletes the copied test, reverts the Dockerfile edits, and rebuilds.

## Credits & references

- **MCP server:** [`@modelcontextprotocol/server-gdrive`](https://www.npmjs.com/package/@modelcontextprotocol/server-gdrive) — official MCP reference server, MIT-licensed.
- **Skill pattern:** direct sibling of [`/add-gmail-tool`](../add-gmail-tool/SKILL.md) and [`/add-gcal-tool`](../add-gcal-tool/SKILL.md); same OneCLI stub mechanism.
