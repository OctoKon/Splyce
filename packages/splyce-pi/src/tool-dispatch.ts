// Tool dispatch: workspace tools (#161) and read-only agent context tools wired
// into a Pi session so that EVERY effect goes through NativePolicy.execute
// (grants, once-consume, receipts). Pi's loop calls the admission object bound
// to each tool: reserve -> prepare(validated args) -> finish -> execute. The
// adapter below maps those onto NativePolicy and mints the permit and the
// once grant only after the arguments are validated (the digest binds them).
//
// No Pi import: the host injects the bound session, its tools, `bindTool`
// (Pi's bindSplyceToolAdmission) and the native ports, so this module is a thin
// seam the engine factory only has to wire.

import { randomUUID } from "node:crypto";
import { readPermissionMode } from "./permission-modes.js";
import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  type GrantRecord,
  type SplyceEventDraft,
} from "./contracts.js";
import {
  AdmissionError,
  actionArgumentsDigest,
  type ActionPermit,
  type ExecuteEvents,
  type NativePolicy,
} from "./policy.js";
import type { CallerContext, Store, WorkspaceOwnership } from "./store.js";
import {
  WorkspaceToolError,
  createWorkspaceTools,
  scrubSecrets,
  type Act,
  type GrantPort,
  type ReceiptPort,
  type ToolSummary,
  type WorkspacePort,
  type WorkspaceTool,
} from "./workspace-tools.js";
import {
  ContextToolError,
  captureMemoryAfterTurn,
  createAgentContextTools,
  type AgentContextToolsOptions,
  type ContextTool,
  type MemoryLike,
} from "./agent-context-tools.js";

type Capability = Extract<
  GrantRecord["capability"],
  "fs.read" | "fs.write" | "shell.run"
>;
const CAPABILITY: Readonly<Record<string, Capability>> = {
  read: "fs.read",
  ls: "fs.read",
  find: "fs.read",
  grep: "fs.read",
  write: "fs.write",
  edit: "fs.write",
  bash: "shell.run",
  powershell: "shell.run",
};
const ONCE: ReadonlySet<Capability> = new Set(["fs.write", "shell.run"]);
const PREVIEW_MAX = 2048;
/** Read-only intent summaries are bounded; approval summaries are never truncated (see APPROVAL_ARGS_MAX). */
const ARGS_SUMMARY_MAX = 512;
/** A once-capability call whose complete redacted arguments exceed this is denied, never truncated. */
export const APPROVAL_ARGS_MAX = 16 * 1024;
const UNAVAILABLE = "[unavailable]";

/**
 * Complete (fail-closed) redaction on the WHOLE string: the native lane first (original text), then
 * the live-secret redactor and the built-in scrub. A lane failure yields `[unavailable]`, never raw text. Typed so it can be passed as the
 * `redact` option of tools that accept async redactors (redact BEFORE any cap).
 */
export type CompleteRedactor = (
  text: string,
  signal?: AbortSignal,
) => string | Promise<string>;
export interface CompleteRedactorDeps {
  /** Sync live-secret redactor (CredentialResolver.redact). */
  redact(text: string): string;
  /** NativeControl.redact (Rust credential.redact lane). */
  nativeRedact(
    text: string,
    signal?: AbortSignal,
  ): Promise<string | { text: string }>;
}
async function strictRedact(
  deps: CompleteRedactorDeps,
  text: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    // Native FIRST on the ORIGINAL text: a generic scrub that ran first could rewrite part of an
    // overlapping active credential so the native matcher no longer sees it whole (tail survives).
    const out = await deps.nativeRedact(text, signal);
    const redacted = typeof out === "string" ? out : out.text;
    return typeof redacted === "string"
      ? scrubSecrets(deps.redact(redacted))
      : undefined;
  } catch {
    return undefined;
  }
}
export const createCompleteRedactor =
  (deps: CompleteRedactorDeps): CompleteRedactor =>
  async (text, signal) =>
    (await strictRedact(deps, text, signal)) ?? UNAVAILABLE;

