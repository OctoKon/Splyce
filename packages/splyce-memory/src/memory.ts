// TD-39/TD-40: optional memory module. Capture turns committed durable events
// into cited memoryObservation receipts in the authoritative Store; recall is
// hybrid (BM25 + optional dense + entity-graph PPR, fused by RRF) over a
// projection in a module-owned SQLite file. The projection is rebuildable and
// never outlives a tombstoned source in any index. Nothing here runs at
// import time: the engine pays nothing unless it calls Memory.open.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SplyceEvent } from "@splyce/pi/contracts";
import type { AppendInput, CallerContext, Store } from "@splyce/pi/store";
import {
  type EmbeddingPort,
  type FusedHit,
  LIMITS,
  type Redactor,
  RetrievalIndex,
  redactSecrets,
} from "@splyce/retrieval";

export const EXTRACTION_REVISION = "extractive-v1";
export const EXTRACTION_ROLE_ID = "memory.extractive";
/** Store session attribution for memory receipts; keeps user session replays clean. */
export const MEMORY_WRITER_SESSION = "splyce-memory";

/** One proposed observation; `sourceIds` are event record ids (`event:<eventId>`). */
export interface ObservationDraft {
  text: string;
  sourceIds: string[];
}
/**
 * Summarizer seam: receives the full committed session replay and the capture
 * cursor, returns drafts for events after it. The default is extractive; a
 * model summarizer plugs in here and is held to the same citation checks.
 */
export type Extractor = (
  events: readonly SplyceEvent[],
  afterSeq: number,
) => ObservationDraft[];

export interface Observation {
  observationId: string;
  claimArtifactId: string;
  scopeId: string;
  sessionId: string;
  text: string;
  sourceIds: string[];
  createdAt: string;
}
export interface RecallHit extends Observation {
  /** Fused RRF score plus each contributing signal's rank and raw score. */
  score: number;
  signals: FusedHit["signals"];
}
export interface MemoryOptions {
  extract?: Extractor;
  /** Dense recall is off unless the host binds an `embed` role port. */
  embedding?: EmbeddingPort;
  /** Extra redaction (e.g. the TD-16 resolver's live-secret redactor), applied after the built-in patterns. */
  redact?: Redactor;
}

export class MemoryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const eventRecordId = (event: SplyceEvent): string => `event:${event.eventId}`;
const storeCode = (error: unknown): string | undefined => {
  const code: unknown =
    error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
};

/**
 * Default v1 extractor over the durable event kinds: tool outcomes (joined to
 * their intent's capability, target and argument summary), run failures and
 * approval requests. Stream deltas are transient by contract, so assistant and
 * user text are not in the ledger and cannot be captured here.
 */
export const extractive: Extractor = (events, afterSeq) => {
  const intents = new Map<string, SplyceEvent>();
  const drafts: ObservationDraft[] = [];
  const emit = (event: SplyceEvent, text: string, cited: SplyceEvent[]) => {
    if (event.seq > afterSeq)
      drafts.push({ text, sourceIds: cited.map(eventRecordId) });
  };
  for (const event of events) {
    switch (event.kind) {
      case "turn.tool_intent":
        if (event.payload) intents.set(event.payload.actionId, event);
        break;
      case "turn.tool_outcome": {
        const p = event.payload;
        if (!p) break;
        const intent = intents.get(p.actionId);
        const ip =
          intent?.kind === "turn.tool_intent" ? intent.payload : undefined;
        const head = ip
          ? `Tool ${ip.capabilityId} on ${ip.target} (${ip.argsSummary})`
          : `Tool action ${p.actionId}`;
        emit(
          event,
          `${head} -> ${p.status}${p.error ? `: ${p.error}` : ""}`,
          intent ? [intent, event] : [event],
        );
        break;
      }
      case "turn.failed":
        if (event.payload)
          emit(
            event,
            `Run ${event.payload.runId} failed: ${event.payload.error.code} ${event.payload.error.message}`,
            [event],
          );
        break;
      case "approval.requested":
        if (event.payload)
          emit(
            event,
            `Approval requested: ${event.payload.capabilityId} on ${event.payload.normalizedTarget}: ${event.payload.riskRationale}`,
            [event],
          );
        break;
      default:
        break;
    }
  }
  return drafts;
};

