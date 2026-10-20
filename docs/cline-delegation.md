# Cline delegation v1

This fork's Cline provider uses `delegate_tasks` when `CLINE_SPAWN_MODEL` resolves
to an enabled child configuration. The parent keeps `ask_question` and
`submit_and_exit`; its execution tools are `delegate_tasks` and `resume_delegated_task`. Without a spawn model,
the existing Cline tool configuration remains in use.

Each batch accepts 1–4 independent tasks with a unique `id`, an `objective`,
optional minimal `context`, and `expectedOutput`. Strings are trimmed; empty
strings and unknown fields (including a caller-supplied `systemPrompt`) are
rejected. Limits are 40/1500/3000/1000 characters respectively. The harness supplies
one fixed worker prompt. Dependencies belong in a subsequent batch after the
parent reviews the previous results.

An optional `title` lets the parent describe each task's action and general target
in up to 60 characters for the progress card (for example,
「公式カレンダーで対象の収集日を確認」). It is separate from the objective,
without another model call or automatic summarization. The parent must exclude
private data, names, email subjects/bodies, URLs, paths, credentials and mentions.
The harness, poster and host validate length and unsafe patterns, falling back
to 「タスク N」 for missing or unsafe titles. These checks supplement the prompt;
they do not detect every possible piece of personal information.

Results preserve input order and report execution `completed`, `partial`, `failed`, or
`cancelled`, elapsed milliseconds (including queue time), and available text,
iterations, and token usage. SDK `completed` maps to completed, `aborted` to
cancelled, and other finish reasons to partial. Exceptions map to failed; error
text is intentionally generic to avoid exposing request or credential data.
A child failure does not discard its siblings. No harness retries occur.

## Completion review and recovery

Execution status is separate from objective completion. Every worker receives
`report_task_result`, with `status` (`completed`, `partial`, `blocked`), observed
`evidence`, and `remainingWork`. A completed claim cannot contain outstanding
work; a partial/blocked claim must describe the gap. Missing reports produce
`completion.status: unverified`. Operations after a report invalidate it, except
terminal `submit_and_exit`. Progress cards show incomplete/unverified claims as
partial even when SDK execution ended normally. These are model claims for
parent review, not trusted proof of external state.

For exhaustive tasks, the parent sets `requireCoverage: true`. The worker reports
`coverage: { listedIds, reviewedIds, classifiedIds, paginationComplete }`; the
harness deduplicates and compares these sets, returning counts, missing IDs and
unexpected IDs (up to 50 each, with full counts). Previously enumerated IDs
remain required across reports and follow-ups, so shrinking the declared set
cannot hide an omission. A completed claim becomes partial if coverage is absent, pages
remain, or the sets differ. Each list is bounded to 5,000 IDs. The model must
still obtain the real pages and verify the requested time window; matching
self-reported sets cannot prove that retrieval was exhaustive.

Each result includes a turn-local `taskRef`. A follow-up supplies `followUpTo`
referencing an earlier result and includes prior evidence/checkpoints in context.
For a new independent task, `followUpTo` is null or omitted; fabricated UUIDs
are rejected with instructions to correct the field. Optional task fields and
worker coverage accept null so Responses clients can explicitly represent
absent values. After three invalid delegation inputs in a turn, the provider
stops before the next model request rather than repeating rejected calls until
the 50-iteration ceiling. Valid task attempts keep their separate existing budget.
It must finish that task's remaining work, and automatically inherits its coverage
requirement. A completed follow-up closes its incomplete ancestors; completed
siblings are left alone. Recovery IDs continue to handle iteration ceilings;
timeouts without retained history use a narrow follow-up rather than a blind
replay. Workers are instructed to checkpoint long reviews in their workspace.
Partial reports also retain their last evidence in memory when a later call
times out, even though subsequent operations invalidate their completion claim.

If the parent tries to end with unresolved delegated work, the provider withholds
that provisional answer and continues the same parent history with the gaps and
remaining attempt budget. At most two completion reviews run per user turn.
No worker is automatically re-executed, and reviews do not reset the eight-attempt
budget. Explicit external blockers, parent cancellation and failed parent runs
do not initiate this correction. Tool-free empty-answer recovery remains tool-free.
Only the settled final result is published to the poll-loop, so a provisional
disclaimer cannot prematurely complete the task run or trigger its delivery nudge.