/** Returned instead of any text that an upstream tool truncated before it could be redacted whole. */
export const WITHHELD = "[output withheld: truncated before redaction]";

export class ToolDispatchError extends Error {
  readonly code:
    | "TOOL_REGISTRY_FROZEN"
    | "TOOL_REGISTRY_FOREIGN"
    | "SESSION_REGISTRATION_FAILED";
  constructor(code: ToolDispatchError["code"]) {
    super(code);
    this.name = "ToolDispatchError";
    this.code = code;
  }
}

/** Shape of one tool as the Pi session consumes it (the factory adds label/schema typing). */
export interface DispatchTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<DispatchResult>;
}
export interface DispatchResult {
  content: { type: "text"; text: string }[];
  details: { summary?: ToolSummary; code?: string };
  isError?: boolean;
}

/** Pi's SplyceToolAdmission, restated structurally. */
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

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  actionId: string;
  capability: Capability;
  /** Redacted. */
  target: string;
  /** Redacted, bounded. */
  argsSummary: string;
}

/**
 * Pi paths that rebuild or clone tool objects after construction (agent-session.ts):
 * reload() and _buildRuntime() -> _refreshToolRegistry() (every tool wrapped anew),
 * setActiveToolsByName() -> _setActiveTools() -> _applyToolLoadout() (assigns
 * agent.state.tools and, with a prepareLoadout hook, clones `{...tool, description}`).
 */
export interface PiSessionLike {
  agent: { state: { tools: readonly object[] } };
  reload?: unknown;
  _refreshToolRegistry?: unknown;
  _buildRuntime?: unknown;
  setActiveToolsByName?: unknown;
  _setActiveTools?: unknown;
  _applyToolLoadout?: unknown;
  /** Pi's AgentSession.getToolDefinition: the definition the registry (and so Pi's wrapper) runs. */
  getToolDefinition?: (name: string) => unknown;
}

/** Never needed by an owned session: denied outright. */
const DENIED_PATHS = [
  "reload",
  "_refreshToolRegistry",
  "_buildRuntime",
  "setActiveToolsByName",
] as const;
/** Pi calls these itself on every prompt / tree switch: allowed only while they keep bound tool objects. */
const VERIFIED_PATHS = ["_setActiveTools", "_applyToolLoadout"] as const;

