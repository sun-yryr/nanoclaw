---
name: tablesnap
description: Convert markdown table text to a PNG image with the tablesnap CLI. Use when you need to turn a markdown table into an image.
---

# tablesnap

Turn markdown table text into a PNG with the `tablesnap` CLI.

## Usage

```bash
# From a file
cat > /workspace/agent/table.md <<'EOF'
| Name | Status |
|------|--------|
| Alpha | ✅ |
| Beta | 🟡 |
EOF

tablesnap -i /workspace/agent/table.md -o /workspace/agent/table.png
```

```bash
# From stdin
echo '| A | B |
|---|---|
| 1 | 2 |' | tablesnap -o /workspace/agent/table.png
```

### Options

| Flag | Default | Notes |
|------|---------|--------|
| `-i` | stdin | Input markdown file |
| `-o` | stdout | Output PNG path (use `/workspace/agent/*.png`) |
| `--theme` | `dark` | `dark` or `light` |
| `--font-size` | `14` | Font size in pixels |
| `--padding` | `10` | Cell padding in pixels |

```bash
tablesnap -i /workspace/agent/table.md --theme dark --font-size 16 -o /workspace/agent/table.png
```

Bundled status emoji that render without extra setup: ✅ ❌ 🔴 🟢 🟡 ⭕ ⚠️