The parent owns checking the reports, recovering authorized missing work and
explaining concrete blockers or exhausted limits. This does not guarantee all
model errors are detected or all tasks can finish within the bounds. Explicit
mid-turn messages/actions remain governed by the existing approval and delivery
paths, and are never rolled back by final-answer review.

See [the investigation and validation notes](secretary-completion-recovery.md)
for the 2026-10-19 incident that motivated this change.

## Bounded recovery after the iteration ceiling

When a worker reaches `CLINE_SPAWN_MAX_ITERATIONS`, its result stays `partial`
and identifies `finishReason: max_iterations`. SDK 0.0.47 sometimes reports this
as legacy `error`; only the exact SDK diagnostic and matching iteration count
are normalized. Authentication, arbitrary errors and cancellation are not
treated as resumable iteration ceilings.

If history fits a 2 MB bound and the turn has attempt budget left, the result
contains `recovery: { id, reason: "max_iterations", remainingResumes: 1 }`.
The parent should call `resume_delegated_task` with `recoveryId` and
a bounded `instruction` when authorized required work remains, or explain a
concrete blocker/exhausted budget. Nothing automatically
retries a worker. Resumption restores its original task history, endpoint,
session header and activated MCP schemas, with fresh cancellation and tool-lock
wrappers. The worker must verify existing effects before attempting uncertain
writes. This preserves evidence rather than replaying the objective from scratch;
it does not make model-selected writes inherently idempotent.

Each worker can resume once, and that attempt consumes one of the same eight
turn slots. With the default iteration ceiling a worker can use at most 25 + 25
iterations. Recovery IDs are scoped to the parent instance and current SDK user
turn, consumed atomically, and expire on `resetTurn()`. They are in-memory only:
container restart or a later user turn cannot resume an old ID. No worker history
or recovery ID is included in a Discord progress card. Resumption updates the
existing task/batch entry and includes elapsed time from both attempts.

## Empty parent answers

For Cline chat turns with no final text and no already queued/delivered chat
reply, the poll-loop requests one final response from the retained parent
history. The original request and reply route are preserved across the correction.
`requestFinalResponse()` makes one model request, advertises no tools and blocks
all tool execution through `beforeTool`; a 90-second deadline aborts a stalled
request. It cannot resume a worker or replay an action. Normal later user turns
restore the normal tools.

If the correction is empty, still unwrapped, fails, or times out, a safe failure
notice goes through the normal reply route and the progress run ends failed.
Providers missing the constrained recovery API fail closed instead of using
ordinary `push()` to restart execution. Existing MCP/mid-turn replies are not
duplicated. Task runs, failure-notice wakes and other providers retain their
existing behavior. Failed/aborted SDK runs are reported once from the settled
run result rather than first being emitted as empty successes.

## Bounds

| Environment variable                   | Default | Accepted range |
| -------------------------------------- | ------- | -------------- |
| `CLINE_DELEGATION_MAX_CONCURRENCY`     | 3       | 1–3            |
| `CLINE_DELEGATION_MAX_TASKS_PER_BATCH` | 4       | 1–4            |
| `CLINE_DELEGATION_MAX_TASKS_PER_TURN`  | 8       | 1–8            |

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

Recovery validation on 2026-10-14: runner-wide `bun test --isolate` passed
680 tests with 3 existing skips and no failures. The four recovery-focused files
passed 28 tests both locally and in the actual group image with networking
disabled. Tests cover the real SDK's iteration-limit classification, preserved
MCP activation/history/session, a successful action not replayed by restarting
the worker, recovery ownership/budget/expiry, tool-free parent correction,
normal-tool restoration on a later turn, single failure notification, empty or
unwrapped recovery failure, duplicate-reply avoidance and unchanged other providers.
Host/runner typechecks and host build passed; the deployed service and CLI were
healthy after restart. No Discord trial messages or historical user actions were
replayed during verification.
