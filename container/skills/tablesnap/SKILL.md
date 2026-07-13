---
name: tablesnap
description: Convert markdown tables to PNG with tablesnap and send them as images. Use when sending tabular data on Discord, Telegram, Slack, or any channel that does not render markdown tables.
allowed-tools: Bash(tablesnap:*), Bash(echo:*), Bash(cat:*)
---

# tablesnap — tables as images

Messaging apps (Discord especially) do **not** render markdown tables. Convert them to PNG with `tablesnap`, then deliver with `send_file`.

## When to use

- Any reply that would be a markdown table (2+ columns of structured data)
- Discord / Telegram / Slack destinations (and anywhere tables look broken as text)
- Status grids, comparison lists, schedules, rankings

Do **not** paste `| col |` markdown tables into `send_message` text on those channels.

## Workflow

1. Write a GitHub-flavored markdown table to a file (or pipe via stdin).
2. Run `tablesnap` → PNG under `/workspace/agent/`.
3. Call `send_file` with that path (optional caption via `text`).

```bash
# From a file
cat > /workspace/agent/table.md <<'EOF'
| Name | Status | Due |
|------|--------|-----|
| Alpha | ✅ | Mon |
| Beta | 🟡 | Wed |
EOF

tablesnap -i /workspace/agent/table.md -o /workspace/agent/table.png
```

```bash
# From stdin
echo '| A | B |
|---|---|
| 1 | 2 |' | tablesnap -o /workspace/agent/table.png
```

Then:

```
send_file({ path: "/workspace/agent/table.png", text: "optional caption", filename: "table.png" })
```

## Options

| Flag | Default | Notes |
|------|---------|--------|
| `-i` | stdin | Input markdown file |
| `-o` | stdout | Always set this to a `.png` under `/workspace/agent/` |
| `--theme` | `dark` | Prefer `dark` for Discord/Slack dark UI; `light` if asked |
| `--font-size` | `14` | Bump for dense tables (e.g. `16`) |
| `--padding` | `10` | Cell padding |

```bash
tablesnap -i /workspace/agent/table.md --theme dark --font-size 16 -o /workspace/agent/table.png
```

## Emoji

Bundled: ✅ ❌ 🔴 🟢 🟡 ⭕ ⚠️. Full Twemoji pack is preinstalled in the image (`tablesnap emojis install` at build). Prefer those for status columns.

## Hard rules

1. **Table → PNG → `send_file`**. Never rely on markdown table rendering in chat.
2. Keep a short caption in `send_file`'s `text` if the image needs context; put the grid in the PNG.
3. Write outputs under `/workspace/agent/` so paths stay writable and easy to find.
4. One logical table per image. Split very wide tables rather than shrinking font to illegible sizes.

## Quick example (Discord)

```bash
cat > /workspace/agent/status.md <<'EOF'
| Task | Owner | Status |
|------|-------|--------|
| Deploy | you | ✅ |
| Docs | me | 🟡 |
EOF
tablesnap -i /workspace/agent/status.md -o /workspace/agent/status.png
```

`send_file({ path: "/workspace/agent/status.png", text: "今週のステータス" })`
