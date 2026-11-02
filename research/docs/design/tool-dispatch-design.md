# Tool dispatch design (Splyce V1) - phase 1 note

Worktree `C:\Users\Khadi\Downloads\splyce-tool-dispatch`, branch `dnarsh/tool-dispatch`.
Base e5f6cce (#161 merged, already contains workspace-tools.ts) + merge of aeffd9f (agent-context-tools,
memory, index). Conflicts only in package.json (scripts) and scripts/run-store.mjs (usage list): union-resolved.
e5f6cce is only on origin/Itachi-1824/slice-recovery-tools (not on td07-11-bootstrap, which is 126 behind).

## Facts that shape the design

1. No runnable generation yet at this base. engine-host.mjs `handle()` answers every `send` with POLICY_DENIED
   ("Generation unconfigured"), handshake reports `ports.generation:false`, native-host.mjs `fence()` hardcodes
   `grantIds: []`, `planMode: true`. There is no session factory, no run record creation, no event publisher.
   -> The factory/run lifecycle is Codex's; tool dispatch plugs into it (see Blocked).
2. Vendor admission is per tool OBJECT: `bindSplyceToolAdmission(tool, admission)` (agent/src/splyce-admission.ts:27,
   WeakMap keyed by identity). `requireSplyceToolAdmission` throws SPLYCE_UNAVAILABLE for an unbound tool.
   `bind(role "tool")` (splyce-readiness.ts:113-117) stores the original `execute` and replaces `tool.execute`
   with a thrower; the loop calls the stored original via `getSplyceToolImplementation` (:179).
3. There is NO `AgentSession.bindNativeToolAdmission` in this vendor tree. AgentTools are rebuilt on every
   `_refreshToolRegistry` (agent-session.ts:3628, wrap at :3680-3699, `inheritSplyceOwner(this, tool, "tool")`
   at :3698), which runs at construction (`_buildRuntime` :3786) and `reload()` (:3797). Binding therefore must
   happen after each refresh, or a vendor patch adds a hook (see Hook points, option B).
4. Custom tools enter via `createAgentSession({customTools, tools:[allowlist]})` (sdk.ts:244 explicit allowlist,
   :415 customTools; `+x/-x` allowlists rejected). Built-in read/bash/edit/write must NOT be allowlisted:
   the allowlist is exactly our tool names.
5. NativePolicy.authorize(permit) is required per toolCallId BEFORE `reserve` (policy.ts:136, :213) and the permit
   carries `argumentsDigest` of the VALIDATED args, plus a once-grant already bound to (actionId, digest) for
   fs.write/shell.run (policy.ts ONCE_CAPABILITIES; Store.mintGrant store.ts:2538). But the loop calls `reserve`
   (agent-loop.ts:828) BEFORE prepareArguments/validation (:840-841). So a permit cannot be minted in beforeToolCall
   (:872, after prepare). Mint it inside our admission adapter's `prepare` (async, receives validatedArgs).
6. workspace-tools has its OWN GrantPort.check/consume + ReceiptPort (workspace-tools.ts:59-75, gate :430,
   effect :440). NativePolicy.execute already consumes the once grant (policy.ts:376-ish `consumeOnceGrant`) and writes
   action/outcome receipts (:485 commitOutcome). A second real consume would fail with GRANT_CONSUMED.
7. Tool output redaction: `Redactor` is sync `(text)=>string` (provider-auth.ts:80; CredentialResolver.redact
   credential-resolver.ts:103, live in-process secrets). The Rust `credential.redact` lane is ASYNC:
   `NativeControl.redact(text, signal)` (native-control.mjs:157). Tools take the sync one; the async one is applied
   once more to the final text/preview in the dispatch wrapper.
8. memory.capture(scopeId, sessionId) is sync and replays COMMITTED DURABLE events (memory.ts:305). Tool events must
   therefore be committed via `Store.commitEvents` (store.ts:1089), not just forwarded to the renderer.

## Components (all new code in packages/splyce-pi/src, none in vendor)

