# Cline delegation v1

This fork's Cline provider uses `delegate_tasks` when `CLINE_SPAWN_MODEL` resolves
to an enabled child configuration. The parent keeps `ask_question` and
`submit_and_exit`; its execution tool is `delegate_tasks`. Without a spawn model,
the existing Cline tool configuration remains in use.

Each batch accepts 1–4 independent tasks with a unique `id`, an `objective`,
optional minimal `context`, and `expectedOutput`. Strings are trimmed; empty
strings and unknown fields (including a caller-supplied `systemPrompt`) are
rejected. Limits are 40/1500/3000/1000 characters respectively. The harness supplies
one fixed worker prompt. Dependencies belong in a subsequent batch after the
parent reviews the previous results.

Results preserve input order and report `completed`, `partial`, `failed`, or
`cancelled`, elapsed milliseconds (including queue time), and available text,
iterations, and token usage. SDK `completed` maps to completed, `aborted` to
cancelled, and other finish reasons to partial. Exceptions map to failed; error
text is intentionally generic to avoid exposing request or credential data.
A child failure does not discard its siblings. No harness retries occur.

## Bounds

| Environment variable | Default | Accepted range |
| --- | --- | --- |
| `CLINE_DELEGATION_MAX_CONCURRENCY` | 3 | 1–3 |
| `CLINE_DELEGATION_MAX_TASKS_PER_BATCH` | 4 | 1–4 |
| `CLINE_DELEGATION_MAX_TASKS_PER_TURN` | 8 | 1–8 |

These are conservative v1 ceilings; overrides can lower them. Invalid or empty
values fail at tool construction. Concurrent batches reserve the turn budget
synchronously and share one FIFO semaphore. A task reservation remains consumed
after failure or cancellation. Even single-task batches are bounded by the turn
budget. Budgets reset immediately before each parent `run()` or `continue()`;
restoring a session does not carry the old budget forward. Existing
`CLINE_SPAWN_MAX_ITERATIONS` and authentication variables retain their behavior.

Children have a 300-second deadline after obtaining a child slot. The outer tool
allows the entire turn's maximum queued work plus 30 seconds, rather than the
SDK spawn tool's 300-second single-child timeout. Parent cancellation reaches
queued children, model calls, and tool execution. Timeouts abort the signal and
await the child and any still-running tool handlers; they do not race and abandon
background work. A tool that ignores cancellation can delay termination until
it settles. Its child slot and execution lock remain held during that time.

## Isolation and fixed SDK behavior

Each task constructs a separate SDK spawn tool, delegated config provider, MCP
deferral state, and OpenCode session header. A child's session header stays stable
across model turns and differs from other children and the parent. Workers cannot
access `ask_question`, `spawn_agent`, or `delegate_tasks`.

`@cline/sdk@0.0.47` advertises `SpawnAgentToolConfig.hooks` but its spawn
implementation does not forward that field. It does forward
`configProvider.getRuntimeConfig().hooks`. NanoClaw puts the deferral hooks in
that runtime config and fails closed on hook errors. Tests exercise the real
pinned SDK against a local streaming endpoint: a deferred tool call is blocked,
search activates it, and a sibling's schemas remain unactivated.

The pinned SDK may omit a tool-context cancellation signal. The harness combines
its own child deadline and query cancellation with any SDK signal and forwards
them explicitly to tool handlers. The provider's query abort also stops the
parent Agent.

## Side effects and authentication

Model requests overlap. All worker tool execution is serialized across the
parent's batches because v1 has no trusted read/write tool classification.
This includes unknown MCP tools, files, shell, and memory writes; it avoids
inferring permission from tool names. This lock does not order whole multi-tool
transactions. The existing host permission and approval checks remain authoritative.
MCP connections and their existing registry-lifetime retry budget are intentionally
shared; the retry-budget behavior is covered by a multi-child test.

SIWC fetch rewriting applies only to Responses calls on `api.openai.com`, so a
SIWC parent cannot strip fields from a child using a different Responses host.
The rewrite also installs when only the child uses SIWC. Gateway authentication
and parent/child endpoint selection remain in their existing paths.

## Migration, verification, and rollback

Detect: `CLINE_SPAWN_MODEL` enables the delegation mode. This changes the parent
execution tool name from `spawn_agent` to `delegate_tasks`.

Why: batches enable independent work to overlap while each worker owns its
configuration and deferred-tool state.

Apply: build the agent image and restart this install through its normal service
workflow. Existing env settings continue to work; add the optional bounds above
only when lower limits are desired. Update any custom parent instructions that
refer to `spawn_agent` to describe the task-array API. The harness's generated
parent hint already uses the new API.

Verify:

```sh
cd container/agent-runner
bun test --isolate
cd ../..
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm run typecheck
pnpm exec vitest run src/providers/cline.test.ts
```

Use a disposable chat to check a bounded lookup, independent lookups in one
batch, and a dependent follow-up batch. Local tests validate SDK execution and
request shaping. A live deployment smoke test also passed through the existing
OneCLI gateway with a SIWC `gpt-6.1-sol` parent and OpenCode Go
`deepseek-v4.1-flash` workers: three synthetic tasks completed, model requests
reached a peak of three concurrent calls, three distinct child session headers
were observed, and each child activated and called a synthetic MCP tool before
the parent synthesized the results. No internal file contents or account data
were supplied to the models. Real remote MCP services still require an operator
smoke test.

Rollback: restore the previous Cline provider files, rebuild the image, and
restart. Alternatively unset `CLINE_SPAWN_MODEL` to use the original direct-tool
Cline mode. No database or session-schema migration is required.

The next stage (PR2 in the design) is trusted research/action tool policy and
structured telemetry/evaluation. This implementation does not introduce those
policies, a task DB, nested delegation, or changes to other providers.
