---
name: add-tablesnap
description: Install tablesnap so agents render markdown tables as PNG images (for Discord and other chats that don't render tables). Use when the user wants table screenshots, Discord table images, or tablesnap in the agent container.
---

# Add tablesnap

Install [tablesnap](https://github.com/joargp/tablesnap) — a CLI that converts markdown tables to PNG — into the agent container image, and teach agents to use it when sending tabular data (especially Discord).

**Principle:** Do the work — don't tell the user to do it.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'TABLESNAP_VERSION' container/Dockerfile && echo "Already applied" || echo "Not applied"
```

If already applied, re-run Phase 2 anyway — every step is idempotent — then continue to Phase 3.

### Check latest tablesnap version

```bash
curl -fsSL https://api.github.com/repos/joargp/tablesnap/releases/latest | grep '"tag_name"'
```

Note the version without the `v` prefix (e.g. `1.0.0`) for `TABLESNAP_VERSION`.

## Phase 2: Apply Changes

### 1. Dockerfile — build patched tablesnap + IPA Gothic

Insert a golang build stage at the top of `container/Dockerfile` (before `FROM node:22-slim`) and the install block above `# ---- Bun runtime` (skip pieces already present):

```dockerfile
ARG TABLESNAP_VERSION=1.0.0
FROM golang:1.24-bookworm AS tablesnap-build
ARG TABLESNAP_VERSION
WORKDIR /src
RUN git clone --depth 1 --branch "v${TABLESNAP_VERSION}" https://github.com/joargp/tablesnap.git .
COPY tablesnap/cjk-font.patch /tmp/cjk-font.patch
RUN git apply /tmp/cjk-font.patch && \
    CGO_ENABLED=0 go build -o /tablesnap ./cmd/tablesnap
```

In the apt install list of the node stage, add `fonts-ipafont-gothic` (Japanese TTF for table text; ~12MB — smaller than full `fonts-noto-cjk`).

Then after mnemon / before Bun:

```dockerfile
COPY --from=tablesnap-build /tablesnap /usr/local/bin/tablesnap
RUN HOME=/home/node tablesnap emojis install && \
    chown -R node:node /home/node/.cache
ENV TABLESNAP_FONT=/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf
```

Copy the patch from the skill:

```bash
mkdir -p container/tablesnap
cp .claude/skills/add-tablesnap/tablesnap/cjk-font.patch container/tablesnap/cjk-font.patch
```

The upstream release embeds Inter only (no CJK). The patch prefers `TABLESNAP_FONT` / IPA Gothic, then falls back to Inter. `emojis install` still downloads Twemoji for status glyphs.

### 2. Copy the container skill

```bash
rsync -a .claude/skills/add-tablesnap/container-skills/ container/skills/
head -5 container/skills/tablesnap/SKILL.md
```

### 3. Point Discord formatting at tablesnap

In `container/skills/discord-formatting/SKILL.md`, replace the "NO tables" bullet under **What NOT to use** so it tells the agent to use tablesnap + `send_file` instead of markdown tables / code blocks:

```markdown
- **NO** markdown tables in message text (Discord does not render them — use the `tablesnap` skill: render to PNG, then `send_file`)
```

Also add this quick rule under **Quick rules** if missing:

```markdown
6. Tabular data → `tablesnap` PNG + `send_file` (never paste a markdown table)
```

### 4. Copy and run the dependency guard

```bash
cp .claude/skills/add-tablesnap/tablesnap-dockerfile.test.ts src/tablesnap-dockerfile.test.ts
pnpm exec vitest run src/tablesnap-dockerfile.test.ts
```

### 5. Rebuild and smoke-test the image

```bash
./container/build.sh
source setup/lib/install-slug.sh
docker run --rm --entrypoint tablesnap "$(container_image_base):latest" -h
```

## Phase 3: Sync and Restart

Groups with `skills: "all"` pick up `container/skills/tablesnap` on the next container spawn via `syncSkillSymlinks` (symlink → `/app/skills/tablesnap`). No host-side rsync needed.

If a group uses an explicit skills list, add `tablesnap`:

```bash
# Inspect
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT agent_group_id, skills FROM container_configs"

# For any row that is a JSON array (not "all"), merge in "tablesnap" and write back
# with ncl groups config update, or UPDATE container_configs SET skills = '...' .
```

Optionally ensure the symlink exists before the next wake (host path is dangling until the container mounts `/app/skills`):

```bash
for session_dir in data/v2-sessions/ag-*; do
  skills="$session_dir/.claude-shared/skills"
  [ -d "$skills" ] || continue
  if [ ! -e "$skills/tablesnap" ] && [ ! -L "$skills/tablesnap" ]; then
    ln -s /app/skills/tablesnap "$skills/tablesnap"
    echo "Linked tablesnap in $session_dir"
  fi
done
```

### Restart running containers

```bash
docker ps --format "{{.ID}} {{.Names}}" | grep nanoclaw-v2 | awk '{print $1}' | xargs -r docker stop
```

Or restart the service so new wakes pick up the rebuilt image:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
```

## Done

Agents can turn markdown tables into PNGs with `tablesnap` and deliver them via `send_file`. See the `tablesnap` container skill for the workflow.

## Troubleshooting

### `tablesnap: command not found` in container

Image wasn't rebuilt after the Dockerfile layer. Run `./container/build.sh` and restart containers.

### Emoji show as □

Full Twemoji pack missing. Inside a running container:

```bash
tablesnap emojis install
```

Rebuild includes this step; only needed if the cache was wiped.

### CJK text looks like tofu

tablesnap embeds Inter, which has limited CJK coverage. Prefer ASCII/latin labels in headers, or keep Japanese in a short caption via `send_file`'s `text` and use symbols/emoji in the table body.
