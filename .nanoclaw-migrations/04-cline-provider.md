# Cline Provider (OpenAI-compatible) — KEEP

`SOURCE=5183f47ac903b36fa325d24900cfd5fb499149d1`

**Intent:** Full agent backend via `@cline/sdk` with `providerId: 'openai-compatible'`. Auth via OneCLI rewriting `Authorization` (container only has placeholder). Sessions persisted like Claude (opaque UUID + on-disk snapshot). Skills progressive disclosure + mnemon memory tools + MCP from container config.

There is **no** upstream `/add-cline`. This is a full file-tree port.

## Copy as-is from SOURCE

### Host

- `src/providers/cline.ts`
- Append (only) to `src/providers/index.ts`:
  ```typescript
  import './cline.js';
  ```
  Do **not** import `./opencode.js`.

### Container agent-runner

- `container/agent-runner/src/providers/cline.ts`
- `container/agent-runner/src/providers/cline.test.ts`
- `container/agent-runner/src/providers/cline-sessions.ts`
- `container/agent-runner/src/providers/cline-sessions.test.ts`
- `container/agent-runner/src/providers/cline-builtin-tools.ts`
- `container/agent-runner/src/providers/cline-builtin-tools.test.ts`
- `container/agent-runner/src/claude-md-resolve.ts` (+ test)
- `container/agent-runner/src/skills/catalog.ts` (+ test)
- `container/agent-runner/src/media/` (entire directory — Kimi / multimodal / Moonshot `/files` fallback)
- `container/agent-runner/src/memory-tools.ts` (mnemon-backed tools; used by patterns shared with Cline)

Register in `container/agent-runner/src/providers/index.ts`:

```typescript
import './cline.js';
// no opencode
```

### Dependency

In `container/agent-runner/package.json` add (pin as SOURCE):

```json
"@cline/sdk": "^0.0.47"
```

Then `cd container/agent-runner && bun install` and commit `bun.lock`.

## Surgical: `poll-loop.ts`

Port SOURCE behaviour needed by Cline:

- Build multimodal `userContent` from inbound messages / attachments.
- Pass `userContent` into provider `query`.
- Re-throw provider stream errors after the turn so failures surface (do not swallow).

Re-read upstream `poll-loop.ts` and merge carefully.

## Host env injection (already in `src/providers/cline.ts`)

Critical OneCLI pattern — preserve verbatim:

```typescript
if (dotenv.CLINE_BASE_URL) {
  env.CLINE_BASE_URL = dotenv.CLINE_BASE_URL;
  env.OPENCODE_GO_API_KEY = 'placeholder';
}
```

Also pass through when set: `CLINE_MODEL`, `CLINE_API`, `CLINE_REASONING_EFFORT`, `CLINE_TRANSCRIPT_MAX_TOKENS`, `OPENCODE_MODEL`, `MOONSHOT_API_BASE_URL`, `MOONSHOT_API_KEY`.

## Runtime env (.env — do not commit)

| Variable | Role |
|----------|------|
| `CLINE_BASE_URL` | API base **without** endpoint suffix (e.g. `https://opencode.ai/zen/go/v1`) |
| `CLINE_MODEL` | Model id (e.g. `deepseek-v4.1-flash`, `gpt-6-luna`) |
| `CLINE_API` | `chat` (default) → chat/completions; `responses` → Responses API (Luna/Grok). Do not put `/responses` in the base URL |
| `CLINE_REASONING_EFFORT` | Optional; passed through to Cline as `reasoningEffort`. Else use `ncl groups config update --effort` |
| `OPENCODE_MODEL` | Fallback model id |
| `CLINE_TRANSCRIPT_*` | History trim / rotate |
| `MOONSHOT_*` | Video upload when base is OpenCode Go (no `/files`) |

```bash
# Chat Completions (DeepSeek, Kimi, …)
CLINE_BASE_URL=https://opencode.ai/zen/go/v1
CLINE_MODEL=deepseek-v4.1-flash
# CLINE_API omitted = chat

# Responses API (GPT Luna, …)
CLINE_MODEL=gpt-6-luna
CLINE_API=responses
# optional: CLINE_REASONING_EFFORT=high
```

OneCLI must have a generic secret whose host pattern matches `CLINE_BASE_URL` hostname and rewrites `Authorization`.

## Agent config

After cutover, live groups should remain `provider=cline` in `container_configs` (DB untouched by git). Confirm with `ncl groups config get`.

## DROP related OpenCode bits

Remove if present after base skills:

- `src/providers/opencode.ts` + barrel import
- `container/agent-runner/src/providers/opencode.ts`, `mcp-to-opencode.*`, factory tests for opencode
- Dockerfile `OPENCODE_VERSION` / `opencode-ai@…`
- Unused deps: `@opencode-ai/sdk`, and `ai` / `@ai-sdk/openai-compatible` if nothing else needs them

## Verification

- Host build includes `src/providers/cline.ts`.
- `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` (with bun types).
- Container tests for cline-sessions / builtin-tools if bun available.