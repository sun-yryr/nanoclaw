# Remove Google Drive Tool

Idempotent — safe to run even if some steps were never applied.

## 1. Unregister the MCP server (per group)

For each group that had Drive wired (`ncl groups list` to enumerate):

```bash
ncl groups config remove-mcp-server --id <group-id> --name gdrive
```

## 2. Remove the `.gdrive-mcp` mount from the DB (per group)

There is no `ncl groups config remove-mount` verb yet (tracked in [#2395](https://github.com/nanocoai/nanoclaw/issues/2395)). Until it ships, drop the entry via the in-tree wrapper (`scripts/q.ts`):

```bash
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
  SET additional_mounts = (SELECT json_group_array(value) FROM json_each(additional_mounts) \
                           WHERE json_extract(value, '\$.containerPath') != '.gdrive-mcp'), \
      updated_at = datetime('now') \
  WHERE agent_group_id = '<group-id>';"
```

## 3. Delete the copied test file

```bash
rm -f src/gdrive-dockerfile.test.ts
```

## 4. Revert the Dockerfile edits

Remove the `ARG GDRIVE_MCP_VERSION=...` line and the `@modelcontextprotocol/server-gdrive@${GDRIVE_MCP_VERSION}` entry from the pnpm global-install block in `container/Dockerfile`. If it had a standalone `RUN ... pnpm install -g "@modelcontextprotocol/server-gdrive@..."` block, delete that whole `RUN` line.

## 5. Rebuild and restart

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

Kill any running agent containers so they respawn without the `gdrive` MCP server:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## 6. Optional: remove stubs and disconnect OneCLI

```bash
rm -rf ~/.gdrive-mcp/
onecli apps disconnect --provider google-drive
```

## Verification

After removal, in a wired agent asking it to "search my Google Drive" should report no Drive tool, and the dependency-guard test is gone:

```bash
ls src/gdrive-dockerfile.test.ts 2>&1   # No such file or directory
```
