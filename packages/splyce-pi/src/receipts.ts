// TD-15 (issue #37): acknowledged receipt ordering on the TD-09 store plus the
// durable-cursor replay/resync surface of the TD-01 event envelope.
// Frozen-contract types only; additive shared definitions (TRANSPORT_LIMITS,
// payload.read) bind here after the coordinated TD-01 serial patch.

import {
  type ContractContext,
  type RecordKind,
  type RecordByKind,
  TRANSPORT_LIMITS,
  validateCursor,
} from "./contracts.js";
import {
  Store,
  type AppendInput,
  type AppendBatchResult,
  type CallerContext,
  type ListResult,
} from "./store.js";
export class ReceiptsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReceiptsError";
    this.code = code;
  }
}

/** A resync event as defined by the frozen TD-01 envelope. */
export interface ResyncEvent {
  kind: "stream.resync";
  fromSeq: number;
}

export class Receipts {
  private readonly store: Store;
  /** Durable cursor at the moment of the last accepted resync (per scope+session). */
  private readonly lastResyncCursor = new Map<string, number>();

  constructor(store: Store) {
    this.store = store;
  }

  /**
   * Durable cursor: every committed record has seq <= this value; a commit
   * that returns success has reached durable state.
   */
  durableCursor(scopeId?: string): number {
    return this.store.cursor(scopeId);
  }

  /**
   * Durable cursor for ONE session: the highest committed seq attributed to
   * that session in the scope. Other sessions' (or scopes') records never
   * advance it, so replay cursors and resync bases stay session-exact.
   */
  sessionDurableCursor(scopeId: string, sessionId: string): number {
    return this.store.sessionCursor(scopeId, sessionId);
  }

  /**
   * Ordered, atomic receipt commits (decision -> intent -> outcome in array
   * order). The caller must dispatch a native effect only after this returns
   * an acknowledgement; any failure rolls the whole chain back and acknowledges
   * nothing, so a failed pre-effect write prevents dispatch.
   */
  commitStages(
    stages: readonly AppendInput[],
    caller: CallerContext,
  ): AppendBatchResult {
    return this.store.appendBatch(stages, caller);
  }

  /**
   * Replay after a cursor, exclusive: `afterSeq = c` delivers records with
   * `seq > c`, identical to `subscribe afterSeq` semantics. A cursor beyond
   * the durable cursor is rejected (`INVALID_CURSOR`).
   */
  replay(scopeId: string, afterSeq: number, caller: CallerContext): ListResult {
    const context: ContractContext = {
      scopeId,
      sessionId: caller.sessionId,
      configRevision: caller.configRevision,
      profileRevision: caller.profileRevision,
      policyRevision: caller.policyRevision,
      // Session-exact cursor bound: another session's records never advance
      // or gate this session's replay cursor.
      lastDurableSeq: this.store.sessionCursor(scopeId, caller.sessionId),
      maxInlineBytes: TRANSPORT_LIMITS.maxInlineBytes,
      resolveReference: caller.resolveReference ?? (() => false),
    };
    let cursor: number;
    try {
      cursor = validateCursor(afterSeq, context);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "INVALID_CURSOR";
      throw new ReceiptsError(
        `CONTRACT_${code}`,
        error instanceof Error ? error.message : String(error),
      );
    }
    // Session-scoped replay: one session's replay never returns another
    // session's records in the same scope.
    return this.store.list(scopeId, cursor, caller.sessionId);
  }

  /**
   * Exactly one resync per cursor advance, scoped to the session: returns
   * `stream.resync {fromSeq = session durable cursor}` and refuses a second
   * resync while no new durable data attributable to that session has
   * arrived since the last one.
   */
  requestResync(scopeId: string, sessionId: string): ResyncEvent {
    const cursor = this.store.sessionCursor(scopeId, sessionId);
    const key = JSON.stringify([scopeId, sessionId]);
    const last = this.lastResyncCursor.get(key);
    if (last !== undefined && cursor <= last)
      throw new ReceiptsError(
        "RESYNC_NOT_PENDING",
        `no durable progress since the resync at cursor ${String(last)}`,
      );
    this.lastResyncCursor.set(key, cursor);
    return { kind: "stream.resync", fromSeq: cursor };
  }

  /** A record acknowledged by a prior commit, read back by id. */
  ack(recordId: string): { seq: number; record: RecordByKind[RecordKind] } {
    const got = this.store.get(recordId);
    return { seq: got.seq, record: got.record };
  }
}

export { Store };
