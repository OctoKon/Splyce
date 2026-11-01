import { createHash, randomUUID } from "node:crypto";
import {
  CONTRACT_VERSION,
  GRANT_CAPABILITIES,
  type ActionRecord,
  type GrantRecord,
  type JsonValue,
  type RecordByKind,
  type RunRecord,
} from "./contracts.js";
import {
  Store,
  StoreError,
  type CallerContext,
  type DirectoryIdentity,
  type GrantUse,
  type OnceGrantConsumption,
  type WorkspaceOwnership,
} from "./store.js";

export class AdmissionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "AdmissionError";
    this.code = code;
  }
}

export interface CurrentPolicy {
  configRevision: string;
  profileRevision: string;
  policyRevision: string;
  grantIds: readonly string[];
  planMode: boolean;
}

/** Created by the native host after target and capability qualification. */
export interface ActionPermit {
  toolCallId: string;
  toolName: string;
  actionId: string;
  runRecordId: string;
  grantId: string;
  parentActionId: string | null;
  capabilityId: string;
  capabilityVersion: string;
  argumentsArtifactId: string;
  argumentsDigest: string;
  targetScopeId: string;
  idempotencyKey: string;
  ownership: WorkspaceOwnership;
  /** Explicit grant capability; never inferred from tool or capabilityId. */
  capability: GrantRecord["capability"];
  /** net.provider only: the qualified `scheme://host:port` origin. */
  origin?: string;
}

/** Native read of the admitted workspace directory's current identity. */
export interface WorkspaceIdentityPort {
  observe(workspaceId: string): DirectoryIdentity;
}

/** fs.write and shell.run consume a once grant; fs.read and net.provider use a session grant. */
const ONCE_CAPABILITIES: ReadonlySet<string> = new Set([
  "fs.write",
  "shell.run",
]);