export interface ToolDispatchDeps {
  store: Store;
  policy: NativePolicy;
  caller: CallerContext;
  /** Run scope = permit.targetScopeId = event scope. */
  scopeId: string;
  workspaceId: string;
  runId: string;
  /** The running run record the permits are bound to. */
  runRecordId: string;
  ownership: WorkspaceOwnership;
  /** A live session-scoped fs.read grant already on the run and in CurrentPolicy.grantIds. */
  readGrantId: string;
  /** Adds a freshly minted once grant to the run and the host's live grant set. */
  attachGrant(grantId: string): void;
  /** Renderer approval round trip (the factory emits approval.requested); true = approved. */
  approve(request: ApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  /** Native durable authority, never renderer/model arguments. */
  permissionMode?(): "manual" | "auto" | "bypass";
  /** Sync live-secret redactor (CredentialResolver.redact). */
  redact(text: string): string;
  /** NativeControl.redact (Rust credential.redact lane). Rejection fails closed. */
  nativeRedact(
    text: string,
    signal?: AbortSignal,
  ): Promise<string | { text: string }>;
  /**
   * The native provider registration of the session being started (Codex's factory passes
   * the real, awaitable `registerNativeProvider`). Awaited before any tool is bound; a
   * rejection fails the start with SESSION_REGISTRATION_FAILED and nothing is bound.
   */
  registerNativeProvider(): Promise<void>;
  /** Pi's bindSplyceToolAdmission. */
  bindTool(tool: object, admission: ToolAdmission): () => void;
  onEventsCommitted?(): void;
  argumentsArtifactId?(
    actionId: string,
    digest: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<string>;
  context?: Pick<
    AgentContextToolsOptions,
    "index" | "codeTools" | "memory" | "scopeId"
  >;
  limits?: { timeoutMs: number; maxOutputBytes: number };
  /**
   * Overrides the complete redactor the dispatch passes to its workspace and context tools (default:
   * `createCompleteRedactor(deps)`). Those tools redact the COMPLETE output before any cap, so their
   * truncation happens after redaction and truncated output is safe to return.
   */
  asyncToolRedactor?: CompleteRedactor;
  /**
   * Custom read-only tools NOT built with the complete redactor. Anything they truncate cannot be
   * redacted whole here, so their truncated output is WITHHELD.
   */
  extraTools?: readonly ContextTool[];
}

interface Call {
  name: string;
  actionId: string;
  permit: Readonly<ActionPermit>;
  argsSummary: string;
  reserved: boolean;
  admitted: boolean;
  /** Set only by an adapter-created tool implementation when it actually runs. */
  ownImpl: boolean;
  consumed: boolean;
  effectSummary?: string;
}

const safeId = (value: string): string => value.replace(/[^\w.-]/gu, "_");
const hex = (digest: string): string => digest.replace(/^sha256:/u, "");
const hash32 = (text: string): number =>
  [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);

export interface ToolDispatch {
  tools: readonly DispatchTool[];
  /** Tool names for the Pi `tools` allowlist (customTools only; no built-ins). */
  allowlist: readonly string[];
  admission: ToolAdmission;
  /**
   * Awaits registerNativeProvider, then binds the admission to every tool of the session
   * and freezes its registry. No detached async: any failure rejects the returned promise.
   */
  bind(session: PiSessionLike): Promise<() => void>;
  /** Call once per turn end; memory capture runs only after a completed turn. */
  onTurnEnd(turn: { state: "completed" | "failed" | "canceled" }): number;
}

export function createToolDispatch(deps: ToolDispatchDeps): ToolDispatch {
  const { store, policy, caller } = deps;
  const calls = new Map<string, Call>();
  const byAction = new Map<string, Call>();

  // Permit-backed ports: NativePolicy owns the real grant check, the once-consume
  // and the (single) receipt; these only prove the tool runs for the admitted act.
  const grants: GrantPort = {
    check(req) {
      const call = byAction.get(req.actionId);
      const { permit } = call ?? {};
      if (
        !call ||
        !permit ||
        !call.admitted ||
        permit.capability !== req.capability ||
        permit.ownership.workspaceId !== req.workspaceId ||
        caller.sessionId !== req.sessionId ||
        hex(permit.argumentsDigest) !== hex(req.argumentsDigest)
      )
        return { ok: false, reason: "GRANT_REQUIRED" };
      if (
        permit.approvedBy &&
        permit.approvedBy !==
          `mode:${deps.permissionMode?.() ?? readPermissionMode(store, deps.workspaceId, caller.sessionId)}`
      )
        return { ok: false, reason: "GRANT_REVOKED" };
      return {
        ok: true,
        grantId: permit.grantId,
        scope: ONCE.has(req.capability) ? "once" : "session",
      };
    },
    consume(_grantId, intent: Act) {
      const call = byAction.get(intent.actionId);
      if (!call?.admitted || call.consumed) throw new Error("GRANT_CONSUMED");
      call.consumed = true;
    },
  };
  const receipts: ReceiptPort = {
    record(effect) {
      const summary = effect.summary;
      const call = byAction.get(effect.actionId);
      if (call) call.effectSummary = summary;
      return effect.actionId;
    },
  };
  const workspaces: WorkspacePort = {
    workspace(id) {
      const ws = store.getWorkspace(id);
      return ws
        ? {
            workspaceId: ws.workspaceId,
            canonicalPath: ws.canonicalPath,
            revision: hash32(ws.revision),
          }
        : undefined;
    },
  };

  /** Sync scrub, then the Rust lane; a lane failure yields a placeholder, never raw text. */
  const redactStrict = (
    text: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> => strictRedact(deps, text, signal);
  const redactFinal = async (
    text: string,
    signal?: AbortSignal,
  ): Promise<string> => (await redactStrict(text, signal)) ?? UNAVAILABLE;

  const complete: CompleteRedactor =
    deps.asyncToolRedactor ?? createCompleteRedactor(deps);
  const workspaceTools = createWorkspaceTools({
    workspaces,
    grants,
    receipts,
    sessionId: caller.sessionId,
    workspaceId: deps.workspaceId,
    ...(deps.limits ? { limits: deps.limits } : {}),
    redact: complete,
  });
  const root = workspaces.workspace(deps.workspaceId)?.canonicalPath;
  const contextTools: readonly ContextTool[] =
    deps.context && root
      ? createAgentContextTools({
          ...deps.context,
          workspaceRoot: root,
          redact: complete,
        })
      : [];
  const extraTools = deps.extraTools ?? [];
  const impls = new Map<string, WorkspaceTool | ContextTool>([
    ...Object.entries(workspaceTools),
    ...contextTools.map((t): [string, ContextTool] => [t.name, t]),
    ...extraTools.map((t): [string, ContextTool] => [t.name, t]),
  ]);
  const untrusted = new Set<WorkspaceTool | ContextTool>(extraTools);
  const caps = new Map<string, Capability>(Object.entries(CAPABILITY));
  // Context tools are read-only: fs.read (session grant, never consumed).
  for (const tool of [...contextTools, ...extraTools])
    caps.set(tool.name, "fs.read");

  /** Provenance: Pi copies `parameters` by reference into the AgentTool it builds from our definition. */
  const brand = new WeakMap<object, string>();
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };
  // Never cut before redacting. Output the upstream tool already truncated cannot be redacted whole
  // here (a credential may straddle its cut): it is withheld unless the tool redacts before it caps.
  const truncatedUpstream = (text: string, truncated: boolean): boolean =>
    truncated || /\n\[output truncated\]$/u.test(text);
  const owned = new WeakSet<object>();

  const tools: readonly DispatchTool[] = Object.freeze(
    [...impls.values()].map((impl) => {
      const parameters = deepFreeze(
        JSON.parse(JSON.stringify(impl.parameters)) as Record<string, unknown>,
      );
      brand.set(parameters, impl.name);
      const definition: DispatchTool = Object.freeze({
        name: impl.name,
        label: impl.name,
        description: impl.description,
        parameters,
        async execute(
          toolCallId: string,
          args: Record<string, unknown>,
          signal?: AbortSignal,
        ): Promise<DispatchResult> {
          const call = calls.get(toolCallId);
          // Defense in depth: Pi bound tool.execute is a thrower; this refuses
          // anything that did not come through ToolAdmission.execute.
          if (!call?.admitted || call.name !== impl.name)
            throw new AdmissionError("POLICY_DENIED");
          call.ownImpl = true;
          try {
            const r = await impl.result(args, signal, call.actionId);
            if (
              truncatedUpstream(r.text, r.summary.truncated) &&
              untrusted.has(impl)
            ) {
              const { preview: _preview, ...rest } = r.summary;
              return {
                content: [{ type: "text", text: WITHHELD }],
                details: {
                  summary: { ...rest, truncated: true, preview: "" },
                },
              };
            }
            // Redact the COMPLETE string first, then derive the preview from the redacted text.
            const body = await redactFinal(r.text, signal);
            return {
              content: [{ type: "text", text: body }],
              details: {
                summary: { ...r.summary, preview: body.slice(0, PREVIEW_MAX) },
              },
            };
          } catch (error) {
            // Every exception becomes a typed, redacted result: no raw message, stack or cause.
            if (
              error instanceof WorkspaceToolError ||
              error instanceof ContextToolError
            ) {
              const summary = (error as WorkspaceToolError).summary;
              // a preview at the 2048 cap (or flagged) was cut upstream: omit it rather than redact a cut
              const previewCut =
                summary !== undefined &&
                (summary.truncated || summary.preview.length >= PREVIEW_MAX);
              const preview =
                summary && (!previewCut || !untrusted.has(impl))
                  ? (await redactFinal(summary.preview, signal)).slice(
                      0,
                      PREVIEW_MAX,
                    )
                  : "";
              return {
                content: [
                  {
                    type: "text",
                    text: `${error.code}: ${await redactFinal(error.message, signal)}`,
                  },
                ],
                details: {
                  code: error.code,
                  ...(summary ? { summary: { ...summary, preview } } : {}),
                },
                isError: true,
              };
            }
            if (error instanceof AdmissionError) throw error;
            return {
              content: [{ type: "text", text: "TOOL_FAILED" }],
              details: { code: "TOOL_FAILED" },
              isError: true,
            };
          }
        },
      });
      owned.add(definition);
      return definition;
    }),
  );

  const draft = <K extends "turn.tool_intent" | "turn.tool_outcome">(
    kind: K,
    recordId: string,
    payload: Extract<SplyceEventDraft, { kind: K }>["payload"],
  ): SplyceEventDraft =>
    ({
      schemaVersion: CONTRACT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      eventId: randomUUID(),
      recordId,
      createdAt: new Date().toISOString(),
      sourceIds: [recordId],
      sessionId: caller.sessionId,
      scopeId: deps.scopeId,
      durable: true,
      kind,
      payload,
    }) as SplyceEventDraft;

  type Executed = {
    result?: { details?: DispatchResult["details"] };
    isError: boolean;
    durationMs?: number;
  };

  const need = (toolCallId: string): Call => {
    const call = calls.get(toolCallId);
    if (!call) throw new AdmissionError("POLICY_DENIED");
    return call;
  };

  const rawAdmission: ToolAdmission = {
    check(toolCallId, toolName, signal, phase) {
      if (calls.has(toolCallId))
        policy.check(toolCallId, toolName, signal, phase);
    },
    reserve() {
      // The permit needs the validated arguments' digest; reservation happens in prepare.
    },
    async prepare(toolCallId, toolName, validatedArgs, parent, signal) {
      const capability = caps.get(toolName);
      if (parent !== undefined) throw new AdmissionError("INVALID_PARENT");
      if (!capability || !impls.has(toolName))
        throw new AdmissionError("CAPABILITY_REQUIRED");
      const digest = actionArgumentsDigest(validatedArgs);
      const actionId = safeId(toolCallId);
      const args = validatedArgs as Record<string, unknown>;
      try {
        await workspaceTools[toolName]?.validatePath?.(args);
      } catch {
        throw new AdmissionError("POLICY_DENIED");
      }
      const target =
        typeof args.path === "string"
          ? args.path
          : typeof args.pattern === "string"
            ? args.pattern
            : toolName;
      const redactedArgs = await redactStrict(
        JSON.stringify(validatedArgs),
        signal,
      );
      const once = ONCE.has(capability);
      const mode =
        deps.permissionMode?.() ??
        readPermissionMode(store, deps.workspaceId, caller.sessionId);
      if (!["manual", "auto", "bypass"].includes(mode))
        throw new AdmissionError("POLICY_DENIED");
      const automatic =
        once &&
        (mode === "bypass" || (mode === "auto" && capability === "fs.write"));
      // cwd is not a sandbox. Only literal diagnostics are safe to run without shell approval.
      const confinedShell =
        capability !== "shell.run" ||
        !automatic ||
        (toolName === "bash" && args.command === "pwd") ||
        (toolName === "powershell" && args.command === "Get-Location");
      // What the approver sees is the COMPLETE redacted argument text of exactly the call whose
      // digest the grant binds. If it cannot be shown whole (lane down, or over the cap) the
      // call is denied; it is never truncated.
      const showable =
        redactedArgs !== undefined &&
        redactedArgs.length <= APPROVAL_ARGS_MAX &&
        confinedShell;
      const argsSummary = once
        ? (redactedArgs ?? UNAVAILABLE)
        : (redactedArgs ?? UNAVAILABLE).slice(0, ARGS_SUMMARY_MAX);
      let grantId = deps.readGrantId;
      if (once) {
        // Once capability: native mode or explicit approval is required. An
        // unapproved call authorizes against a grant id that is not live, so the
        // policy denies it with a durable receipt before anything runs.
        grantId = "grant-unapproved";
        const approved =
          showable &&
          (automatic ||
            (await deps
              .approve(
                {
                  toolCallId,
                  toolName,
                  actionId,
                  capability,
                  target: await redactFinal(target, signal),
                  argsSummary,
                },
                signal,
              )
              .catch(() => false)));
        if (approved && !signal?.aborted) {
          const minted = store.mintGrant(
            {
              workspaceId: deps.workspaceId,
              sessionId: caller.sessionId,
              capability,
              scope: "once",
              actionId,
              argumentsDigest: digest,
            },
            caller,
          );
          deps.attachGrant(minted.grantId);
          grantId = minted.grantId;
        }
      }
      const permit: ActionPermit = {
        toolCallId,
        toolName,
        actionId,
        runRecordId: deps.runRecordId,
        grantId,
        parentActionId: null,
        capabilityId: `workspace.${toolName}`,
        capabilityVersion: "1",
        argumentsArtifactId:
          (await deps.argumentsArtifactId?.(
            actionId,
            digest,
            validatedArgs,
            signal,
          )) ?? `args-${actionId}`,
        argumentsDigest: digest,
        targetScopeId: deps.scopeId,
        idempotencyKey: `${deps.runId}:${toolCallId}`,
        ownership: deps.ownership,
        capability,
        ...(automatic && showable
          ? { approvedBy: `mode:${mode}` as "mode:auto" | "mode:bypass" }
          : {}),
      };
      policy.authorize(permit);
      calls.set(toolCallId, {
        name: toolName,
        actionId,
        permit,
        argsSummary,
        reserved: false,
        admitted: false,
        ownImpl: false,
        consumed: false,
      });
      byAction.set(actionId, calls.get(toolCallId)!);
      policy.reserve(toolCallId, toolName, signal);
      need(toolCallId).reserved = true;
      await policy.prepare(
        toolCallId,
        toolName,
        validatedArgs,
        undefined,
        signal,
      );
    },
    finish(toolCallId, toolName, args, signal) {
      need(toolCallId);
      policy.finish(toolCallId, toolName, args, signal);
    },
    discard(toolCallId, reason) {
      const call = calls.get(toolCallId);
      if (call?.reserved) policy.discard(toolCallId, reason);
      if (call) byAction.delete(call.actionId);
      calls.delete(toolCallId);
    },
    async execute<T extends { isError: boolean }>(
      toolCallId: string,
      toolName: string,
      args: unknown,
      invoke: (admittedArgs: unknown) => Promise<T>,
      signal: AbortSignal | undefined,
    ): Promise<T> {
      const call = need(toolCallId);
      if (
        call.permit.approvedBy &&
        call.permit.approvedBy !==
          `mode:${deps.permissionMode?.() ?? readPermissionMode(store, deps.workspaceId, caller.sessionId)}`
      ) {
        policy.discard(toolCallId, "denied");
        throw new AdmissionError("POLICY_DENIED");
      }
      const events: ExecuteEvents<T> = {
        intent: (running) =>
          draft("turn.tool_intent", running.recordId, {
            runId: deps.runId,
            actionId: call.actionId,
            capabilityId: call.permit.capabilityId,
            // `target` is a resolvable reference; the readable target is in argsSummary.
            target: deps.workspaceId,
            argsSummary: call.argsSummary,
          }),
        outcome: async ({ action, uncertain, result }) => {
          const executed = result as unknown as Executed | undefined;
          const status: "success" | "error" | "uncertain" =
            executed === undefined
              ? "uncertain"
              : executed.isError || uncertain
                ? "error"
                : "success";
          const details = executed?.result?.details;
          const raw = details?.summary;
          // already redacted fail-closed in the tool wrapper
          const preview = (raw?.preview ?? "").slice(0, PREVIEW_MAX);
          const summary: {
            exitCode?: number | null;
            durationMs?: number;
            bytes?: number;
            truncated?: boolean;
            preview?: string;
          } = {
            durationMs: raw?.durationMs ?? executed?.durationMs ?? 0,
            bytes: raw?.bytes ?? 0,
            truncated: raw?.truncated ?? false,
            preview,
          };
          if (raw?.exitCode !== undefined) summary.exitCode = raw.exitCode;
          return draft("turn.tool_outcome", action.recordId, {
            runId: deps.runId,
            actionId: call.actionId,
            status,
            ...(details?.code ? { error: details.code } : {}),
            summary,
          });
        },
      };
      try {
        return await policy.execute(
          toolCallId,
          toolName,
          args,
          async (admittedArgs) => {
            deps.onEventsCommitted?.();
            call.admitted = true;
            const out = await invoke(admittedArgs);
            // A foreign implementation behind a bound name never marks itself: its effect is
            // recorded uncertain instead of success.
            if (!call.ownImpl) throw new Error("FOREIGN_IMPLEMENTATION");
            return out;
          },
          signal,
          events,
        );
      } catch (error) {
        // An execute that failed before the policy consumed the reservation (no finish, stale
        // permit) must not leave a proposed reservation behind; discard is a no-op otherwise.
        if (call.reserved) policy.discard(toolCallId, "denied");
        throw error;
      } finally {
        try {
          deps.onEventsCommitted?.();
        } finally {
          call.admitted = false;
          byAction.delete(call.actionId);
          calls.delete(toolCallId);
        }
      }
    },
  };

  // Every exception through the adapter (tool, redactor, native lane, policy, store) is typed and
  // generic: nothing raw (message, stack, cause) reaches Pi, the model or the transcript.
  const clean = (error: unknown): Error =>
    error instanceof AdmissionError || error instanceof ToolDispatchError
      ? error
      : new AdmissionError("ADAPTER_FAILURE");
  const admission: ToolAdmission = {
    check(...a) {
      try {
        rawAdmission.check(...a);
      } catch (error) {
        throw clean(error);
      }
    },
    reserve(...a) {
      try {
        rawAdmission.reserve(...a);
      } catch (error) {
        throw clean(error);
      }
    },
    async prepare(...a) {
      try {
        await rawAdmission.prepare(...a);
      } catch (error) {
        throw clean(error);
      }
    },
    finish(...a) {
      try {
        rawAdmission.finish(...a);
      } catch (error) {
        throw clean(error);
      }
    },
    discard(...a) {
      try {
        rawAdmission.discard(...a);
      } catch (error) {
        throw clean(error);
      }
    },
    async execute(toolCallId, toolName, args, invoke, signal) {
      try {
        return await rawAdmission.execute(
          toolCallId,
          toolName,
          args,
          invoke,
          signal,
        );
      } catch (error) {
        throw clean(error);
      }
    },
  };

  const memory = deps.context?.memory;
  const memoryScope = deps.context?.scopeId;
  return {
    tools,
    allowlist: tools.map((t) => t.name),
    admission,
    async bind(session) {
      try {
        await deps.registerNativeProvider();
      } catch {
        throw new ToolDispatchError("SESSION_REGISTRATION_FAILED");
      }
      const live = session.agent.state.tools;
      // Provenance, never the name: Pi's registry must hold, for every tool, one of OUR frozen
      // definition objects (the one Pi's wrapper delegates to) and the AgentTool must carry that
      // definition's parameters object. A genuine schema on a foreign executor is not enough.
      const defs = new Map<string, object>();
      for (const tool of live) {
        const { name, parameters } = tool as {
          name?: string;
          parameters?: unknown;
        };
        const definition =
          typeof name === "string"
            ? (session.getToolDefinition?.(name) as
                { parameters?: unknown; name?: unknown } | undefined)
            : undefined;
        if (
          typeof name !== "string" ||
          definition === undefined ||
          typeof definition !== "object" ||
          !owned.has(definition) ||
          definition.name !== name ||
          definition.parameters !== parameters ||
          typeof parameters !== "object" ||
          parameters === null ||
          brand.get(parameters) !== name
        )
          throw new ToolDispatchError("TOOL_REGISTRY_FOREIGN");
        defs.set(name, definition);
      }
      const bound = new WeakSet<object>(live);
      const snapshot = [...live];
      const frozen = () => {
        throw new ToolDispatchError("TOOL_REGISTRY_FROZEN");
      };
      // Identity check at every dispatch phase: the registry the loop runs against must still be
      // exactly the bound tool objects (collection mutation, replaced state, prototype refresh).
      const registryIntact = () => {
        const current = session.agent.state.tools;
        if (
          current.length !== snapshot.length ||
          current.some((tool) => !bound.has(tool))
        )
          frozen();
        // the executor Pi would run is still exactly ours (registry definitions are immutable)
        for (const [name, definition] of defs)
          if (session.getToolDefinition?.(name) !== definition) frozen();
      };
      // A registry rejection must not leave a dangling reservation: discard (durable denied) first.
      const gate = (toolCallId: string) => {
        try {
          registryIntact();
        } catch (error) {
          admission.discard(toolCallId, "denied");
          throw error;
        }
      };
      const unbind = live.map((tool) => {
        const guarded: ToolAdmission = {
          check: (...a) => {
            gate(a[0]);
            admission.check(...a);
          },
          reserve: (...a) => {
            gate(a[0]);
            admission.reserve(...a);
          },
          prepare: async (...a) => {
            gate(a[0]);
            await admission.prepare(...a);
          },
          finish: (...a) => {
            gate(a[0]);
            admission.finish(...a);
          },
          // cleanup must always work
          discard: (...a) => admission.discard(...a),
          async execute(toolCallId, toolName, args, invoke, signal) {
            gate(toolCallId);
            return admission.execute(
              toolCallId,
              toolName,
              args,
              // verified again immediately before the effect and right after it
              async (admitted) => {
                registryIntact();
                const out = await invoke(admitted);
                registryIntact();
                return out;
              },
              signal,
            );
          },
        };
        return deps.bindTool(tool, guarded);
      });
      Object.freeze(live);
      // Pi rebuilds (and so unbinds) every tool object on these paths. An unbound tool
      // already fails closed in the loop (SPLYCE_UNAVAILABLE); this fails earlier and typed.
      const freeze = (key: string, value: unknown) =>
        Object.defineProperty(session, key, {
          value,
          configurable: false,
          writable: false,
        });
      for (const key of DENIED_PATHS) freeze(key, frozen);
      for (const key of VERIFIED_PATHS) {
        const original = session[key];
        if (typeof original !== "function") continue;
        freeze(key, function (this: unknown, ...args: unknown[]) {
          const previous = session.agent.state.tools;
          const out: unknown = original.apply(session, args);
          const now = session.agent.state.tools;
          if (now.some((tool) => !bound.has(tool))) {
            (session.agent.state as { tools: readonly object[] }).tools =
              previous;
            frozen();
          }
          return out;
        });
      }
      return () => {
        for (const u of unbind) u();
      };
    },
    onTurnEnd(turn) {
      if (turn.state !== "completed" || !memory || !memoryScope) return 0;
      try {
        return captureMemoryAfterTurn(memory, memoryScope, caller.sessionId);
      } catch {
        // a capture failure never fails the turn
        return 0;
      }
    },
  };
}
