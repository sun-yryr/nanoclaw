---
name: add-manual-memory
description: Add persistent memory via prompt-based file I/O for any provider (including opencode). Agents recall past context via memory_read and save new insights via memory_write tools.
---

# Add Manual Memory — Prompt-Based Persistent Memory

Adds persistent memory to any agent provider without requiring mnemon or Claude Code hooks. The agent uses `memory_read` and `memory_write` tools to manage a JSON memory file that persists across sessions.

## Provider Compatibility

Works with **any** provider (opencode, claude, etc.) because the memory is implemented as generic MCP-style tools injected into the provider's tool list.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'memory-tools' container/agent-runner/src/providers/opencode.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Apply Changes

### 1. Copy memory-tools.ts

```bash
cp .agents/skills/add-manual-memory/memory-tools.ts container/agent-runner/src/memory-tools.ts
```

### 2. Modify opencode.ts

Add the import at the top (after the existing imports):

```typescript
import { memoryReadTool, memoryWriteTool } from '../memory-tools.js';
```

Add the memory prompt to the system instructions (after `systemInstructions` is pushed, add another system message):

```typescript
this.messages.push({
  role: 'system',
  content:
    'You have a persistent memory. At the start of each conversation, use memory_read to recall past context. ' +
    'When you learn something important about the user (preferences, facts, context), use memory_write to save it. ' +
    'Always include previous memory when writing updates. Memory persists across sessions.',
});
```

Inject memory tools into the tools object (after MCP tools are loaded):

```typescript
// Inject memory tools
tools['memory_read'] = memoryReadTool;
tools['memory_write'] = memoryWriteTool;
```

### 3. Build and typecheck

```bash
cd container/agent-runner && bun run typecheck
```

## Phase 3: Restart and Verify

### Restart the service

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)  # Linux
```

### Test memory

1. Start a conversation
2. Tell the agent something memorable (e.g., "My name is Alice")
3. End the session
4. Start a new conversation
5. Ask "What is my name?" — the agent should use `memory_read` to recall "Alice"

## Memory Storage

Memory is stored at `/workspace/agent/.claude/memory.json` inside the container, which maps to the per-agent-group `.claude/` directory on the host. To find the exact host path:

```bash
docker inspect <container> --format '{{range .Mounts}}{{if eq .Destination "/workspace/agent"}}{{.Source}}{{end}}{{end}}'
```

To reset memory, delete the `memory.json` file.

## Troubleshooting

### `memory_read` not called

The model may not automatically call the tool on the first turn. If the agent doesn't recall memory, explicitly ask it to "check your memory".

### Memory file not found

The directory is created automatically on first write. If `memory_read` returns "No memory found", the agent hasn't saved anything yet.

### File permission errors

Ensure the container user has write access to `/workspace/agent/.claude/`. This is usually a mounted host directory, so check host permissions.