/** Store grant/workspace failures that deny the action with a durable receipt. */
const GRANT_DENIALS: ReadonlySet<string> = new Set([
  "GRANT_REQUIRED",
  "GRANT_REVOKED",
  "GRANT_CONSUMED",
  "GRANT_MISMATCH",
  "WORKSPACE_NOT_ADMITTED",
  "WORKSPACE_IDENTITY_CHANGED",
]);

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !("value" in descriptor))
          throw new AdmissionError("INVALID_ARGUMENTS");
        return `${JSON.stringify(key)}:${canonical(descriptor.value)}`;
      })
      .join(",")}}`;
  }
  throw new AdmissionError("INVALID_ARGUMENTS");
}

export const actionArgumentsDigest = (args: unknown): string =>
  `sha256:${createHash("sha256").update(canonical(args)).digest("hex")}`;

function freezeJson(value: JsonValue): JsonValue {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** One actual store; the host owns permits and current authority. No renderer grant input. */
export class NativePolicy {
  private readonly store: Store;
  private readonly caller: CallerContext;
  private readonly current: () => CurrentPolicy;
  private readonly identity: WorkspaceIdentityPort;
  private readonly permits = new Map<string, Readonly<ActionPermit>>();
  private readonly prepared = new Set<string>();
  private readonly pending = new Map<string, string>();
  private readonly ready = new Map<string, string>();
  private readonly reservations = new Map<string, ActionRecord>();

  constructor(
    store: Store,
    caller: CallerContext,
    current: () => CurrentPolicy,
    identity: WorkspaceIdentityPort,
  ) {
    this.store = store;
    this.caller = Object.freeze({ ...caller });
    this.current = current;
    this.identity = identity;
  }

  authorize(permit: ActionPermit): void {
    if (this.permits.has(permit.toolCallId))
      throw new AdmissionError("DUPLICATE_PERMIT");
    this.permits.set(
      permit.toolCallId,
      Object.freeze({
        ...permit,
        ownership: Object.freeze({ ...permit.ownership }),
      }),
    );
  }

  check(
    toolCallId: string,
    toolName: string,
    signal: AbortSignal | undefined,
    phase?: "prepare",
  ): void {
    const permit = this.permits.get(toolCallId);
    if (!permit) throw new AdmissionError("POLICY_DENIED");
    if (
      phase === "prepare" &&
      (this.prepared.has(toolCallId) ||
        this.store
          .list(permit.targetScopeId)
          .records.some(
            ({ kind, record }) =>
              kind === "action" &&
              ((record as ActionRecord).idempotencyKey ===
                permit.idempotencyKey ||
                (record as ActionRecord).actionId === permit.actionId),
          ))
    )
      throw new AdmissionError("ACTION_REQUIRES_RECONCILIATION");
    if (signal?.aborted) this.deny(permit, "CANCELED");
    if (!(GRANT_CAPABILITIES as readonly unknown[]).includes(permit.capability))
      this.deny(permit, "CAPABILITY_REQUIRED");
    const policy = this.current();
    if (
      permit.toolName !== toolName ||
      policy.planMode ||
      policy.configRevision !== this.caller.configRevision ||
      policy.profileRevision !== this.caller.profileRevision ||
      policy.policyRevision !== this.caller.policyRevision ||
      !policy.grantIds.includes(permit.grantId)
    )
      this.deny(permit, "POLICY_DENIED");
    const stored = this.store.get(permit.runRecordId);
    const original = stored.record as RunRecord;
    const latest = this.store
      .list(permit.targetScopeId)
      .records.findLast(
        ({ kind, record }) =>
          kind === "run" && (record as RunRecord).runId === original.runId,
      );
    const run = (latest?.record ?? original) as RunRecord;
    if (
      stored.kind !== "run" ||
      run.state !== "running" ||
      run.piSessionId !== this.caller.sessionId ||
      run.profileRevision !== this.caller.profileRevision ||
      run.scopeId !== permit.targetScopeId ||
      run.workspaceId !== permit.ownership.workspaceId ||
      !run.grantIds.includes(permit.grantId)
    )
      this.deny(permit, "POLICY_DENIED");
    const owner = this.store.workspaceOwner(permit.ownership.workspaceId);
    if (
      !owner ||
      owner.ownerSessionId !== this.caller.sessionId ||
      owner.ownerSessionId !== permit.ownership.ownerSessionId ||
      owner.epoch !== permit.ownership.epoch
    )
      this.deny(permit, "STALE_OWNERSHIP");
    this.requireGrant(permit, ONCE_CAPABILITIES.has(permit.capability));
  }

  reserve(
    toolCallId: string,
    toolName: string,
    signal: AbortSignal | undefined,
  ): void {
    this.check(toolCallId, toolName, signal, "prepare");
    const permit = this.permits.get(toolCallId)!;
    const proposal = this.action(permit, "proposed");
    try {
      this.store.appendBatch(
        [{ kind: "action", record: proposal }],
        this.caller,
        {
          scopeId: permit.targetScopeId,
          actionId: permit.actionId,
          idempotencyKey: permit.idempotencyKey,
        },
        {
          workspaceId: permit.ownership.workspaceId,
          epoch: permit.ownership.epoch,
        },
      );
    } catch (error) {
      if (error instanceof StoreError && error.code === "ACTION_ALREADY_EXISTS")
        throw new AdmissionError("ACTION_REQUIRES_RECONCILIATION");
      throw error;
    }
    this.prepared.add(toolCallId);
    this.reservations.set(toolCallId, proposal);
  }

  async prepare(
    toolCallId: string,
    toolName: string,
    validatedArgs: unknown,
    parentToolCallId: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    this.check(toolCallId, toolName, signal);
    const permit = this.permits.get(toolCallId)!;
    if (
      !this.reservations.has(toolCallId) ||
      this.pending.has(toolCallId) ||
      this.ready.has(toolCallId)
    )
      throw new AdmissionError("PREPARATION_REQUIRED");
    if (actionArgumentsDigest(validatedArgs) !== permit.argumentsDigest)
      this.deny(permit, "ARGUMENTS_CHANGED");
    const parent =
      parentToolCallId === undefined
        ? undefined
        : this.permits.get(parentToolCallId);
    if (
      permit.parentActionId === null
        ? parentToolCallId !== undefined
        : !parent ||
          parent.toolCallId === permit.toolCallId ||
          parent.actionId !== permit.parentActionId ||
          parent.runRecordId !== permit.runRecordId ||
          parent.targetScopeId !== permit.targetScopeId ||
          parent.ownership.workspaceId !== permit.ownership.workspaceId ||
          parent.ownership.ownerSessionId !== permit.ownership.ownerSessionId ||
          parent.ownership.epoch !== permit.ownership.epoch
    )
      this.deny(permit, "INVALID_PARENT");
    if (parent) {
      this.check(parent.toolCallId, parent.toolName, signal);
      const latest = this.store
        .list(permit.targetScopeId)
        .records.findLast(
          ({ kind, record }) =>
            kind === "action" &&
            (record as ActionRecord).actionId === parent.actionId,
        )?.record as ActionRecord | undefined;
      if (latest?.state !== "running") this.deny(permit, "PARENT_NOT_RUNNING");
    }
    this.pending.set(toolCallId, actionArgumentsDigest(validatedArgs));
  }

  finish(
    toolCallId: string,
    toolName: string,
    args: unknown,
    signal: AbortSignal | undefined,
  ): void {
    this.check(toolCallId, toolName, signal);
    const permit = this.permits.get(toolCallId)!;
    const digest = this.pending.get(toolCallId);
    this.pending.delete(toolCallId);
    if (!digest) throw new AdmissionError("PREPARATION_REQUIRED");
    if (digest !== actionArgumentsDigest(args))
      this.deny(permit, "ARGUMENTS_CHANGED");
    this.ready.set(toolCallId, digest);
  }

  discard(toolCallId: string, reason: "canceled" | "denied"): void {
    this.pending.delete(toolCallId);
    this.ready.delete(toolCallId);
    const proposal = this.reservations.get(toolCallId);
    this.reservations.delete(toolCallId);
    if (proposal)
      this.store.append(
        {
          kind: "action",
          record: { ...proposal, recordId: randomUUID(), state: reason },
        },
        this.caller,
      );
  }

  async execute<T extends { isError: boolean }>(
    toolCallId: string,
    toolName: string,
    args: unknown,
    invoke: (admittedArgs: unknown) => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    this.check(toolCallId, toolName, signal);
    const permit = this.permits.get(toolCallId)!;
    const serialized = canonical(args);
    const preparedDigest = this.ready.get(toolCallId);
    if (!preparedDigest) throw new AdmissionError("PREPARATION_REQUIRED");
    this.ready.delete(toolCallId);
    if (
      `sha256:${createHash("sha256").update(serialized).digest("hex")}` !==
        permit.argumentsDigest ||
      preparedDigest !== permit.argumentsDigest
    )
      this.deny(permit, "ARGUMENTS_CHANGED");
    const admittedArgs = freezeJson(JSON.parse(serialized) as JsonValue);
    const proposal = this.reservations.get(toolCallId);
    if (!proposal) throw new AdmissionError("PREPARATION_REQUIRED");
    this.reservations.delete(toolCallId);
    const history = this.store.list(permit.targetScopeId).records;
    if (permit.parentActionId !== null) {
      const parent = history.findLast(
        ({ kind, record }) =>
          kind === "action" &&
          (record as ActionRecord).actionId === permit.parentActionId,
      )?.record as ActionRecord | undefined;
      if (parent?.state !== "running") this.deny(permit, "PARENT_NOT_RUNNING");
    }
    const once = ONCE_CAPABILITIES.has(permit.capability);
    this.requireGrant(permit, once);
    const action = this.action(permit, "approved");
    const receipts = [
      { kind: "action" as const, record: action },
      {
        kind: "action" as const,
        record: {
          ...action,
          recordId: randomUUID(),
          state: "running" as const,
        },
      },
    ];
    const fences = {
      expectedOwnershipEpoch: {
        workspaceId: permit.ownership.workspaceId,
        epoch: permit.ownership.epoch,
      },
      expectedActionReservation: {
        scopeId: permit.targetScopeId,
        idempotencyKey: permit.idempotencyKey,
        actionId: permit.actionId,
        recordId: proposal.recordId,
      },
    };
    try {
      if (once)
        this.store.consumeOnceGrant(
          this.grantUse(permit) as OnceGrantConsumption,
          receipts,
          this.caller,
          fences,
        );
      else this.store.commitEvents(receipts, [], this.caller, fences);
    } catch (error) {
      if (
        error instanceof StoreError &&
        error.code === "ACTION_RESERVATION_CHANGED"
      )
        throw new AdmissionError("ACTION_REQUIRES_RECONCILIATION");
      if (error instanceof StoreError && GRANT_DENIALS.has(error.code))
        this.deny(permit, error.code);
      throw error;
    }
    // No asynchronous callback separates the final fences from executor handoff.
    this.check(toolCallId, toolName, signal);
    let result: T;
    try {
      result = await invoke(admittedArgs);
    } catch {
      this.commitOutcome(action, true);
      throw new AdmissionError("EFFECT_UNCERTAIN");
    }
    this.commitOutcome(action, result.isError || signal?.aborted === true);
    return result;
  }

  /** Native-only use: workspace identity is observed fresh on every call. */
  private grantUse(permit: ActionPermit): GrantUse {
    const once = ONCE_CAPABILITIES.has(permit.capability);
    return {
      grantId: permit.grantId,
      workspaceId: permit.ownership.workspaceId,
      sessionId: this.caller.sessionId,
      capability: permit.capability,
      observedIdentity: this.identity.observe(permit.ownership.workspaceId),
      ...(once
        ? { actionId: permit.actionId, argumentsDigest: permit.argumentsDigest }
        : {}),
      ...(permit.origin === undefined ? {} : { origin: permit.origin }),
    };
  }

  private requireGrant(permit: ActionPermit, once: boolean): void {
    const use = this.grantUse(permit);
    try {
      if (once) this.store.checkOnceGrantForActive(use as OnceGrantConsumption);
      else this.store.requireGrant(use);
    } catch (error) {
      if (error instanceof StoreError && GRANT_DENIALS.has(error.code))
        this.deny(permit, error.code);
      throw error;
    }
  }

  private deny(permit: ActionPermit, code: string): never {
    this.prepared.add(permit.toolCallId);
    this.pending.delete(permit.toolCallId);
    this.ready.delete(permit.toolCallId);
    this.reservations.delete(permit.toolCallId);
    this.store.append(
      {
        kind: "action",
        record: this.action(
          permit,
          code === "CANCELED" ? "canceled" : "denied",
        ),
      },
      this.caller,
    );
    throw new AdmissionError(code);
  }

  private action(
    permit: ActionPermit,
    state: ActionRecord["state"],
  ): ActionRecord {
    const run = this.store.get(permit.runRecordId).record as RunRecord;
    return {
      schemaVersion: CONTRACT_VERSION,
      recordId: randomUUID(),
      createdAt: new Date().toISOString(),
      scopeId: permit.targetScopeId,
      sourceIds: [permit.runRecordId],
      actionId: permit.actionId,
      runId: run.runId,
      parentActionId: permit.parentActionId,
      capabilityId: permit.capabilityId,
      capabilityVersion: permit.capabilityVersion,
      argumentsArtifactId: permit.argumentsArtifactId,
      targetScopeId: permit.targetScopeId,
      idempotencyKey: permit.idempotencyKey,
      state,
      argumentsDigest: permit.argumentsDigest,
      policyRevision: this.caller.policyRevision,
      ownershipEpoch: permit.ownership.epoch,
    };
  }

  private commitOutcome(action: ActionRecord, uncertain: boolean): void {
    const record: RecordByKind["outcome"] = {
      schemaVersion: CONTRACT_VERSION,
      recordId: randomUUID(),
      createdAt: new Date().toISOString(),
      scopeId: action.scopeId,
      sourceIds: [action.recordId],
      actionId: action.actionId,
      effectState: uncertain ? "uncertain" : "observed-success",
      observedAt: new Date().toISOString(),
      resultArtifactId: null,
      cleanupState: uncertain ? "uncertain" : "not-required",
      errorClass: uncertain ? "execution" : "none",
    };
    this.store.appendBatch(
      [
        { kind: "outcome", record },
        {
          kind: "action",
          record: {
            ...action,
            recordId: randomUUID(),
            state: uncertain ? "uncertain" : "completed",
          },
        },
      ],
      this.caller,
    );
  }
}