interface Row {
  observation_id: string;
  claim_artifact_id: string;
  scope_id: string;
  session_id: string;
  text: string;
  source_ids: string;
  created_at: string;
}
const toObservation = (row: Row): Observation => ({
  observationId: row.observation_id,
  claimArtifactId: row.claim_artifact_id,
  scopeId: row.scope_id,
  sessionId: row.session_id,
  text: row.text,
  sourceIds: JSON.parse(row.source_ids) as string[],
  createdAt: row.created_at,
});

export class Memory {
  private constructor(
    private readonly store: Store,
    private readonly db: DatabaseSync,
    private readonly extract: Extractor,
    private readonly index: RetrievalIndex,
    private readonly redact: Redactor,
  ) {}

  /** Opens (creating if needed) the projection file and reapplies any store deletions it missed. */
  static open(store: Store, path: string, options: MemoryOptions = {}): Memory {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    // Purged rows are overwritten on disk, not left in free pages.
    db.exec("PRAGMA secure_delete = ON;");
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS cursors (scope_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (scope_id, session_id));" +
        "CREATE TABLE IF NOT EXISTS observations (observation_id TEXT PRIMARY KEY, claim_artifact_id TEXT NOT NULL, scope_id TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL, source_ids TEXT NOT NULL, created_at TEXT NOT NULL);",
    );
    const index = new RetrievalIndex(
      db,
      options.embedding === undefined ? {} : { embedding: options.embedding },
    );
    const extra = options.redact;
    const memory = new Memory(
      store,
      db,
      options.extract ?? extractive,
      index,
      (text) =>
        extra === undefined ? redactSecrets(text) : extra(redactSecrets(text)),
    );
    memory.syncDeletions();
    return memory;
  }

  close(): void {
    this.db.close();
  }

  /** Highest session event seq already captured (0 = nothing yet). */
  cursor(scopeId: string, sessionId: string): number {
    const row = this.db
      .prepare("SELECT seq FROM cursors WHERE scope_id = ? AND session_id = ?")
      .get(scopeId, sessionId) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  private sourceIsDead(id: string): boolean {
    if (
      this.store.db
        .prepare("SELECT 1 FROM deletions WHERE record_id = ?")
        .get(id) !== undefined
    )
      return true;
    try {
      this.store.get(id);
      return false;
    } catch (error) {
      const code = storeCode(error);
      if (code === "EVENT_DELETED" || code === "STORE_NOT_FOUND") return true;
      throw error;
    }
  }

  /**
   * Purges every observation citing a tombstoned source and tombstones its
   * derived receipts in the store. Runs whenever the store deletion epoch
   * moved past the one this projection last applied, so a restored (older)
   * projection file is re-purged before it can serve anything.
   */
  syncDeletions(): number {
    const applied = this.db
      .prepare("SELECT value FROM meta WHERE key = 'deletion_epoch'")
      .get() as { value: string } | undefined;
    if (
      applied !== undefined &&
      Number(applied.value) === this.store.deletionEpoch()
    )
      return 0;
    // ponytail: full rescan per epoch change; a source->observation link table when scopes grow large.
    const rows = this.db.prepare("SELECT * FROM observations").all() as Row[];
    let purged = 0;
    for (const row of rows) {
      const observation = toObservation(row);
      if (
        ![
          observation.observationId,
          observation.claimArtifactId,
          ...observation.sourceIds,
        ].some((id) => this.sourceIsDead(id))
      )
        continue;
      // Authoritative tombstones first: a crash before the local delete just repeats this purge.
      this.store.noteDeletion(observation.observationId);
      this.store.noteDeletion(observation.claimArtifactId);
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.index.remove([row.observation_id]);
        this.db
          .prepare("DELETE FROM observations WHERE observation_id = ?")
          .run(row.observation_id);
        this.db.exec("COMMIT;");
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
        throw error;
      }
      purged += 1;
    }
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('deletion_epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(this.store.deletionEpoch()));
    return purged;
  }

  /**
   * Committed durable events of a session. `replayEvents` fails closed when any
   * of them is tombstoned; then this reads only the events committed after the
   * last tombstoned row (found by bisecting `list`'s store-seq cursor), so a
   * deletion never stalls capture and deleted evidence is never read.
   */
  private replay(scopeId: string, sessionId: string): SplyceEvent[] {
    try {
      return this.store.replayEvents(scopeId, sessionId);
    } catch (error) {
      if (storeCode(error) !== "EVENT_DELETED") throw error;
    }
    const read = (afterSeq: number): SplyceEvent[] =>
      this.store
        .list(scopeId, afterSeq, sessionId)
        .records.flatMap((entry) =>
          entry.kind === "event"
            ? [(entry.record as { envelope: SplyceEvent }).envelope]
            : [],
        );
    // ponytail: events committed before the last tombstoned row and not yet captured are skipped; a Store replay that skips tombstones removes that gap.
    let low = 0;
    let high = this.store.cursor(scopeId);
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      try {
        read(mid);
        high = mid;
      } catch (error) {
        if (storeCode(error) !== "EVENT_DELETED") throw error;
        low = mid + 1;
      }
    }
    return read(low);
  }

  /**
   * Captures committed durable events of one session after the persisted
   * cursor. Idempotent: ids are derived from (scope, session, revision,
   * sources), the store commit is guarded by the deletion epoch read before
   * extraction, and the projection plus cursor commit in one transaction.
   */
  capture(scopeId: string, sessionId: string): Observation[] {
    this.syncDeletions();
    const epoch = this.store.deletionEpoch();
    // ponytail: full-session replay per capture (needed for intent context); incremental state when sessions get long.
    const events = this.replay(scopeId, sessionId);
    const after = this.cursor(scopeId, sessionId);
    const bySource = new Map(
      events.map((event) => [eventRecordId(event), event]),
    );
    const prepared = this.extract(events, after).map((draft) => {
      const text = this.redact(draft.text).slice(0, LIMITS.docChars).trim();
      if (!text)
        throw new MemoryError("EMPTY_OBSERVATION", "observation text is empty");
      const sourceIds = [...new Set(draft.sourceIds)].sort();
      if (sourceIds.length === 0)
        throw new MemoryError(
          "UNCITED_OBSERVATION",
          "observation cites no source",
        );
      const cited = sourceIds.map((id) => {
        const event = bySource.get(id);
        if (event === undefined)
          throw new MemoryError(
            "UNCITED_OBSERVATION",
            `source ${id} is not committed evidence of this session`,
          );
        return event;
      });
      const latest = cited.reduce((a, b) => (b.seq > a.seq ? b : a));
      const anchor = events
        .filter((e) => e.kind === "session.tree_updated" && e.seq <= latest.seq)
        .at(-1);
      const hash = sha256(
        JSON.stringify([scopeId, sessionId, EXTRACTION_REVISION, sourceIds]),
      ).slice(0, 32);
      return {
        observation: {
          observationId: `memobs:${hash}`,
          claimArtifactId: `memclaim:${hash}`,
          scopeId,
          sessionId,
          text,
          sourceIds,
          createdAt: latest.createdAt,
        } satisfies Observation,
        branchAnchorId:
          anchor?.kind === "session.tree_updated" && anchor.payload
            ? anchor.payload.branchAnchorId
            : `session:${sessionId}`,
      };
    });

    const fresh = prepared.filter(({ observation }) => {
      try {
        this.store.get(observation.observationId);
        return false; // committed before a crash: project it, never duplicate it
      } catch (error) {
        if (storeCode(error) === "STORE_NOT_FOUND") return true;
        throw error;
      }
    });
    if (fresh.length > 0) {
      const known = new Set<string>([EXTRACTION_ROLE_ID]);
      const inputs: AppendInput[] = [];
      for (const { observation: o, branchAnchorId } of fresh) {
        o.sourceIds.forEach((id) => known.add(id));
        known.add(o.claimArtifactId).add(branchAnchorId);
        const meta = {
          schemaVersion: 1,
          createdAt: o.createdAt,
          scopeId,
          sourceIds: o.sourceIds,
        };
        inputs.push(
          {
            kind: "artifact",
            record: {
              ...meta,
              recordId: o.claimArtifactId,
              artifactId: o.claimArtifactId,
              digest: `sha256:${sha256(o.text)}`,
              mediaType: "text/plain",
              byteLength: new TextEncoder().encode(o.text).length,
              retentionClass: "session",
            },
          },
          {
            kind: "memoryObservation",
            record: {
              ...meta,
              recordId: o.observationId,
              observationId: o.observationId,
              claimArtifactId: o.claimArtifactId,
              branchAnchorId,
              extractionRoleId: EXTRACTION_ROLE_ID,
              extractionRevision: EXTRACTION_REVISION,
              validFrom: o.createdAt,
              supersedesIds: [],
            },
          },
        );
      }
      const caller: CallerContext = {
        sessionId: MEMORY_WRITER_SESSION,
        configRevision: this.store.configRevision(scopeId),
        profileRevision: "memory",
        policyRevision: "memory",
        resolveReference: (id, refScope) =>
          refScope === scopeId && known.has(id),
      };
      // A deletion landing after extraction rejects the whole batch (late summary).
      this.store.commitEvents(inputs, [], caller, {
        expectedDeletionEpoch: epoch,
      });
    }

    const top = events.reduce((max, event) => Math.max(max, event.seq), after);
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const { observation: o } of prepared) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO observations (observation_id, claim_artifact_id, scope_id, session_id, text, source_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            o.observationId,
            o.claimArtifactId,
            scopeId,
            sessionId,
            o.text,
            JSON.stringify(o.sourceIds),
            o.createdAt,
          );
      }
      this.index.add(
        prepared.map(({ observation: o }) => ({
          id: o.observationId,
          scopeId,
          text: o.text,
        })),
      );
      this.db
        .prepare(
          "INSERT INTO cursors (scope_id, session_id, seq) VALUES (?, ?, ?) ON CONFLICT(scope_id, session_id) DO UPDATE SET seq = excluded.seq",
        )
        .run(scopeId, sessionId, top);
      this.db.exec("COMMIT;");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK;");
      throw error;
    }
    return prepared.map(({ observation }) => observation);
  }

  /** Bounded metadata feed from the same deletion-aware projection as recall. */
  list(scopeId: string, limit = 101): Observation[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101)
      throw new MemoryError("MEMORY_INPUT", "Invalid memory list limit");
    this.syncDeletions();
    return (
      this.db
        .prepare(
          "SELECT * FROM observations WHERE scope_id = ? ORDER BY created_at DESC, observation_id ASC LIMIT ?",
        )
        .all(scopeId, limit) as Row[]
    ).map(toObservation);
  }

  /** Hybrid recall within one scope; every hit carries its cited source event ids and per-signal scores. */
  async query(
    scopeId: string,
    text: string,
    limit = 10,
    signal?: AbortSignal,
  ): Promise<RecallHit[]> {
    this.syncDeletions();
    const hits = await this.index.query(scopeId, text, limit, signal);
    // Re-check after the await: a purge that landed meanwhile wins over the hit.
    this.syncDeletions();
    return hits.flatMap((hit) => {
      const row = this.db
        .prepare(
          "SELECT * FROM observations WHERE observation_id = ? AND scope_id = ?",
        )
        .get(hit.id, scopeId) as Row | undefined;
      return row === undefined
        ? []
        : [{ ...toObservation(row), score: hit.score, signals: hit.signals }];
    });
  }
}