### A. `tool-dispatch.ts` - `createToolDispatch(deps)` returns `{ tools, bind(session), onTurnEnd() }`

- `tools`: pi `ToolDefinition`s built from `createWorkspaceTools` (read, ls, find, grep, write, edit, bash,
  powershell) + `createAgentContextTools` (code index tools, memory_search). Parameters = their JSON schema.
  `execute` = `(id, args, signal) => tool.result(args, signal, id)` mapped to
  `{content:[{type:"text",text}], details:{summary}}`; a thrown WorkspaceToolError/ContextToolError becomes an
  error result with `details.summary` (WorkspaceToolError.summary when a command was killed).
- Allowlist passed to `createAgentSession` = `tools.map(t=>t.name)`; `excludeTools` unnecessary.

### B. `ToolAdmissionAdapter implements SplyceToolAdmission` (one per session, wraps one NativePolicy)

Holds `Map<toolCallId, {reserved:boolean}>`. Mapping to the loop (agent-loop.ts line refs):

- `reserve` (:828): record id only. (Nothing durable; policy.reserve needs a permit not yet minted.)
- `prepare` (:851): receives validatedArgs. (1) capability/target from tool name + args (read/ls/find/grep/context
  = fs.read; write/edit = fs.write; bash/powershell = shell.run); (2) digest = `actionArgumentsDigest(args)`;
  (3) fs.write/shell.run: emit `approval.requested` and await the renderer decision; on approve
  `store.mintGrant({workspaceId, sessionId, capability, scope:"once", actionId, argumentsDigest}, caller)`;
  fs.read uses the run's session grant already in `run.grantIds`; (4) `policy.authorize(permit)`;
  (5) `policy.reserve(...)`, `policy.prepare(...)`; (6) commit durable `turn.tool_intent`.
  Deny/cancel while awaiting approval -> throw AdmissionError("POLICY_DENIED"|"CANCELED") (loop discards).
- `finish` (:919) -> `policy.finish`. `discard` (:917/:859/:843) -> `policy.discard` only if reserved.
- `execute` (:984) -> `policy.execute(id, name, args, invoke, signal)` where `invoke` is the loop's callback around
  the ORIGINAL tool.execute. The adapter wraps `invoke` to capture `details.summary`, and in `finally` commits
  `turn.tool_outcome` (status success|error from result.isError, `uncertain` when AdmissionError EFFECT_UNCERTAIN).
  Effects never run outside `policy.execute`: bypass is impossible since `tool.execute` is replaced by a thrower.
- Binding (option A, no vendor edit): after `createAgentSession`, iterate `session.agent.state.tools` and
  `bindSplyceToolAdmission(tool, adapter)`; refuse `reload()` / extension tool registration in the owned session.
  Option B (cleaner, needs a new `patches/pi/00xx-*.patch`, vendor edit, review cost): `onToolsRefreshed` hook
  called right after agent-session.ts:3698. Recommend A first; B only if Codex's factory calls reload.

### C. Real ports for workspace-tools (permit-backed, not store-backed)

- `WorkspacePort.workspace(id)` -> `store.getWorkspace(id)` (store.ts:2480, the admittedWorkspace record):
  `{workspaceId, canonicalPath, revision}`; undefined if not admitted (also fed by `host.resolveWorkspace`).
- `GrantPort` over the PERMIT (in-memory, per action): `check(req)` returns `{ok:true, grantId: permit.grantId,
scope: once|session}` iff req.actionId == permit.toolCallId, req.argumentsDigest == permit.argumentsDigest
  (hex vs `sha256:` prefix normalised), workspaceId/sessionId/capability match; else GRANT_REQUIRED. `consume()`
  is an assertion-only no-op because NativePolicy.execute already consumed (item 6). The real store grants stay
  the single source of truth, enforced in policy.ts (:429 requireGrant, :376 consumeOnceGrant, with fresh native
  directory identity via WorkspaceIdentityPort.observe).
