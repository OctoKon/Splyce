// TD-25: internal Store-side recovery. Native callers supply the existing target
// session and reference authority; this never dispatches or opens admission.
import {
  ACTION_STATES,
  CONTRACT_VERSION,
  ContractError,
  EFFECT_STATES,
  RUN_STATES,
  TRANSPORT_LIMITS,
  validateRecord,
  type RecordByKind,
} from "./contracts.js";
import {
  reconcile,
  type RecoveryReport,
  type WriterStatus,
} from "./recovery.js";
import type {
  AppendInput,
  CallerContext,
  Store,
  StoredRecord,
} from "./store.js";
import { StoreError } from "./store.js";

export class RecoveryApplyError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecoveryApplyError";
    this.code = code;
  }
}

export interface RecoveryApplyInput {
  readonly scopeId: string;
  /** Native recovery context for the persisted target session. Stored profile fields stay historical. */
  readonly caller: CallerContext;
  readonly explicitRestart: boolean;
  /** Native-observed writer status; this module cannot establish OS liveness. */
  readonly writers: readonly WriterStatus[];
}

export interface RecoveryApplyResult {
  /** Per-session only; native callers must union workspace sessions and enforce writer fences before takeover. */
  readonly report: RecoveryReport;
  /** Committed corrections only; these IDs do not authorize workspace takeover. */
  readonly applied: {
    readonly actionIds: readonly string[];
    readonly runIds: readonly string[];
  };
  readonly seqs: readonly number[];
}

const fail = (code: string, message: string): never => {
  throw new RecoveryApplyError(code, message);
};
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function snapshot(store: Store, scopeId: string, sessionId: string) {
  // The fence values are read inside the same before/after stamp window as
  // the journal list: the returned values are exactly the ones the second
  // stamp verified consistent with the records, so a write inside the read
  // window can never end up inside the fence. Workspace ownership ROW epochs
  // (not the store-global counter) are stamped with the cursors: an acquire
  // advances no cursor, so only the row epoch can catch it inside the window.
  const rowEpoch = (workspaceId: string): number => {
    const row = store.db
      .prepare("SELECT epoch FROM workspace_ownership WHERE workspace_id = ?")
      .get(workspaceId) as { epoch: number | bigint } | undefined;
    return row === undefined ? 0 : Number(row.epoch);
  };
  const stamp = (workspaceIds: readonly string[]) => {
    const values: [number, number, number, number, string] = [
      store.cursor(scopeId),
      store.sessionCursor(scopeId, sessionId),
      store.deletionEpoch(),
      store.ownershipEpoch(),
      store.configRevision(scopeId),
    ];
    const captured = {
      scopeCursor: values[0],
      sessionCursor: values[1],
      deletionEpoch: values[2],
      workspaceEpochs: new Map<string, number>(),
    };
    const parts = [JSON.stringify(values)];
    for (const workspaceId of [...workspaceIds].sort()) {
      const epoch = rowEpoch(workspaceId);
      captured.workspaceEpochs.set(workspaceId, epoch);
      parts.push(JSON.stringify([workspaceId, epoch]));
    }
    return { captured, identity: parts.join("|") };
  };
  const runWorkspaceIds = (records: readonly StoredRecord[]): Set<string> => {
    const ids = new Set<string>();
    for (const { kind, record } of records)
      if (kind === "run" && record.piSessionId === sessionId)
        ids.add(String(record.workspaceId));
    return ids;
  };
  // A preliminary scoped-run list seeds the workspace set; both stamps carry
  // their id lists, so a set change inside the window changes the identity.
  const preliminary = store.list(scopeId, 0, sessionId);
  let { captured: fence, identity } = stamp([
    ...runWorkspaceIds(preliminary.records),
  ]);
  const scope = store.list(scopeId);
  const target = store.list(scopeId, 0, sessionId);
  const verifiedIds = runWorkspaceIds(target.records);
  const second = stamp([...verifiedIds]);
  fence = second.captured;
  if (second.identity !== identity)
    fail("RECOVERY_STALE_SNAPSHOT", "Journal changed during recovery read");
  if (scope.skippedUnknownSchema || target.skippedUnknownSchema)
    fail("RECOVERY_UNKNOWN_SCHEMA", "Recovery cannot skip unknown records");
  const attributed = new Set(
    target.records.map(({ record }) => record.recordId),
  );
  if (
    scope.records.some(
      ({ kind, record }) =>
        kind === "run" &&
        record.piSessionId === sessionId &&
        !attributed.has(record.recordId),
    )
  )
    fail(
      "RECOVERY_SCOPE",
      "Target run has inconsistent journal session attribution",
    );
  return {
    records: target.records,
    fence,
  };
}

