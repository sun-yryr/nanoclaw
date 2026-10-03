# Core Policy Customizations

`SOURCE=5183f47ac903b36fa325d24900cfd5fb499149d1`

## 1. Single-agent-group policy

**Intent:** One agent group for identity/workspace/memory. New channels wire to it. Threaded Discord groups honour wiring `session_mode` (default `shared`) instead of forcing `per-thread`. Overrides: `ALLOW_MULTIPLE_AGENT_GROUPS=true`, `FORCE_PER_THREAD_IN_GROUP_CHATS=true`.

**Copy as-is from SOURCE:**

- `src/single-agent.ts`
- `src/single-agent.test.ts`
- `scripts/consolidate-agent-groups.ts`
- `docs/single-agent-unification.md`

**Surgical hooks on upstream files:**

### `src/router.ts`

- Import `effectiveSessionMode` from `./single-agent.js`.
- Replace any upstream “force per-thread in group chats” logic with:

```typescript
const mode = effectiveSessionMode(agent.session_mode, {
  adapterSupportsThreads,
  isGroup: mg.is_group !== 0,
});
```

- Ensure attachment-only messages count as engage for `mention` / `pattern` triggers (see SOURCE router diff: `hasAttachments`).

### Create / wire guards

Port from SOURCE:

- `src/cli/crud.ts` — `createGuard` hook support if missing.
- `src/cli/resources/groups.ts` — `createGuard: assertCanCreateAgentGroup`.
- `src/cli/resources/wirings.ts` — help text for env flags.
- `src/modules/permissions/channel-approval.ts` — hide “Connect new agent” unless multi-group allowed; guard `createNewAgentGroup`.
- `src/modules/permissions/index.ts` — block `NEW_AGENT_VALUE` in single-agent mode.
- `src/modules/agent-to-agent/create-agent.ts` — early return when multi-group disabled.
- `scripts/init-first-agent.ts`, `scripts/init-cli-agent.ts`, `setup/register.ts` — use `resolveOrCreateAgentGroup` instead of always creating by folder.

## 2. Single-host lock

**Intent:** Prevent two host processes from double-delivering outbound messages.

**Copy as-is:**

- `src/host-lock.ts`
- `src/host-lock.test.ts`

**Wire in `src/index.ts` (SOURCE pattern):**

- Import `acquireHostLock`, `HostLockError`, `releaseHostLock`.
- Call `acquireHostLock()` early in startup (before DB/delivery loops).
- On fatal startup / shutdown, `releaseHostLock()`.
- Catch `HostLockError` and exit with a clear message.

## 3. Invalid additional_mounts hardening

**Intent:** Bad DB JSON must not crash path expansion.

**Port from SOURCE:**

- `src/container-config.ts` — filter invalid mounts in `configFromDb`.
- `src/modules/mount-security/index.ts` — null-safe `expandPath`, reject reasons, skip non-object entries.
- Matching tests: `src/container-config.test.ts`, `src/modules/mount-security/mount-security.test.ts`.

Re-read upstream mount-security first; merge intent if APIs moved.

## 4. Composite inbound message IDs

**Intent:** Router still namespaces `messages_in.id` as `platformId:agentGroupId`. Platform APIs need the bare id; leaked composites cause retry loops.

**Port from SOURCE:**

- `container/agent-runner/src/db/messages-out.ts` — strip at `:ag-` in `getMessageIdBySeq` (or equivalent).
- `src/channels/chat-sdk-bridge.ts` — drop edit/reaction delivery when id looks composite (`:ag-`).

Do **not** remove router namespacing unless upstream redesigns IDs.

## 5. Scheduling execute mode (container)

**Intent:** When a scheduled task fires, the agent must execute it, not call `schedule_task` again.

**Port from SOURCE:**

- `container/agent-runner/src/formatter.ts` (+ tests) — wrap with `mode="execute"` messaging.
- `container/agent-runner/src/mcp-tools/scheduling.instructions.md` — explicit “do not call schedule_task…” for execute mode.

## Env cheat sheet

| Env | Effect |
|-----|--------|
| `ALLOW_MULTIPLE_AGENT_GROUPS=true` | Restore multi-group creation |
| `FORCE_PER_THREAD_IN_GROUP_CHATS=true` | Restore old per-thread override in group chats |