- `ReceiptPort.record(effect)` -> no second receipt: returns the actionId and stashes `effect.summary` so
  `commitOutcome` (policy.ts:485) / `turn.tool_outcome` carry it. (policy.ts is the receipt writer; we do not
  duplicate.) If Lead wants outcome.resultArtifactId populated, that is a small additive policy.ts change (see list).
- `WorkspaceIdentityPort.observe` for NativePolicy: native directory identity read (Rust/engine); fixtures use
  `MemoryWorkspaceIdentity`. Real source = Codex/Rust.

### D. Events to the renderer

- `Store.commitEvents(receipts, drafts, caller, fences)`; drafts = `SplyceEventDraft` (eventId, scopeId, sessionId,
  durable:true, kind, payload). The bridge replays/subscribes from the store (desktop-bridge.ts), nothing extra to
  publish. `turn.tool_intent` {runId, actionId, capabilityId, target(redacted), argsSummary(redacted, <=text cap)}.
  `turn.tool_outcome` {runId, actionId, status, error?, summary{exitCode?,durationMs,bytes,truncated,preview}}.
- summary mapping: tool `result().summary` verbatim (preview already <=2048, scrubbed by `scrubSecrets` +
  host `redact`); then `await native.redact(preview)` (Rust lane, text-only, fail closed -> preview "" on
  NATIVE_REDACTION error, never raw). `error` = WorkspaceToolError.code only (message is path-bearing).
- Gap: NativePolicy.execute commits action receipts with `commitEvents(receipts, [], ...)` (policy.ts:~395) so the
  outcome event is a SECOND commit after `policy.execute`; between them a crash leaves receipts without an event.
  Acceptable (memory/renderer reconcile from receipts); strict atomicity would need a policy.ts `events` option.

### E. captureMemoryAfterTurn

- Called by the turn runner (factory) once per turn after the last tool_outcome and `turn.completed|failed|canceled`
  are committed: `captureMemoryAfterTurn(memory, scopeId, sessionId)` (agent-context-tools.ts:241) inside try/catch;
  capture failure must not fail the turn (log + `engine.status` no-op). The adapter exposes `onTurnEnd()` only;
  the call site is the factory's turn-completion path (Blocked item 1).

## Blocked on Codex (factory hook points)

1. Session factory/turn runner: where createAgentSession is called, run record + `run.grantIds` creation (permit needs
   `runRecordId`, `runId`, ownership via `store.acquireWorkspace` store.ts:2093), `caller` (CallerContext), `current()`
   CurrentPolicy (native-host fence currently `planMode:true, grantIds:[]`), turn completion hook for memory capture.
2. Approval round trip (`approval.requested` out, renderer decision in) and how grants for fs.read are minted at run start.
3. WorkspaceIdentityPort native observer and the NativeControl instance for `redact`.
4. Whether session `reload()` is ever used (decides binding option A vs B).
5. `ArtifactPort` for `argumentsArtifactId` (permit field): need the arguments artifact write (store artifact API) or
   a rule that it is the digest-keyed artifact created in `prepare`.

## Files I intend to touch (phase 2)

New: packages/splyce-pi/src/tool-dispatch.ts; tests/tool-dispatch.test.mjs (or tests/integration/tool-dispatch.ts via run-store case).
Edit (small): packages/splyce-pi/package.json exports (tool-dispatch), package.json (one test script + release-gate entry),
scripts/run-store.mjs (case C2_tool_dispatch), tests only otherwise.
Maybe: packages/splyce-pi/src/policy.ts (additive optional `onOutcome`/`events` hook - ask owner before touching),
patches/pi/00xx (only if option B). Not touching: vendor/pi, engine-host.mjs, native-host.mjs, native-control.mjs, contracts.ts
(event kinds/summary already exist), store.ts, workspace-tools.ts, agent-context-tools.ts.
Verification (targeted only): `tsc -p packages/splyce-pi` (one package), one `node scripts/run-store.mjs --case C2_tool_dispatch`.
