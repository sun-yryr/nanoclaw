# Remove tablesnap

Every step is idempotent — safe to re-run.

## 1. Strip the Dockerfile install layer

Open `container/Dockerfile` and delete the tablesnap block (the `# ---- tablesnap` comment through the `chown` line):

```dockerfile
# ---- tablesnap — markdown tables → PNG ---------------------------------------
ARG TABLESNAP_VERSION=1.0.0
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/joargp/tablesnap/releases/download/v${TABLESNAP_VERSION}/tablesnap-linux-${ARCH}.tar.gz" \
    | tar -xz -C /tmp && \
    install -m 0755 "/tmp/tablesnap-linux-${ARCH}" /usr/local/bin/tablesnap && \
    rm -f "/tmp/tablesnap-linux-${ARCH}" "/tmp/._tablesnap-linux-${ARCH}" && \
    HOME=/home/node tablesnap emojis install && \
    chown -R node:node /home/node/.cache
```

If the block is already gone, skip this step.

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

Remove the quick rule about tablesnap if present. Re-sync discord-formatting to session skill dirs if you keep Discord:

```bash
for session_dir in data/v2-sessions/ag-*; do
  if [ -d "$session_dir/.claude-shared/skills/discord-formatting" ]; then
    rsync -a container/skills/discord-formatting/ "$session_dir/.claude-shared/skills/discord-formatting/"
  fi
done
```

## 4. Delete the dependency guard test

```bash
rm -f src/tablesnap-dockerfile.test.ts
```

## 5. Rebuild and restart

```bash
./container/build.sh
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```
