# Remove Mapbox Tool

Idempotent - safe to run even if some steps were never applied.

## 1. Unregister the MCP server (per group)

For each group that had Mapbox wired (`ncl groups list` to enumerate):

```bash
ncl groups config remove-mcp-server --id <group-id> --name mapbox
```

## 2. Delete the copied test file

```bash
rm -f src/mapbox-dockerfile.test.ts
```

## 3. Revert the Dockerfile edits

Remove the `ARG MAPBOX_MCP_VERSION=...` line and the `@mapbox/mcp-server@${MAPBOX_MCP_VERSION}` entry from the pnpm global-install block in `container/Dockerfile`. If it had a standalone `RUN ... pnpm install -g "@mapbox/mcp-server@..."` block, delete that whole block.

## 4. Rebuild and restart

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# Linux
systemctl --user restart $(systemd_unit)

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

Kill any running agent containers so they respawn without the `mapbox` MCP server:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## 5. Optional: remove or unassign the OneCLI credential

Only do this if no other tool uses the same Mapbox credential. Do not print the token value.

```bash
MAPBOX_SECRET_ID=$(onecli secrets list | jq -r '.data[] | select((.name // "") | test("(?i)mapbox")) | .id' | head -1)
if [ -n "$MAPBOX_SECRET_ID" ]; then
  for agent in $(onecli agents list | jq -r '.data[].id'); do
    REMAINING=$(onecli agents secrets --id "$agent" | jq -r --arg id "$MAPBOX_SECRET_ID" '[.data[] | select(. != $id)] | join(",")')
    onecli agents set-secrets --id "$agent" --secret-ids "$REMAINING"
  done
fi
```

If the credential itself was created only for this tool, delete it through the normal OneCLI credential-management workflow.

## Verification

After removal, in a wired agent asking it to "get driving directions with Mapbox" should report no Mapbox tool, and the dependency-guard test is gone:

```bash
ls src/mapbox-dockerfile.test.ts 2>&1   # No such file or directory
```
