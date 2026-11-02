// TD-70 / E1 — delegated child agents on the Pi loop.
//
// Every child is one Pi `Agent` (pi-agent-core: the same loop, owner binding
// and tool-admission seam as the parent) created under the parent's native
// Splyce owner, streaming through the parent's provider path. There is no
// second loop here: this module schedules children, narrows their authority
// and records what they did.
//
//  - Authority: child capabilities = parent grants ∩ mode set ∩ request. Only
//    tools of those capabilities are built, and every call still crosses a
//    ChildAdmission that re-checks the capability, confines `path` arguments
//    to the child root and hands the action to a per-child NativePolicy (same
//    receipts as any parent action: proposed/approved/running/outcome).
//  - Grants: a child never affects the admitted workspace directly, so every
//    child call is admitted under the parent's session `fs.read` grant (the
//    receipt's capabilityId still names the child capability). The only
//    workspace write is apply: an `fs.write` once grant bound to
//    {actionId: worktree.apply:<worktreeId>, argumentsDigest} (subagent.diff).
//  - Read mode shares the parent workspace root; write mode runs in an
//    isolated worktree and claims each written path (fileClaim records). Write
//    children get no shell: without an OS sandbox a shell could write outside
//    the worktree before review.
//  - A claim whose owner is not live is released; start() releases stale
//    claims and sweeps orphan worktrees left by a crash.
//  - Status is durable child.* events in the parent session ledger.
//
// Unwired slice: no engine generation exists yet (engine-host replies
// "Generation unconfigured"), so the native host has no parent run to attach
// this to. Composition lives in subagent-tools.mjs; E1_readonly_subagents
// drives it through the real Pi Agent with a fixture stream.

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RevisionFence } from "./admission.js";
import {
  CHILD_KIND_STATUS,
  type ChildEventPayload,
  CONTRACT_VERSION,
  type GrantRecord,
  PROTOCOL_VERSION,
  type RecordByKind,
  type SplyceEventDraft,
  type SUBAGENT_FAILURE_REASONS,
  type SUBAGENT_FILE_STATUSES,
  SUBAGENT_MODES,
} from "./contracts.js";
import {
  AdmissionError,
  actionArgumentsDigest,
  NativePolicy,
  type WorkspaceIdentityPort,
} from "./policy.js";
import { type Redactor, redactSecrets } from "./provider-auth.js";
import { isSecretPath } from "./secret-path.js";
import type { CallerContext, Store, WorkspaceOwnership } from "./store.js";

export type SubagentMode = (typeof SUBAGENT_MODES)[number];
export type FailureReason = (typeof SUBAGENT_FAILURE_REASONS)[number];