function journal(
  records: readonly StoredRecord[],
  scopeId: string,
  sessionId: string,
) {
  const runs = new Map<string, RecordByKind["run"]>();
  const actions = new Map<string, RecordByKind["action"]>();
  const outcomes = new Map<string, RecordByKind["outcome"]>();
  for (const { kind, record } of records) {
    if (kind !== "run" && kind !== "action" && kind !== "outcome") continue;
    if (
      record.schemaVersion !== CONTRACT_VERSION ||
      record.scopeId !== scopeId ||
      !id(record.recordId) ||
      !Array.isArray(record.sourceIds) ||
      !record.sourceIds.every(id)
    )
      fail("RECOVERY_INVALID_JOURNAL", "Invalid recovery source metadata");
    if (kind === "run") {
      const run = record as RecordByKind["run"];
      if (
        !id(run.runId) ||
        run.piSessionId !== sessionId ||
        !RUN_STATES.includes(run.state)
      )
        fail(
          "RECOVERY_INVALID_JOURNAL",
          "Run is not bound to the target session",
        );
      runs.set(run.runId, run);
    } else if (kind === "action") {
      const action = record as RecordByKind["action"];
      if (
        !id(action.actionId) ||
        !id(action.runId) ||
        !ACTION_STATES.includes(action.state)
      )
        fail("RECOVERY_INVALID_JOURNAL", "Invalid action recovery state");
      actions.set(action.actionId, action);
    } else {
      const outcome = record as RecordByKind["outcome"];
      if (!id(outcome.actionId) || !EFFECT_STATES.includes(outcome.effectState))
        fail("RECOVERY_INVALID_JOURNAL", "Invalid observed outcome");
      outcomes.set(outcome.actionId, outcome);
    }
  }
  for (const action of actions.values())
    if (!runs.has(action.runId))
      fail("RECOVERY_INVALID_JOURNAL", "Action has no target-session run");
  for (const outcome of outcomes.values())
    if (!actions.has(outcome.actionId))
      fail("RECOVERY_INVALID_JOURNAL", "Outcome has no target-session action");
  return { runs, actions, outcomes };
}

/**
 * Append correction versions atomically. Reference callbacks run before the
 * write transaction; only a captured pure lookup reaches Store.appendBatch.
 * The commit is fenced by Store preconditions (scope/session record cursors,
 * deletion epoch, ownership epoch, config revision) checked under the same
 * BEGIN IMMEDIATE as the inserts, so a journal that changed between the
 * snapshot and the commit appends nothing. All record writes and validation
 * stay in Store; the applier performs no transaction control of its own.
 * A deleted source fails recovery closed in every phase.
 */
