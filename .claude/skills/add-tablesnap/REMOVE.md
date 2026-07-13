# Remove tablesnap

Every step is idempotent — safe to re-run.

## 1. Strip the Dockerfile install layers

1. Delete the `tablesnap-build` stage at the top of `container/Dockerfile` (`ARG TABLESNAP_VERSION` + `FROM golang:... AS tablesnap-build` through the `go build` `RUN`).
2. Remove `fonts-ipafont-gothic` from the apt install list.
3. Delete the tablesnap install block (`COPY --from=tablesnap-build`, emoji install `RUN`, and `ENV TABLESNAP_FONT=...`).

Also remove the patch directory:

```bash
rm -rf container/tablesnap
```

## 2. Remove the container skill

```bash
rm -rf container/skills/tablesnap
for session_dir in data/v2-sessions/ag-*; do
  rm -f "$session_dir/.claude-shared/skills/tablesnap"
done
```

## 3. Revert Discord formatting wording

In `container/skills/discord-formatting/SKILL.md`, restore the tables bullet to:

```markdown
- **NO** tables (Discord does not render markdown tables — use bullets or a code block)
```

Remove the quick rule about tablesnap if present.

## 4. Delete the dependency guard test

```bash
rm -f src/tablesnap-dockerfile.test.ts
```

## 5. Rebuild and restart

```bash
./container/build.sh
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```