export const CAPABILITIES = [
  "fs.read",
  "code.index",
  "memory.query",
  "fs.write",
  "shell.run",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
/**
 * Read children never get fs.write; no child gets shell.run (it is requestable
 * only to be denied) until an OS sandbox confines a shell to the worktree.
 */
export const MODE_CAPABILITIES: Readonly<
  Record<SubagentMode, readonly Capability[]>
> = Object.freeze({
  read: Object.freeze(["fs.read", "code.index", "memory.query"] as const),
  write: Object.freeze([
    "fs.read",
    "code.index",
    "memory.query",
    "fs.write",
  ] as const),
});

export class SubagentError extends Error {
  readonly code:
    | "INVALID_ARGUMENT"
    | "CAPABILITY_DENIED"
    | "WORKTREES_UNAVAILABLE"
    | "CHILD_NOT_APPLICABLE";
  constructor(code: SubagentError["code"], message: string) {
    super(message);
    this.name = "SubagentError";
    this.code = code;
  }
}

/** Structural view of pi-agent-core's Agent (DI keeps build:contracts Pi-free). */
export interface ChildAgent {
  prompt(text: string): Promise<void>;
  abort(): void;
  subscribe(listener: (event: ChildAgentEvent) => unknown): () => void;
  readonly state: {
    readonly messages: readonly unknown[];
    readonly errorMessage?: string | undefined;
  };
}
export type ChildAgentEvent =
  | { type: "turn_start" }
  | { type: "turn_end"; message: unknown }
  | { type: "tool_execution_start"; toolCallId: string; args: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: string };
/** A Pi AgentTool; only identity and name matter here. */
export interface ChildTool {
  readonly name: string;
}
/** pi-agent-core SplyceToolAdmission, satisfied by NativePolicy. */
export interface ToolAdmission {
  check(
    toolCallId: string,
    toolName: string,
    signal: AbortSignal | undefined,
    phase?: "prepare",
  ): void;
  reserve(
    toolCallId: string,
    toolName: string,
    signal: AbortSignal | undefined,
  ): void;
  prepare(
    toolCallId: string,
    toolName: string,
    validatedArgs: unknown,
    parentToolCallId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void>;
  finish(
    toolCallId: string,
    toolName: string,
    args: unknown,
    signal: AbortSignal | undefined,
  ): void;
  discard(toolCallId: string, reason: "canceled" | "denied"): void;
  execute<T extends { isError: boolean }>(
    toolCallId: string,
    toolName: string,
    args: unknown,
    invoke: (admittedArgs: unknown) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T>;
}

export interface WorktreeFile {
  path: string;
  status: (typeof SUBAGENT_FILE_STATUSES)[number];
}
/**
 * @splyce/index/worktrees WorktreeManager (structural: splyce-pi does not
 * depend on splyce-index). Roots are engine-only. apply() consumes a once-grant
 * bound to the diff's {actionId, argumentsDigest}.
 */
export interface WorktreeManager {
  create(input: {
    workspaceId: string;
    childId: string;
    baseRef?: string;
  }): Promise<{ worktreeId: string; root: string }>;
  diff(worktreeId: string): Promise<{
    patch: string;
    files: WorktreeFile[];
    actionId: string;
    argumentsDigest: string;
  }>;
  apply(
    worktreeId: string,
    input: { grantId: string },
  ): Promise<{ applied: true; files: WorktreeFile[] }>;
  prepareApply(
    worktreeId: string,
  ): Promise<
    (input: {
      grantId: string;
    }) => Promise<{ applied: true; files: WorktreeFile[] }>
  >;
  discard(worktreeId: string): Promise<void>;
  sweepOrphans(): Promise<{
    removed: string[];
    failed: { worktreeId: string; code: string }[];
  }>;
}

/** The user's budget; every per-call value is clamped to it. */
export interface SubagentLimits {
  concurrency: number;
  maxTasks: number;
  maxTurns: number;
  maxTokens: number;
  wallClockMs: number;
}
export const DEFAULT_SUBAGENT_LIMITS: Readonly<SubagentLimits> = Object.freeze({
  concurrency: 2,
  maxTasks: 16,
  maxTurns: 8,
  maxTokens: 200_000,
  wallClockMs: 300_000,
});

export interface ParentRun {
  runId: string;
  runRecordId: string;
  scopeId: string;
  workspaceId: string;
  /** Canonical absolute root of the admitted workspace (engine-only). */
  workspaceRoot: string;
  baseRevision: string;
  ownership: WorkspaceOwnership;
  /**
   * capability → the parent's session `fs.read` grant that authorizes it (a
   * child's calls never touch the admitted workspace except through apply).
   */
  grants: Readonly<Partial<Record<Capability, string>>>;
  /** Parent run cancellation; aborting it cancels every child. */
  signal: AbortSignal;
}

export interface SubagentHost {
  store: Store;
  caller: CallerContext;
  fence: RevisionFence;
  parent: ParentRun;
  /** The parent's native owner (pi-agent-core createSplyceOwner().bind). */
  owner: { bind(subject: object, role: "agent-options" | "tool"): void };
  pi: {
    Agent: new (options: object) => ChildAgent;
    bindSplyceToolAdmission(tool: object, admission: ToolAdmission): () => void;
  };
  /** Parent's applied profile model and provider stream (owner-bound). */
  model: object;
  streamFn: unknown;
  tools: Readonly<
    Partial<Record<Capability, (root: string) => readonly ChildTool[]>>
  >;
  worktrees?: WorktreeManager;
  /** Native workspace identity for NativePolicy grant checks. */
  identity: WorkspaceIdentityPort;
  /** Liveness of children of other supervisors in this engine (claims). */
  isChildLive?: (childId: string) => boolean;
  redact: Redactor;
  limits?: Partial<SubagentLimits>;
}

export interface TaskInput {
  id?: string;
  prompt: string;
  mode?: SubagentMode;
  role?: string;
  after?: string[];
  capabilities?: Capability[];
}
export interface SpawnInput {
  tasks: TaskInput[];
  team?: { name: string; roles: Record<string, string> };
  budget?: Partial<SubagentLimits>;
}
export interface Citation {
  path: string;
  line?: number;
}
export type ChildResult = {
  taskId: string;
  childId: string;
  mode: SubagentMode;
} & (
  | {
      status: "completed";
      summary: string;
      citations: Citation[];
      files?: WorktreeFile[];
    }
  | { status: "failed"; reason: FailureReason; message: string }
  | { status: "cancelled" }
);
export interface SpawnResult {
  team?: string;
  results: ChildResult[];
}
/** `subagent.diff` reply: the reviewable patch and the act apply binds to. */
export interface SubagentDiff {
  childId: string;
  worktreeId: string;
  files: WorktreeFile[];
  /** Display copy: secret-shaped strings redacted, at most MAX_PATCH_BYTES. */
  patch: string;
  truncated: boolean;
  /** UTF-8 bytes of the full, unredacted patch. */
  bytes: number;
  actionId: string;
  argumentsDigest: string;
}

const MAX_SUMMARY = 2000;
const MAX_CITATIONS = 64;
const MAX_PROMPT = 16_384;
const MAX_EVENT_FILES = 256;
export const MAX_PATCH_BYTES = 262_144;
const APPLY_PREFIX = "worktree.apply:";
/** The digest an apply once grant binds: the worktree and its exact patch. */
const applyDigest = (worktreeId: string, patchDigest: string): string =>
  actionArgumentsDigest({ worktreeId, patchDigest });
const CHILD_ADMISSION_CODES = new Set<string>([
  "CAPABILITY_DENIED",
  "PATH_OUTSIDE_WORKSPACE",
  "FILE_CLAIM_CONFLICT",
]);

const fail = (message: string): never => {
  throw new SubagentError("INVALID_ARGUMENT", message);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const posInt = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail(`${field} must be a positive integer`);
  return value as number;
};
const lower = (path: string): string => path.toLowerCase();

/** Validates model-supplied spawn arguments (a trust boundary). */
export function parseSpawnInput(
  args: unknown,
  limits: SubagentLimits,
): SpawnInput {
  if (!isObject(args) || !Array.isArray(args.tasks) || args.tasks.length === 0)
    fail("tasks must be a non-empty array");
  const raw = args as { tasks: unknown[]; team?: unknown; budget?: unknown };
  if (raw.tasks.length > limits.maxTasks)
    fail(`at most ${limits.maxTasks} tasks`);
  let team: SpawnInput["team"];
  if (raw.team !== undefined) {
    if (
      !isObject(raw.team) ||
      typeof raw.team.name !== "string" ||
      !raw.team.name.trim() ||
      !isObject(raw.team.roles) ||
      !Object.values(raw.team.roles).every((v) => typeof v === "string")
    )
      fail("team needs a name and string role prefixes");
    team = {
      name: (raw.team as { name: string }).name,
      roles: { ...(raw.team as { roles: Record<string, string> }).roles },
    };
  }
  const tasks = raw.tasks.map((value, index): TaskInput => {
    if (!isObject(value)) return fail("task must be an object");
    const id = value.id ?? `t${index + 1}`;
    if (typeof id !== "string" || !/^[\w.-]{1,64}$/u.test(id))
      fail("task id must be 1-64 word characters");
    if (
      typeof value.prompt !== "string" ||
      !value.prompt.trim() ||
      value.prompt.length > MAX_PROMPT
    )
      fail(`task ${id as string}: prompt must be 1-${MAX_PROMPT} characters`);
    const mode = value.mode ?? "read";
    if (!SUBAGENT_MODES.includes(mode as SubagentMode))
      fail(`task ${id as string}: unknown mode`);
    if (
      value.role !== undefined &&
      (typeof value.role !== "string" ||
        !team ||
        !Object.hasOwn(team.roles, value.role))
    )
      fail(`task ${id as string}: role is not in the team`);
    const after = value.after ?? [];
    if (!Array.isArray(after) || !after.every((d) => typeof d === "string"))
      fail(`task ${id as string}: after must list task ids`);
    const caps = value.capabilities;
    if (
      caps !== undefined &&
      (!Array.isArray(caps) ||
        !caps.every((c) => CAPABILITIES.includes(c as Capability)))
    )
      fail(`task ${id as string}: unknown capability`);
    return {
      id: id as string,
      prompt: value.prompt as string,
      mode: mode as SubagentMode,
      ...(value.role === undefined ? {} : { role: value.role as string }),
      after: [...(after as string[])],
      ...(caps === undefined
        ? {}
        : { capabilities: [...(caps as Capability[])] }),
    };
  });
  const ids = new Set(tasks.map((t) => t.id!));
  if (ids.size !== tasks.length) fail("task ids must be unique");
  for (const task of tasks)
    for (const dep of task.after!)
      if (!ids.has(dep) || dep === task.id)
        fail(`task ${task.id!}: unknown dependency ${dep}`);
  // Cycle check: repeatedly peel tasks whose dependencies are all peeled.
  const done = new Set<string>();
  while (done.size < tasks.length) {
    const next = tasks.filter(
      (t) => !done.has(t.id!) && t.after!.every((d) => done.has(d)),
    );
    if (next.length === 0) fail("task dependencies form a cycle");
    for (const t of next) done.add(t.id!);
  }
  const budget: Partial<SubagentLimits> = {};
  if (raw.budget !== undefined) {
    if (!isObject(raw.budget)) fail("budget must be an object");
    for (const [key, value] of Object.entries(raw.budget as object)) {
      if (
        !["concurrency", "maxTurns", "maxTokens", "wallClockMs"].includes(key)
      )
        fail(`unknown budget field ${key}`);
      budget[key as keyof SubagentLimits] = posInt(value, `budget.${key}`);
    }
  }
  return { tasks, ...(team ? { team } : {}), budget };
}

/** Identity carried on every child.* event; `limit` is the token budget. */
interface ChildInfo {
  childId: string;
  team?: string;
  role?: string;
  limit: number;
}

/** `{childId}` request arguments (renderer input: a trust boundary). */
function childIdOf(request: unknown): string {
  if (
    !isObject(request) ||
    Object.keys(request).join() !== "childId" ||
    typeof request.childId !== "string" ||
    !request.childId
  )
    fail("request must be exactly {childId}");
  return (request as { childId: string }).childId;
}

/** Stops are decided once; later causes do not overwrite the first. */
export interface ChildRun {
  readonly childId: string;
  readonly controller: AbortController;
  stop?: FailureReason;
  admissionError?: { code: string; message: string };
}

export class SubagentSupervisor {
  private readonly host: SubagentHost;
  readonly limits: SubagentLimits;
  private readonly running = new Map<string, ChildRun>();
  /** Completed write children whose worktree awaits apply or discard. */
  private readonly applicable = new Map<string, string>();

  /** What the startup sweep could not remove (a locked worktree); empty when clean. */
  swept: { removed: string[]; failed: { worktreeId: string; code: string }[] } =
    { removed: [], failed: [] };

  private constructor(host: SubagentHost) {
    this.host = host;
    this.limits = { ...DEFAULT_SUBAGENT_LIMITS, ...host.limits };
    for (const key of Object.keys(this.limits) as (keyof SubagentLimits)[])
      posInt(this.limits[key], `limits.${key}`);
  }

  /**
   * The only way to build a supervisor: recovers what a crashed one left —
   * releases claims whose owner is not live and sweeps orphan worktrees.
   */
  static async start(host: SubagentHost): Promise<SubagentSupervisor> {
    const supervisor = new SubagentSupervisor(host);
    for (const claim of supervisor.claimHeads())
      if (
        claim.releasedAt === null &&
        !supervisor.isChildLive(claim.ownerChildId)
      )
        supervisor.release(claim.ownerChildId, claim.path);
    if (host.worktrees) supervisor.swept = await host.worktrees.sweepOrphans();
    return supervisor;
  }

  /** For WorktreeManager.isChildLive: running, or completed with a pending worktree. */
  isChildLive(childId: string): boolean {
    return (
      this.running.has(childId) ||
      this.applicable.has(childId) ||
      this.host.isChildLive?.(childId) === true
    );
  }

  /** `subagent.diff {childId}`: the pending worktree's patch for review. */
  async diff(request: unknown): Promise<SubagentDiff> {
    const childId = childIdOf(request);
    const { worktreeId, worktrees } = this.pendingReview(childId);
    const diff = await worktrees.diff(worktreeId);
    const encoder = new TextEncoder();
    const shown = encoder.encode(this.host.redact(redactSecrets(diff.patch)));
    const truncated = shown.byteLength > MAX_PATCH_BYTES;
    return {
      childId,
      worktreeId,
      files: diff.files,
      patch: truncated
        ? new TextDecoder()
            .decode(shown.subarray(0, MAX_PATCH_BYTES))
            .replace(/�$/u, "")
        : new TextDecoder().decode(shown),
      truncated,
      bytes: encoder.encode(diff.patch).byteLength,
      actionId: diff.actionId,
      argumentsDigest: applyDigest(worktreeId, diff.argumentsDigest),
    };
  }

  /**
   * WorktreeManager `consumeGrant` port. apply()'s NativePolicy action already
   * consumed the once grant with its running receipt; this re-checks it
   * against the patch WorktreeManager recomputed just before `git apply`, so a
   * worktree changed after approval is refused.
   */
  confirmApplyGrant(
    grantId: string,
    act: { actionId: string; argumentsDigest: string },
  ): void {
    if (!act.actionId.startsWith(APPLY_PREFIX))
      throw new AdmissionError("GRANT_MISMATCH");
    const worktreeId = act.actionId.slice(APPLY_PREFIX.length);
    this.host.store.checkOnceGrantForActive({
      grantId,
      workspaceId: this.host.parent.workspaceId,
      sessionId: this.host.caller.sessionId,
      capability: "fs.write",
      observedIdentity: this.host.identity.observe(
        this.host.parent.workspaceId,
      ),
      actionId: act.actionId,
      argumentsDigest: applyDigest(worktreeId, act.argumentsDigest),
    });
  }

  private pendingReview(childId: string): {
    worktreeId: string;
    worktrees: WorktreeManager;
  } {
    const worktreeId = this.applicable.get(childId);
    const worktrees = this.host.worktrees;
    if (worktreeId === undefined || !worktrees)
      throw new SubagentError(
        "CHILD_NOT_APPLICABLE",
        "child has no worktree pending review",
      );
    return { worktreeId, worktrees };
  }

  /** Cancels one child; the parent and its siblings keep running. */
  cancel(childId: string): boolean {
    const child = this.running.get(childId);
    child?.controller.abort();
    return child !== undefined;
  }

  async run(input: SpawnInput): Promise<SpawnResult> {
    const budget: SubagentLimits = { ...this.limits };
    for (const [key, value] of Object.entries(input.budget ?? {}))
      if (value !== undefined)
        budget[key as keyof SubagentLimits] = Math.min(
          value,
          this.limits[key as keyof SubagentLimits],
        );
    const tasks = input.tasks.map((t, i) => ({
      ...t,
      id: t.id ?? `t${i + 1}`,
      mode: t.mode ?? "read",
      after: t.after ?? [],
    }));
    // Authority is decided for every task before any child starts.
    const caps = new Map(tasks.map((t) => [t.id, this.capabilities(t)]));
    if (tasks.some((t) => t.mode === "write") && !this.host.worktrees)
      throw new SubagentError(
        "WORKTREES_UNAVAILABLE",
        "write children need a worktree manager",
      );
    const results = new Map<string, ChildResult>();
    const started = new Set<string>();
    let active = 0;
    await new Promise<void>((done, failed) => {
      const pump = (): void => {
        let progressed = true;
        while (progressed) {
          progressed = false;
          for (const task of tasks) {
            if (results.has(task.id) || active >= budget.concurrency) continue;
            if (started.has(task.id)) continue;
            const deps = task.after.map((d) => results.get(d));
            const who = {
              ...(input.team ? { team: input.team.name } : {}),
              ...(task.role === undefined ? {} : { role: task.role }),
              limit: budget.maxTokens,
            };
            if (this.host.parent.signal.aborted) {
              results.set(
                task.id,
                this.never(task.id, task.mode, who, "cancelled"),
              );
              progressed = true;
              continue;
            }
            if (deps.some((d) => d === undefined)) continue;
            if (deps.some((d) => d!.status !== "completed")) {
              results.set(
                task.id,
                this.never(task.id, task.mode, who, "failed"),
              );
              progressed = true;
              continue;
            }
            started.add(task.id);
            active++;
            const prefix = task.role
              ? `${input.team!.roles[task.role]}\n\n`
              : "";
            const context = deps
              .map((d, i) =>
                d!.status === "completed"
                  ? `\n\nResult of ${task.after[i]}:\n${d!.summary}`
                  : "",
              )
              .join("");
            this.child(
              task.id,
              task.mode,
              who,
              caps.get(task.id)!,
              budget,
              prefix + task.prompt + context,
            ).then((result) => {
              results.set(task.id, result);
              active--;
              pump();
            }, failed);
          }
        }
        if (results.size === tasks.length) done();
      };
      pump();
    });
    return {
      ...(input.team ? { team: input.team.name } : {}),
      results: tasks.map((t) => results.get(t.id)!),
    };
  }

  /**
   * Merges a completed write child into the parent workspace: an `fs.write`
   * NativePolicy action `worktree.apply:<worktreeId>` that consumes the once
   * grant bound to subagent.diff's {actionId, argumentsDigest} with its
   * running receipt. An unapproved grant is refused before any receipt, so
   * the user can still approve and retry.
   */
  async apply(
    childId: string,
    { grantId }: { grantId: string },
  ): Promise<{ applied: true; files: WorktreeFile[] }> {
    const { worktreeId, worktrees } = this.pendingReview(childId);
    const diff = await worktrees.diff(worktreeId);
    const args = { worktreeId, patchDigest: diff.argumentsDigest };
    if (!this.host.fence.current().grantIds.includes(grantId))
      throw new AdmissionError("POLICY_DENIED");
    this.confirmApplyGrant(grantId, diff);
    const apply = await worktrees.prepareApply(worktreeId);
    const policy = this.policy();
    const toolName = "worktree.apply";
    const toolCallId = `apply:${childId}:${randomUUID()}`;
    this.permit(policy, {
      toolCallId,
      toolName,
      capabilityId: toolName,
      capability: "fs.write",
      grantId,
      args,
      idempotencyKey: diff.actionId,
      actionId: diff.actionId,
    });
    policy.reserve(toolCallId, toolName, undefined);
    await policy.prepare(toolCallId, toolName, args, undefined, undefined);
    policy.finish(toolCallId, toolName, args, undefined);
    const { value } = await policy.execute(
      toolCallId,
      toolName,
      args,
      async () => ({
        isError: false,
        value: await apply({ grantId }),
      }),
      undefined,
    );
    this.host.fence.revokeGrant(grantId);
    this.applicable.delete(childId);
    await worktrees.discard(worktreeId);
    return value;
  }

  /** `subagent.discard {childId}`: drops a pending worktree without applying it. */
  async discard(request: unknown): Promise<void> {
    const childId = childIdOf(request);
    const { worktreeId, worktrees } = this.pendingReview(childId);
    this.applicable.delete(childId);
    await worktrees.discard(worktreeId);
  }

  private capabilities(
    task: Required<Pick<TaskInput, "id" | "mode">> & TaskInput,
  ): Capability[] {
    const allowed = MODE_CAPABILITIES[task.mode].filter(
      (c) =>
        this.host.parent.grants[c] !== undefined &&
        this.host.tools[c] !== undefined,
    );
    if (task.capabilities === undefined) return allowed;
    const denied = task.capabilities.filter((c) => !allowed.includes(c));
    if (denied.length > 0)
      throw new SubagentError(
        "CAPABILITY_DENIED",
        `task ${task.id}: ${denied.join(", ")} not available to a ${task.mode} child`,
      );
    return [...new Set(task.capabilities)];
  }

  private policy(): NativePolicy {
    return new NativePolicy(
      this.host.store,
      this.host.caller,
      this.host.fence.current,
      this.host.identity,
    );
  }

  private permit(
    policy: NativePolicy,
    p: {
      toolCallId: string;
      toolName: string;
      capabilityId: string;
      capability: GrantRecord["capability"];
      grantId: string;
      args: unknown;
      idempotencyKey: string;
      actionId?: string;
    },
  ): void {
    const { store, caller, parent } = this.host;
    const digest = actionArgumentsDigest(p.args);
    const artifactId = randomUUID();
    // Describes the arguments by digest only; their content is not persisted.
    store.append(
      {
        kind: "artifact",
        record: {
          ...this.meta(),
          artifactId,
          digest,
          mediaType: "application/json",
          byteLength: new TextEncoder().encode(JSON.stringify(p.args))
            .byteLength,
          retentionClass: "workspace",
        },
      },
      caller,
    );
    policy.authorize({
      toolCallId: p.toolCallId,
      toolName: p.toolName,
      actionId: p.actionId ?? randomUUID(),
      runRecordId: parent.runRecordId,
      grantId: p.grantId,
      parentActionId: null,
      capabilityId: p.capabilityId,
      capabilityVersion: "1",
      capability: p.capability,
      argumentsArtifactId: artifactId,
      argumentsDigest: digest,
      targetScopeId: parent.scopeId,
      idempotencyKey: p.idempotencyKey,
      ownership: parent.ownership,
    });
  }

  private meta() {
    return {
      schemaVersion: CONTRACT_VERSION,
      recordId: randomUUID(),
      createdAt: new Date().toISOString(),
      scopeId: this.host.parent.scopeId,
      sourceIds: [this.host.parent.runRecordId],
    };
  }

  private emit(
    kind: keyof typeof CHILD_KIND_STATUS,
    who: ChildInfo,
    used: number,
    detail: Pick<
      Partial<ChildEventPayload>,
      "summary" | "citations" | "diff" | "reason"
    > = {},
  ): void {
    const { store, caller, parent } = this.host;
    const payload: ChildEventPayload = {
      childId: who.childId,
      parentRunId: parent.runId,
      ...(who.team === undefined ? {} : { team: who.team }),
      ...(who.role === undefined ? {} : { role: who.role }),
      status: CHILD_KIND_STATUS[kind],
      budget: { used, limit: who.limit },
      summary: detail.summary ?? "",
      citations: detail.citations ?? [],
      ...(detail.diff ? { diff: detail.diff } : {}),
      ...(detail.reason ? { reason: detail.reason } : {}),
    };
    const draft = {
      schemaVersion: CONTRACT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      recordId: parent.runRecordId,
      createdAt: new Date().toISOString(),
      sourceIds: [parent.runRecordId],
      scopeId: parent.scopeId,
      sessionId: caller.sessionId,
      durable: true,
      kind,
      payload,
    } as SplyceEventDraft;
    store.commitEvents([], [draft], caller);
  }

  private text(value: string): string {
    const redacted = this.host.redact(value).trim().slice(0, MAX_SUMMARY);
    return redacted || "(no summary)";
  }

  /** A task that never started: its dependency failed or the parent was cancelled. */
  private never(
    taskId: string,
    mode: SubagentMode,
    team: Omit<ChildInfo, "childId">,
    status: "failed" | "cancelled",
  ): ChildResult {
    const who = { ...team, childId: randomUUID() };
    const { childId } = who;
    if (status === "cancelled") {
      this.emit("child.cancelled", who, 0);
      return { taskId, childId, mode, status };
    }
    return this.failed(
      taskId,
      who,
      mode,
      0,
      "DEPENDENCY_FAILED",
      "a dependency did not complete",
    );
  }

  private async child(
    taskId: string,
    mode: SubagentMode,
    team: Omit<ChildInfo, "childId">,
    capabilities: Capability[],
    budget: SubagentLimits,
    prompt: string,
  ): Promise<ChildResult> {
    const { host } = this;
    const run: ChildRun = {
      childId: randomUUID(),
      controller: new AbortController(),
    };
    const { childId, controller } = run;
    const onParent = (): void => controller.abort();
    host.parent.signal.addEventListener("abort", onParent, { once: true });
    if (host.parent.signal.aborted) controller.abort();
    this.running.set(childId, run);
    const who: ChildInfo = { ...team, childId };
    let tokens = 0;
    this.emit("child.started", who, 0);
    const unbind: Array<() => void> = [];
    const claims = new Set<string>();
    let worktreeId: string | undefined;
    let kept = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result!: ChildResult;
    let fault: unknown;
    try {
      let root = host.parent.workspaceRoot;
      if (mode === "write") {
        const created = await host.worktrees!.create({
          workspaceId: host.parent.workspaceId,
          childId,
        });
        worktreeId = created.worktreeId;
        root = created.root;
      }
      const toolCaps = new Map<string, Capability>();
      const tools: ChildTool[] = [];
      for (const cap of capabilities)
        for (const tool of host.tools[cap]!(root)) {
          if (toolCaps.has(tool.name))
            throw new SubagentError(
              "INVALID_ARGUMENT",
              `duplicate tool ${tool.name}`,
            );
          toolCaps.set(tool.name, cap);
          tools.push(tool);
        }
      const admission = new ChildAdmission(this, run, root, toolCaps, claims);
      for (const tool of tools) {
        host.owner.bind(tool, "tool");
        unbind.push(host.pi.bindSplyceToolAdmission(tool, admission));
      }
      const options = {
        initialState: {
          systemPrompt: `You are a ${mode === "read" ? "read-only" : "write-capable"} delegated agent working for a parent agent. Use only the provided tools, stay inside the workspace, and end with a concise summary that names the files and lines you relied on.`,
          model: host.model,
          tools,
        },
        streamFn: host.streamFn,
        sessionId: childId,
      };
      host.owner.bind(options, "agent-options");
      const agent = new host.pi.Agent(options);
      const stop = (reason: FailureReason): void => {
        run.stop ??= reason;
        agent.abort();
      };
      let turns = 0;
      const citations: Citation[] = [];
      const reads = new Map<string, unknown>();
      agent.subscribe((event) => {
        if (event.type === "turn_start" && turns >= budget.maxTurns)
          stop("BUDGET_TURNS");
        if (event.type === "turn_end") {
          turns++;
          const usage = (
            event as { message: { usage?: { totalTokens?: number } } }
          ).message.usage;
          tokens += usage?.totalTokens ?? 0;
          this.emit("child.progress", who, tokens);
          if (tokens > budget.maxTokens) stop("BUDGET_TOKENS");
        }
        if (event.type === "tool_execution_start") {
          const e = event as { toolCallId: string; args: unknown };
          reads.set(e.toolCallId, e.args);
        }
        if (event.type === "tool_execution_end") {
          const e = event as Extract<
            ChildAgentEvent,
            { type: "tool_execution_end" }
          >;
          if (!e.isError)
            cite(
              citations,
              root,
              e.toolName,
              reads.get(e.toolCallId),
              e.result,
            );
        }
      });
      controller.signal.addEventListener("abort", () => agent.abort(), {
        once: true,
      });
      timer = setTimeout(() => stop("BUDGET_WALL_CLOCK"), budget.wallClockMs);
      const settled = agent.prompt(prompt);
      if (controller.signal.aborted) agent.abort();
      await settled;
      const error = agent.state.errorMessage;
      if (run.stop)
        result = this.failed(
          taskId,
          who,
          mode,
          tokens,
          run.stop,
          `${run.stop} after ${turns} turns and ${tokens} tokens`,
        );
      else if (controller.signal.aborted)
        result = { taskId, childId, mode, status: "cancelled" };
      else if (error !== undefined) {
        const denied =
          run.admissionError ?? unknownTool(agent.state.messages, toolCaps);
        result = denied
          ? this.failed(
              taskId,
              who,
              mode,
              tokens,
              CHILD_ADMISSION_CODES.has(denied.code)
                ? (denied.code as FailureReason)
                : "POLICY_DENIED",
              denied.message,
            )
          : this.failed(
              taskId,
              who,
              mode,
              tokens,
              lastStop(agent.state.messages) === "error"
                ? "PROVIDER_ERROR"
                : "ENGINE_ERROR",
              error,
            );
      } else {
        const files = worktreeId
          ? (await host.worktrees!.diff(worktreeId)).files
          : undefined;
        const summary = this.text(lastText(agent.state.messages));
        const cited = citations.slice(0, MAX_CITATIONS);
        // A write child with changes waits for review; one without has nothing to apply.
        kept = files !== undefined && files.length > 0;
        if (kept) this.applicable.set(childId, worktreeId!);
        this.emit("child.completed", who, tokens, {
          summary,
          citations: cited,
          ...(kept
            ? { diff: { files: files!.slice(0, MAX_EVENT_FILES) } }
            : {}),
        });
        result = {
          taskId,
          childId,
          mode,
          status: "completed",
          summary,
          citations: cited,
          ...(files ? { files } : {}),
        };
      }
    } catch (error) {
      // WorktreeError (limit, busy, repo) fails this child only; anything else is a host fault.
      if (
        !(error instanceof SubagentError) &&
        !(error instanceof AdmissionError) &&
        !(error instanceof Error && error.name === "WorktreeError")
      )
        fault = error;
      else
        result = this.failed(
          taskId,
          who,
          mode,
          tokens,
          (error as { code?: unknown }).code === "CAPABILITY_DENIED"
            ? "CAPABILITY_DENIED"
            : "ENGINE_ERROR",
          error.message,
        );
    } finally {
      clearTimeout(timer);
      host.parent.signal.removeEventListener("abort", onParent);
      this.running.delete(childId);
      for (const release of unbind) release();
      for (const path of claims) this.release(childId, path);
    }
    // Ended without a pending review (failed, cancelled, empty or host fault):
    // the worktree goes now, not at the next start-up sweep.
    if (worktreeId && !kept)
      try {
        await host.worktrees!.discard(worktreeId);
      } catch (error) {
        throw fault === undefined
          ? error
          : new AggregateError(
              [fault, error],
              "child fault and worktree cleanup failed",
            );
      }
    if (fault !== undefined) throw fault;
    if (result.status === "cancelled")
      this.emit("child.cancelled", who, tokens);
    return result;
  }

  private failed(
    taskId: string,
    who: ChildInfo,
    mode: SubagentMode,
    used: number,
    reason: FailureReason,
    message: string,
  ): ChildResult {
    const text = this.text(message);
    this.emit("child.failed", who, used, { summary: text, reason });
    return {
      taskId,
      childId: who.childId,
      mode,
      status: "failed",
      reason,
      message: text,
    };
  }

  /** Records `path` as owned by `childId`; another active owner is a conflict. */
  claim(childId: string, path: string): void {
    const { store, parent, caller } = this.host;
    const owners = this.activeClaims(path, childId);
    if ([...owners].some((owner) => owner !== childId))
      throw new AdmissionError("FILE_CLAIM_CONFLICT");
    if (owners.has(childId)) return;
    const record: RecordByKind["fileClaim"] = {
      ...this.meta(),
      workspaceId: parent.workspaceId,
      path,
      ownerChildId: childId,
      revision: parent.baseRevision,
      releasedAt: null,
    };
    store.append({ kind: "fileClaim", record }, caller);
  }

  private release(childId: string, path: string): void {
    const { store, parent, caller } = this.host;
    store.append(
      {
        kind: "fileClaim",
        record: {
          ...this.meta(),
          workspaceId: parent.workspaceId,
          path,
          ownerChildId: childId,
          revision: parent.baseRevision,
          releasedAt: new Date().toISOString(),
        },
      },
      caller,
    );
  }

  // ponytail: scans the scope's records per claim; index claims if a scope
  // grows large. In-process the scan and append are one synchronous step.
  /** The latest claim record per (owner, path) in this workspace. */
  private claimHeads(): RecordByKind["fileClaim"][] {
    const latest = new Map<string, RecordByKind["fileClaim"]>();
    for (const { kind, record } of this.host.store.list(
      this.host.parent.scopeId,
    ).records) {
      if (kind !== "fileClaim") continue;
      const claim = record as RecordByKind["fileClaim"];
      if (claim.workspaceId === this.host.parent.workspaceId)
        latest.set(`${claim.ownerChildId}\0${lower(claim.path)}`, claim);
    }
    return [...latest.values()];
  }

  /** Owners holding `path`; a claim whose owner is not live (crash) is released. */
  private activeClaims(path: string, childId: string): Set<string> {
    return new Set(
      this.claimHeads()
        .filter(
          (c) =>
            c.releasedAt === null &&
            lower(c.path) === lower(path) &&
            (c.ownerChildId === childId || this.isChildLive(c.ownerChildId)),
        )
        .map((c) => c.ownerChildId),
    );
  }

  /** @internal ChildAdmission builds its per-call permit through the supervisor. */
  admit(
    policy: NativePolicy,
    run: ChildRun,
    toolCallId: string,
    toolName: string,
    cap: Capability,
    args: unknown,
  ): void {
    this.permit(policy, {
      toolCallId,
      toolName,
      capabilityId: cap,
      capability: "fs.read",
      grantId: this.host.parent.grants[cap]!,
      args,
      idempotencyKey: `${run.childId}:${toolCallId}`,
    });
  }
  /** @internal */
  newPolicy(): NativePolicy {
    return this.policy();
  }
}

/**
 * The child's Pi admission: capability and path checks, then the parent's
 * NativePolicy flow (receipts) for the admitted call.
 */
class ChildAdmission implements ToolAdmission {
  private readonly policy: NativePolicy;
  constructor(
    private readonly supervisor: SubagentSupervisor,
    private readonly run: ChildRun,
    private readonly root: string,
    private readonly toolCaps: ReadonlyMap<string, Capability>,
    private readonly claims: Set<string>,
  ) {
    this.policy = supervisor.newPolicy();
  }

  private deny(code: string, message: string): never {
    this.run.admissionError ??= { code, message };
    throw new AdmissionError(code);
  }

  check(
    toolCallId: string,
    toolName: string,
    signal: AbortSignal | undefined,
    phase?: "prepare",
  ): void {
    this.policy.check(toolCallId, toolName, signal, phase);
  }

  /**
   * Only tools of admitted capabilities exist on a child (Pi rejects any other
   * name before admission). The permit needs the validated arguments' digest,
   * so the durable reservation happens in prepare().
   */
  reserve(): void {}

  async prepare(
    toolCallId: string,
    toolName: string,
    validatedArgs: unknown,
    parentToolCallId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const cap = this.toolCaps.get(toolName)!;
    const path = isObject(validatedArgs) ? validatedArgs.path : undefined;
    if (path !== undefined) {
      const rel =
        typeof path === "string" ? confine(this.root, path) : undefined;
      if (rel === undefined)
        this.deny(
          "PATH_OUTSIDE_WORKSPACE",
          `${toolName} path is outside the child root`,
        );
      const target = resolve(this.root, rel);
      if (isSecretPath(rel))
        this.deny("POLICY_DENIED", `${toolName} secret path is denied`);
      // Pi read aliases missing files; only admit the exact target we checked.
      if (toolName === "read" && !existsSync(target))
        this.deny(
          "PATH_OUTSIDE_WORKSPACE",
          "read path must exist without aliases",
        );
      let probe = target;
      while (!existsSync(probe) && dirname(probe) !== probe)
        probe = dirname(probe);
      if (
        isSecretPath(
          relative(
            realpathSync.native(this.root),
            // Native resolution expands Windows short names before matching.
            resolve(realpathSync.native(probe), relative(probe, target)),
          )
            .split(sep)
            .join("/"),
        )
      )
        this.deny("POLICY_DENIED", `${toolName} secret path is denied`);
      if (cap === "fs.write") {
        try {
          this.supervisor.claim(this.run.childId, rel);
        } catch (error) {
          if (error instanceof AdmissionError)
            this.deny(error.code, `${rel} is claimed by another child`);
          throw error;
        }
        this.claims.add(rel);
      }
    }
    try {
      this.supervisor.admit(
        this.policy,
        this.run,
        toolCallId,
        toolName,
        cap,
        validatedArgs,
      );
      this.policy.reserve(toolCallId, toolName, signal);
      await this.policy.prepare(
        toolCallId,
        toolName,
        validatedArgs,
        parentToolCallId,
        signal,
      );
    } catch (error) {
      if (error instanceof AdmissionError)
        this.run.admissionError ??= {
          code: error.code,
          message: `${toolName}: ${error.code}`,
        };
      throw error;
    }
  }

  finish(
    toolCallId: string,
    toolName: string,
    args: unknown,
    signal: AbortSignal | undefined,
  ): void {
    this.policy.finish(toolCallId, toolName, args, signal);
  }

  discard(toolCallId: string, reason: "canceled" | "denied"): void {
    this.policy.discard(toolCallId, reason);
  }

  execute<T extends { isError: boolean }>(
    toolCallId: string,
    toolName: string,
    args: unknown,
    invoke: (admittedArgs: unknown) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return this.policy.execute(toolCallId, toolName, args, invoke, signal);
  }
}

/** Workspace-relative posix path inside `root`, or undefined when it escapes (incl. links). */
export function confine(root: string, path: string): string | undefined {
  if (
    !path ||
    /^[@~\/\\]/.test(path) ||
    /file:/i.test(path) ||
    path.includes("\0")
  )
    return undefined;
  // Pi resolveToCwd's remaining normalization after excluding its path aliases.
  const normalized = path.replace(
    /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g,
    " ",
  );
  if (normalized !== path) return undefined;
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return undefined;
  let probe = target;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const realRoot = realpathSync.native(root);
  const realRel = relative(realRoot, realpathSync.native(probe));
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel))
    return undefined;
  return rel.split(sep).join("/") || ".";
}

function cite(
  out: Citation[],
  root: string,
  toolName: string,
  args: unknown,
  result: unknown,
): void {
  const push = (path: unknown, line?: unknown): void => {
    if (typeof path !== "string" || !path) return;
    const rel = confine(root, path);
    if (rel === undefined) return;
    const c: Citation =
      Number.isSafeInteger(line) && (line as number) > 0
        ? { path: rel, line: line as number }
        : { path: rel };
    if (!out.some((o) => o.path === c.path && o.line === c.line)) out.push(c);
  };
  if (toolName === "read" && isObject(args)) push(args.path, args.offset);
  const details = isObject(result) ? result.details : undefined;
  if (isObject(details)) {
    if (Array.isArray(details.results))
      for (const hit of details.results)
        if (isObject(hit)) push(hit.path, hit.line);
    if (typeof details.path === "string") push(details.path);
  }
}

const assistant = (messages: readonly unknown[]) =>
  messages.filter(
    (m): m is Record<string, unknown> => isObject(m) && m.role === "assistant",
  );
function lastText(messages: readonly unknown[]): string {
  const last = assistant(messages).at(-1);
  return Array.isArray(last?.content)
    ? last.content
        .filter((c) => isObject(c) && c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join("\n")
    : "";
}
function lastStop(messages: readonly unknown[]): unknown {
  return assistant(messages).at(-1)?.stopReason;
}
/** A call to a tool the child was never given is a denied capability. */
function unknownTool(
  messages: readonly unknown[],
  toolCaps: ReadonlyMap<string, Capability>,
): { code: string; message: string } | undefined {
  for (const message of assistant(messages).reverse())
    if (Array.isArray(message.content))
      for (const part of message.content)
        if (
          isObject(part) &&
          part.type === "toolCall" &&
          typeof part.name === "string" &&
          !toolCaps.has(part.name)
        )
          return {
            code: "CAPABILITY_DENIED",
            message: `tool ${part.name} is outside this child's capabilities`,
          };
  return undefined;
}

export interface SubagentTool {
  name: string;
  description: string;
  readOnly: boolean;
  parameters: Record<string, unknown>;
  execute(args: unknown): Promise<unknown>;
}

/** Parent-facing tools, same shape as codeIndexTools. */
export function subagentTools(
  supervisor: SubagentSupervisor,
): readonly SubagentTool[] {
  return Object.freeze([
    {
      name: "spawn_subagents",
      description:
        "Run delegated child agents and wait for their results. Each task has a prompt; mode 'read' (default) can only read, search and query; mode 'write' edits an isolated worktree that the user must approve before it is applied. Use `after` to order tasks and a `team` to give tasks named roles.",
      readOnly: false,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["tasks"],
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: supervisor.limits.maxTasks,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["prompt"],
              properties: {
                id: { type: "string", pattern: "^[\\w.-]{1,64}$" },
                prompt: { type: "string", minLength: 1, maxLength: MAX_PROMPT },
                mode: { type: "string", enum: [...SUBAGENT_MODES] },
                role: { type: "string" },
                after: { type: "array", items: { type: "string" } },
                capabilities: {
                  type: "array",
                  items: { type: "string", enum: [...CAPABILITIES] },
                },
              },
            },
          },
          team: {
            type: "object",
            additionalProperties: false,
            required: ["name", "roles"],
            properties: {
              name: { type: "string", minLength: 1 },
              roles: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
          },
          budget: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(
              ["concurrency", "maxTurns", "maxTokens", "wallClockMs"].map(
                (k) => [k, { type: "integer", minimum: 1 }],
              ),
            ),
          },
        },
      },
      execute: (args: unknown) =>
        supervisor.run(parseSpawnInput(args, supervisor.limits)),
    },
  ]);
}