export function applyRecovery(
  store: Store,
  input: RecoveryApplyInput,
): RecoveryApplyResult {
  const scopeId = input.scopeId;
  const caller: CallerContext = {
    sessionId: input.caller.sessionId,
    configRevision: input.caller.configRevision,
    profileRevision: input.caller.profileRevision,
    policyRevision: input.caller.policyRevision,
  };
  const authorize = input.caller.resolveReference;
  if (input.explicitRestart !== true)
    fail(
      "RECOVERY_RESTART_REQUIRED",
      "Recovery requires an explicit engine Restart",
    );
  if (!id(scopeId) || !id(caller.sessionId))
    fail(
      "RECOVERY_SCOPE",
      "Recovery requires a native target scope and session",
    );
  const handle = store.db;
  if (handle.isTransaction)
    fail(
      "RECOVERY_TRANSACTION_ACTIVE",
      "Recovery cannot own an existing transaction",
    );
  store.appendBatch([], caller); // Also rejects closed/read-only stores with no corrections.
  if (store.configRevision(scopeId) !== caller.configRevision)
    fail("RECOVERY_SCOPE", "Recovery configuration revision is stale");
  const writers = input.writers.map(({ lease, alive }): WriterStatus => {
    if (
      lease.piSessionId !== caller.sessionId ||
      !id(lease.writerId) ||
      !id(lease.leaseEpoch) ||
      (alive !== true && alive !== false && alive !== "unknown")
    )
      fail(
        "RECOVERY_SCOPE",
        "Writer witness is not bound to the target session",
      );
    return {
      lease: {
        piSessionId: lease.piSessionId,
        writerId: lease.writerId,
        leaseEpoch: lease.leaseEpoch,
      },
      alive,
    };
  });
  // A correction may only be acknowledged when every observed writer witness
  // proves the writer is gone: an alive or unknown witness (or no witness at
  // all) means the journal may still be written concurrently.
  if (writers.length === 0 || writers.some((writer) => writer.alive !== false))
    fail(
      "RECOVERY_WRITER_ALIVE",
      "Recovery requires every writer witness to be proven not alive",
    );
  const tombstoned = (recordId: string): boolean =>
    handle
      .prepare("SELECT 1 FROM deletions WHERE record_id = ?")
      .get(recordId) !== undefined;
  const initial = snapshot(store, scopeId, caller.sessionId);
  const current = journal(initial.records, scopeId, caller.sessionId);
  // A tombstoned journal record is never a recovery source (P1-1): recovery
  // would resurrect deleted history through its correction lineage.
  for (const record of [
    ...current.runs.values(),
    ...current.actions.values(),
    ...current.outcomes.values(),
  ])
    if (tombstoned(record.recordId))
      fail(
        "RECOVERY_DELETED_SOURCE",
        `Recovery journal source ${JSON.stringify(record.recordId)} is deleted; nothing is corrected`,
      );
  // The ownership fence compares the TARGET workspace's own row epoch (the
  // same row commitBatch reads under the lock), never the store-global
  // ownership counter: another workspace's acquire must not block this
  // recovery, and an unacquired target must not read a foreign epoch. The
  // row epoch was captured inside the snapshot stamp window, so a takeover
  // during the snapshot itself already failed the stamp.
  const workspaceIds = new Set(
    [...current.runs.values()].map((run) => run.workspaceId),
  );
  if (workspaceIds.size > 1)
    fail(
      "RECOVERY_SCOPE",
      "Target session runs attribute inconsistent workspace ids",
    );
  const workspaceId = [...workspaceIds][0];
  const ownershipEpoch =
    workspaceId === undefined
      ? undefined
      : initial.fence.workspaceEpochs.get(workspaceId);
  if (workspaceId !== undefined && ownershipEpoch === undefined)
    fail(
      "RECOVERY_STALE_SNAPSHOT",
      "Target workspace was not part of the verified snapshot",
    );
  const report = reconcile({
    runs: [...current.runs.values()],
    actions: [...current.actions.values()],
    outcomes: [...current.outcomes.values()],
    writers,
    explicitRestart: true,
  });
  const writes: AppendInput[] = [];
  const createdAt = new Date().toISOString();
  const correction = (
    source: RecordByKind["run"] | RecordByKind["action"],
    state: string,
    proof: readonly string[],
  ) => ({
    ...source,
    recordId: `recovery:${globalThis.crypto.randomUUID()}`,
    createdAt,
    sourceIds: [...new Set([...source.sourceIds, source.recordId, ...proof])],
    state,
  });
  for (const change of report.actionCorrections) {
    const action = current.actions.get(change.actionId)!;
    const observed = current.outcomes.get(action.actionId);
    writes.push({
      kind: "action",
      record: correction(
        action,
        change.to,
        observed ? [observed.recordId] : [],
      ),
    });
  }
  for (const change of report.runCorrections) {
    const run = current.runs.get(change.runId)!;
    const proof = [...current.actions.values()]
      .filter((action) => action.runId === run.runId)
      .map((action) => action.recordId);
    writes.push({ kind: "run", record: correction(run, change.to, proof) });
  }

  const authorized = new Set<string>();
  let deletedReference: string | null = null;
  for (const write of writes) {
    // The native schema includes body references as well as sourceIds.
    try {
      validateRecord(write.kind, write.record, {
        ...caller,
        scopeId,
        lastDurableSeq: store.cursor(),
        maxInlineBytes: TRANSPORT_LIMITS.maxInlineBytes,
        resolveReference: (ref, scope) => {
          if (scope !== scopeId) return false;
          // A deleted record is never a valid recovery reference, even when
          // the native authority would still resolve it. Record the denial
          // out-of-band: the contract validator folds any resolver throw into
          // a generic UNRESOLVED_REFERENCE.
          if (tombstoned(ref)) {
            if (deletedReference === null) deletedReference = ref;
            return false;
          }
          if (!authorized.has(ref) && authorize?.(ref, scope) !== true)
            return false;
          authorized.add(ref);
          return true;
        },
      });
    } catch (error) {
      if (deletedReference !== null)
        throw new RecoveryApplyError(
          "RECOVERY_DELETED_SOURCE",
          `Recovery reference ${JSON.stringify(deletedReference)} is deleted; nothing is corrected`,
          { cause: error },
        );
      if (
        error instanceof ContractError &&
        error.code === "UNRESOLVED_REFERENCE"
      )
        throw new RecoveryApplyError(
          "RECOVERY_REFERENCE_DENIED",
          "Native reference authority denied recovery",
          { cause: error },
        );
      throw error;
    }
  }
  if (handle.isTransaction)
    fail(
      "RECOVERY_TRANSACTION_ACTIVE",
      "Reference authorization left a transaction active",
    );
  const writeCaller: CallerContext = {
    ...caller,
    resolveReference: (ref, scope) => scope === scopeId && authorized.has(ref),
  };
  let seqs: number[] = [];
  try {
    const result = store.appendBatch(
      writes,
      writeCaller,
      undefined,
      ownershipEpoch === undefined
        ? undefined
        : { workspaceId: workspaceId!, epoch: ownershipEpoch },
      { scopeId, revision: caller.configRevision },
      undefined,
      {
        expectedScopeCursor: { scopeId, seq: initial.fence.scopeCursor },
        expectedSessionCursor: {
          scopeId,
          sessionId: caller.sessionId,
          seq: initial.fence.sessionCursor,
        },
        expectedDeletionEpoch: initial.fence.deletionEpoch,
      },
    );
    seqs = result.seqs;
  } catch (error) {
    if (error instanceof StoreError) {
      if (error.code === "STORE_ROLLBACK_FAILED") {
        // The store cannot guarantee durability state after a failed
        // rollback: discard it and report both causes.
        try {
          store.close();
        } catch {
          /* A close failure never hides the rollback failure. */
        }
        throw new RecoveryApplyError(
          "RECOVERY_ROLLBACK_FAILED",
          "Recovery rollback failed; discard this Store",
          { cause: error },
        );
      }
      if (
        error.code === "SCOPE_CURSOR_STALE" ||
        error.code === "SESSION_CURSOR_STALE"
      )
        fail(
          "RECOVERY_STALE_SNAPSHOT",
          "Journal changed before correction commit",
        );
      if (error.code === "STALE_DELETION_EPOCH")
        fail(
          "RECOVERY_DELETED_SOURCE",
          "A record was deleted between the recovery snapshot and its commit",
        );
      if (error.code === "OWNERSHIP_STALE_EPOCH")
        fail(
          "RECOVERY_STALE_SNAPSHOT",
          "Workspace ownership changed before correction commit",
        );
      if (error.code === "CONFIG_STALE_REVISION")
        fail(
          "RECOVERY_SCOPE",
          "Recovery configuration revision changed before commit",
        );
    }
    throw error;
  }
  return {
    report,
    applied: {
      actionIds: report.actionCorrections.map((change) => change.actionId),
      runIds: report.runCorrections.map((change) => change.runId),
    },
    seqs,
  };
}
