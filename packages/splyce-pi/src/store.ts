// TD-09: physical authoritative store (J0). Built-in `node:sqlite` adapter per
// the TD-03 store-qualification selection (fallback: better-sqlite3 13.0.3,
// never both). Single authority for operational receipts; everything else is a
// rebuildable projection. Erasable-syntax-only (runs under Node type stripping).

import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  RECORD_SCHEMAS,
  ContractError,
  type ContractContext,
  type RecordKind,
  type RecordByKind,
  type SplyceEvent,
  type SplyceEventDraft,
  validateEvent,
  validateRecord,
  snapshotPersistedJson,
  type AdmittedWorkspaceRecord,
  type ActionRecord,
  type GrantRecord,
  type ProviderEndpointRecord,
} from "./contracts.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const LAYOUT_VERSION = 2 as const;

/** Effective configuration revision of a scope before any transition applied. */
export const INITIAL_CONFIG_REVISION = "cfg-0";

const RECORD_COLUMNS = [
  "seq",
  "kind",
  "record_id",
  "schema_version",
  "scope_id",
  "session_id",
  "created_at",
  "payload",
] as const;

const DELETION_COLUMNS = ["record_id", "generation", "deleted_at"] as const;

const OWNERSHIP_COLUMNS = [
  "workspace_id",
  "owner_session_id",
  "epoch",
  "acquired_at",
  "renewed_at",
] as const;

export class StoreError extends Error {
  readonly code: string;
  readonly errcode: number | undefined;

  constructor(code: string, message: string, errcode?: number) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.errcode = errcode;
  }
}

export interface StoreOptions {
  /** SQLite busy timeout in ms. Default 5000 — `node:sqlite` defaults to 0. */
  busyTimeoutMs?: number;
  /** Contract context `maxInlineBytes` used while validating appended records. */
  maxInlineBytes?: number;
  /** Open the underlying database read-only (S3). */
  readOnly?: boolean;
}

export interface CallerContext {
  sessionId: string;
  configRevision: string;
  profileRevision: string;
  policyRevision: string;
  resolveReference?: (id: string, scopeId: string) => boolean;
}

export interface AppendInput {
  kind: RecordKind;
  record: unknown;
}

export interface Appended {
  seq: number;
  recordId: string;
}

export interface EntityRevisionExpectation {
  kind: "providerConnection" | "profileSnapshot" | "providerEndpoint";
  scopeId: string;
  entityId: string;
  expectedRevision: string | null;
}

export interface StoredRecord {
  seq: number;
  kind: RecordKind;
  record: RecordByKind[RecordKind];
}

export interface ListResult {
  records: StoredRecord[];
  /** Rows with an unknown (future) `schemaVersion` — rejected, not read (S5). */
  skippedUnknownSchema: number;
}

export interface AppendBatchResult {
  /** Acknowledged seqs, one per input, in input order. */
  seqs: number[];
}

export interface EventPreconditions {
  expectedDeletionEpoch?: number;
  expectedAbsentActionKey?: {
    scopeId: string;
    idempotencyKey: string;
    actionId: string;
  };
  expectedOwnershipEpoch?: { workspaceId: string; epoch: number };
  expectedConfigRevision?: { scopeId: string; revision: string };
  expectedActionReservation?: {
    scopeId: string;
    actionId: string;
    idempotencyKey: string;
    recordId: string;
  };
}
interface EventWatermark {
  scopeId: string;
  sessionId: string;
  seq: number;
}
const EVENT_SEQUENCE_PREFIX = "event_seq:";

function eventSequenceKey(scopeId: string, sessionId: string): string {
  if (
    [scopeId, sessionId].some(
      (id) => typeof id !== "string" || id.length === 0 || /\s|[\\/]/u.test(id),
    )
  )
    throw new StoreError(
      "EVENT_SCOPE",
      "event scope and session must be opaque ids",
    );
  return EVENT_SEQUENCE_PREFIX + JSON.stringify([scopeId, sessionId]);
}

/** Durable canonical-workspace ownership: single writer per workspace. */
export interface WorkspaceOwnership {
  workspaceId: string;
  ownerSessionId: string;
  epoch: number;
}

/** TD-13 native directory identity (volume serial + file id, native-supplied). */
export interface DirectoryIdentity {
  volumeSerial: string;
  fileId: string;
}

export interface WorkspaceAdmissionInput extends DirectoryIdentity {
  /** Final absolute drive path from the native resolver; never renderer-visible. */
  canonicalPath: string;
}

/** Engine/native-only view: carries the canonical path. */
export type AdmittedWorkspace = AdmittedWorkspaceRecord & {
  canonicalPath: string;
};

/** Renderer-safe workspace projection: no path, no directory identity. */
export interface WorkspaceView {
  workspaceId: string;
  displayName: string;
  admittedAt: string;
  revision: string;
}

export function workspaceView(
  workspace: AdmittedWorkspaceRecord,
): WorkspaceView {
  return {
    workspaceId: workspace.workspaceId,
    displayName: workspace.displayName,
    admittedAt: workspace.admittedAt,
    revision: workspace.revision,
  };
}

/** Native identity encoding: canonical unsigned decimal (no sign, space or leading zero) within `max`. */
function canonicalUnsigned(value: unknown, max: bigint): boolean {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]*)$/u.test(value) &&
    BigInt(value) <= max
  );
}

export interface GrantInput {
  workspaceId: string;
  sessionId: string;
  capability: GrantRecord["capability"];
  scope: GrantRecord["scope"];
  actionId?: string;
  argumentsDigest?: string;
  origin?: string;
}

/** What a dispatch presents to use a grant; `observedIdentity` is read natively at dispatch. */
export interface GrantUse {
  grantId: string;
  workspaceId: string;
  sessionId: string;
  capability: GrantRecord["capability"];
  observedIdentity: DirectoryIdentity;
  actionId?: string;
  argumentsDigest?: string;
  /** net.provider only: the qualified `scheme://host:port` the dispatch targets. */
  origin?: string;
}

export interface OnceGrantConsumption extends GrantUse {
  actionId: string;
  argumentsDigest: string;
}

interface NativeGrantPreconditions {
  expectedOnceGrant?: OnceGrantConsumption;
  expectedGrantMint?: Pick<
    GrantInput,
    "workspaceId" | "sessionId" | "capability"
  >;
  expectedActiveGrants?: readonly string[];
  workspaceAdmission?: {
    canonicalPath: string;
    workspaceId: string;
    expectedCurrent: string | null;
  };
}

const NATIVE_ONLY_KINDS: readonly string[] = [
  "admittedWorkspace",
  "grant",
  "providerEndpoint",
];
function assertNoNativeOnlyKinds(inputs: readonly AppendInput[]): void {
  if (inputs.some((input) => NATIVE_ONLY_KINDS.includes(input.kind)))
    throw new StoreError(
      "NATIVE_API_REQUIRED",
      "workspace, grant and providerEndpoint records are written only through their Store APIs (providerEndpoint: compareAndAppend)",
    );
}

const RESERVED_DEVICE =
  /^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:\..*)?$/iu;
/** Validates a final local drive path and returns its folder basename. */
function workspaceDisplayName(path: unknown): string {
  if (
    typeof path !== "string" ||
    path.length > 32767 ||
    !/^[A-Za-z]:\\(?:[^\\/:*?"<>|\x00-\x1f]+(?:\\[^\\/:*?"<>|\x00-\x1f]+)*)?$/u.test(
      path,
    )
  )
    throw new StoreError(
      "WORKSPACE_PATH_INVALID",
      "workspace path must be an absolute local drive path (no UNC, device or relative form)",
    );
  const segments = path
    .slice(3)
    .split("\\")
    .filter((segment) => segment !== "");
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        /[ .]$/u.test(segment) ||
        RESERVED_DEVICE.test(segment),
    )
  )
    throw new StoreError(
      "WORKSPACE_PATH_INVALID",
      "workspace path has a non-canonical or device segment",
    );
  return segments.at(-1) ?? path.slice(0, 2);
}

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Discriminates a SQLite failure by its result code, not the JS error class. */
function mapSqliteError(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  if (isRecordObject(error) && typeof error.errcode === "number") {
    const errcode = error.errcode;
    if (errcode === 26)
      return new StoreError(
        "STORE_CORRUPT",
        "database file is not a valid SQLite database (SQLITE_NOTADB)",
        errcode,
      );
    if (errcode === 8)
      return new StoreError(
        "STORE_READ_ONLY",
        "attempt to write a read-only database (SQLITE_READONLY)",
        errcode,
      );
    if (errcode === 5)
      return new StoreError(
        "STORE_BUSY",
        "database is locked by another writer (SQLITE_BUSY)",
        errcode,
      );
    if (errcode === 13)
      return new StoreError(
        "STORE_FULL",
        "database or disk is full (SQLITE_FULL)",
        errcode,
      );
    if (errcode === 11)
      return new StoreError(
        "STORE_CORRUPT",
        "database disk image is malformed (SQLITE_CORRUPT)",
        errcode,
      );
    const message = typeof error.message === "string" ? error.message : "";
    return new StoreError("STORE_SQLITE_ERROR", message, errcode);
  }
  if (error instanceof ContractError)
    return new StoreError(`CONTRACT_${error.code}`, error.message);
  return new StoreError(
    "STORE_UNKNOWN",
    error instanceof Error ? error.message : String(error),
  );
}

export class Store {
  readonly path: string;
  /** @internal the underlying SQLite handle; reassigned only by restore(). */
  db: DatabaseSync;
  private readonly busyTimeoutMs: number;
  private readonly maxInlineBytes: number;
  /** @internal closed flag; reset only by restore(). */
  closed = false;

  private constructor(
    path: string,
    db: DatabaseSync,
    busyTimeoutMs: number,
    maxInlineBytes: number,
    private readonly readOnly: boolean,
  ) {
    this.path = path;
    this.db = db;
    this.busyTimeoutMs = busyTimeoutMs;
    this.maxInlineBytes = maxInlineBytes;
  }

  private static tableColumns(db: DatabaseSync, table: string): Set<string> {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return new Set(rows.map((row) => row.name));
  }

  /** Validates a stamped store's shape without creating anything. */
  private static validateStamped(
    db: DatabaseSync,
    stampedVersion: string,
  ): void {
    if (stampedVersion !== String(LAYOUT_VERSION))
      throw new StoreError(
        "STORE_LAYOUT",
        stampedVersion === "1"
          ? `store layout version 1 predates session attribution; run Store.migrateV1(path) explicitly (expected ${String(LAYOUT_VERSION)})`
          : `store layout version ${stampedVersion} is not supported (expected ${String(LAYOUT_VERSION)})`,
      );
    const required: Array<[string, readonly string[]]> = [
      ["records", RECORD_COLUMNS],
      ["deletions", DELETION_COLUMNS],
      ["workspace_ownership", OWNERSHIP_COLUMNS],
    ];
    for (const [table, columns] of required) {
      const present = Store.tableColumns(db, table);
      const missing = columns.filter((column) => !present.has(column));
      if (missing.length > 0)
        throw new StoreError(
          "STORE_LAYOUT",
          `store claims layout ${stampedVersion} but table ${table} lacks columns: ${missing.join(", ")}`,
        );
    }
    Store.eventWatermarks(db);
  }

  /**
   * Explicit v1 -> v2 migration: adds session attribution to the records
   * table and stamps layout 2. Never invoked implicitly by open() — a v1
   * store refuses to open until it is migrated on purpose, so the schema
   * change cannot happen silently.
   *
   * A populated v1 store REQUIRES explicit `attribution.sessionId`: every
   * pre-existing row is stamped with that session id so its old-session
   * replay keeps working (no silent loss). An empty v1 store needs no
   * attribution; migrated rows never end up unreplayable-by-accident.
   */
  static migrateV1(path: string, attribution?: { sessionId: string }): void {
    const db = new DatabaseSync(path, { timeout: 5000 });
    try {
      // Every precondition read runs inside the write transaction, so a
      // concurrent v1 writer cannot commit rows between the check and the act.
      db.exec("BEGIN IMMEDIATE;");
      const stamped = db
        .prepare("SELECT value FROM store_meta WHERE key = 'layout_version'")
        .get() as { value: string } | undefined;
      if (stamped === undefined)
        throw new StoreError(
          "STORE_LAYOUT",
          "store is not stamped; nothing to migrate",
        );
      if (stamped.value !== "1")
        throw new StoreError(
          "STORE_LAYOUT",
          `store layout version ${stamped.value} is not migratable to ${String(LAYOUT_VERSION)} by migrateV1`,
        );
      const present = Store.tableColumns(db, "records");
      for (const column of ["seq", "record_id", "payload"]) {
        if (!present.has(column))
          throw new StoreError(
            "STORE_LAYOUT",
            `records table lacks ${column}; store is not a valid v1 store`,
          );
      }
      if (present.has("session_id"))
        throw new StoreError(
          "STORE_LAYOUT",
          "records table already carries session_id; migrateV1 refuses to run twice",
        );
      const populated =
        (
          db.prepare("SELECT COUNT(*) AS n FROM records").get() as {
            n: number | bigint;
          }
        ).n > 0;
      if (populated && (attribution?.sessionId ?? "") === "")
        throw new StoreError(
          "STORE_LAYOUT",
          "v1 store has records but no explicit session attribution was given; pass migrateV1(path, { sessionId }) so old-session replay is preserved, never silently dropped",
        );
      const sessionId = attribution?.sessionId ?? "";
      db.exec(
        "ALTER TABLE records ADD COLUMN session_id TEXT NOT NULL DEFAULT ''",
      );
      if (populated)
        db.prepare("UPDATE records SET session_id = ?").run(sessionId);
      db.prepare(
        "UPDATE store_meta SET value = ? WHERE key = 'layout_version'",
      ).run(String(LAYOUT_VERSION));
      db.exec("COMMIT;");
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK;");
      } catch {
        // the original failure is the reportable one
      }
      throw error instanceof StoreError ? error : mapSqliteError(error);
    } finally {
      db.close();
    }
  }

  /** Opens (or creates) the store; initialization is one atomic transaction
   * and an existing store must match the expected shape or we fail closed. */
  static open(path: string, options: StoreOptions = {}): Store {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
    const maxInlineBytes = options.maxInlineBytes ?? 65536;
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path, {
        timeout: busyTimeoutMs,
        readOnly: options.readOnly === true,
      });
    } catch (error) {
      throw mapSqliteError(error);
    }
    try {
      // Read-only opens never initialize: they validate the stamped layout
      // without a write transaction and reject appends explicitly (S3).
      if (options.readOnly === true) {
        db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)};`);
        const stamped = db
          .prepare("SELECT value FROM store_meta WHERE key = 'layout_version'")
          .get() as { value: string } | undefined;
        if (stamped === undefined)
          throw new StoreError(
            "STORE_LAYOUT",
            "store is not initialized; read-only open requires a stamped layout",
          );
        Store.validateStamped(db, stamped.value);
        return new Store(path, db, busyTimeoutMs, maxInlineBytes, true);
      }
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = FULL;");
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)};`);
      // Initialization is one transaction with fail-closed semantics: an
      // existing store stamped version 1 is validated, never healed; a fresh
      // file has the schema created and stamped atomically.
      db.exec("BEGIN IMMEDIATE;");
      db.exec(
        "CREATE TABLE IF NOT EXISTS store_meta (" +
          "key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      const row = db
        .prepare("SELECT value FROM store_meta WHERE key = 'layout_version'")
        .get() as { value: string } | undefined;
      if (row === undefined) {
        db.exec(
          "CREATE TABLE IF NOT EXISTS records (" +
            "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "kind TEXT NOT NULL, " +
            "record_id TEXT NOT NULL UNIQUE, " +
            "schema_version INTEGER NOT NULL, " +
            "scope_id TEXT NOT NULL, " +
            "session_id TEXT NOT NULL, " +
            "created_at TEXT NOT NULL, " +
            "payload TEXT NOT NULL)",
        );
        db.exec(
          "CREATE INDEX IF NOT EXISTS records_scope_seq " +
            "ON records (scope_id, seq)",
        );
        db.exec(
          "CREATE TABLE IF NOT EXISTS deletions (" +
            "record_id TEXT PRIMARY KEY, " +
            "generation INTEGER NOT NULL, " +
            "deleted_at TEXT NOT NULL)",
        );
        db.exec(
          "CREATE TABLE IF NOT EXISTS workspace_ownership (" +
            "workspace_id TEXT PRIMARY KEY, " +
            "owner_session_id TEXT NOT NULL, " +
            "epoch INTEGER NOT NULL, " +
            "acquired_at TEXT NOT NULL, " +
            "renewed_at TEXT NOT NULL)",
        );
        db.prepare(
          "INSERT INTO store_meta (key, value) VALUES ('layout_version', ?)",
        ).run(String(LAYOUT_VERSION));
      } else {
        Store.validateStamped(db, row.value);
      }
      // TD-13 additive native-only table (no layout bump): older layout-2
      // readers ignore it; canonical paths never enter exportable records.
      db.exec(
        "CREATE TABLE IF NOT EXISTS workspace_paths (" +
          "workspace_id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS workspace_paths_path " +
          "ON workspace_paths (canonical_path)",
      );
      db.exec("COMMIT;");
      return new Store(path, db, busyTimeoutMs, maxInlineBytes, false);
    } catch (error) {
      try {
        if (db.isTransaction) db.exec("ROLLBACK;");
      } catch {
        // the original failure is the reportable one
      }
      try {
        db.close();
      } catch {
        // the original failure is the reportable one
      }
      throw error instanceof StoreError ? error : mapSqliteError(error);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new StoreError("STORE_CLOSED", "store is closed");
  }

  /**
   * Structural bootstrap audit, including historical and tombstoned rows.
   * Reference syntax is checked, but reference authorization belongs to the
   * live caller; historical references need not still be available today.
   */
  audit(): {
    scopeIds: string[];
    recordCount: number;
    deletedRecordIds: string[];
    records: StoredRecord[];
  } {
    this.assertOpen();
    try {
      const integrity = this.db.prepare("PRAGMA integrity_check").all();
      if (
        integrity.length !== 1 ||
        (integrity[0] as { integrity_check?: unknown }).integrity_check !== "ok"
      )
        throw new StoreError("STORE_CORRUPT", "store integrity check failed");
      const stamp = this.db
        .prepare("SELECT value FROM store_meta WHERE key = 'layout_version'")
        .get() as { value: string } | undefined;
      Store.validateStamped(this.db, stamp?.value ?? "");
      const rows = this.db
        .prepare(
          "SELECT seq, kind, record_id, schema_version, scope_id, session_id, created_at, payload FROM records ORDER BY seq",
        )
        .all() as Array<{
        seq: number;
        kind: RecordKind;
        record_id: string;
        schema_version: number;
        scope_id: string;
        session_id: string;
        created_at: string;
        payload: string;
      }>;
      const scopeIds = new Set<string>();
      const records: StoredRecord[] = [];
      for (const row of rows) {
        const record = this.validateStructuralRow(row);
        scopeIds.add(row.scope_id);
        records.push({ seq: row.seq, kind: row.kind, record });
      }
      const deletions = this.db
        .prepare("SELECT record_id, generation, deleted_at FROM deletions")
        .all() as Array<{
        record_id: string;
        generation: number;
        deleted_at: string;
      }>;
      const epoch = this.deletionEpoch();
      for (const deletion of deletions) {
        if (
          typeof deletion.record_id !== "string" ||
          deletion.record_id.length === 0 ||
          /\s|[\\/]/u.test(deletion.record_id) ||
          !Number.isSafeInteger(deletion.generation) ||
          deletion.generation < 1 ||
          deletion.generation > epoch ||
          typeof deletion.deleted_at !== "string" ||
          !Number.isFinite(Date.parse(deletion.deleted_at))
        )
          throw new StoreError("STORE_LAYOUT", "invalid deletion tombstone");
      }
      return {
        scopeIds: [...scopeIds].sort(),
        recordCount: rows.length,
        deletedRecordIds: deletions.map((row) => row.record_id),
        records,
      };
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /** One SQLite observation of scoped authority and its tombstones, excluding event history. */
  readAuthority(scopeId: string): {
    records: StoredRecord[];
    deletedRecordIds: string[];
  } {
    this.assertOpen();
    try {
      const knownKinds = Object.keys(RECORD_SCHEMAS);
      const rows = this.db
        .prepare(
          "SELECT r.*, d.record_id AS deleted_record_id, d.generation, d.deleted_at, " +
            "(SELECT value FROM store_meta WHERE key = 'deletion_epoch') AS deletion_epoch " +
            "FROM records r LEFT JOIN deletions d ON d.record_id = r.record_id " +
            "WHERE r.scope_id = ? AND (r.kind IN ('profileSnapshot', 'providerConnection', 'configurationTransition') " +
            `OR r.kind NOT IN (${knownKinds.map(() => "?").join(",")}) OR r.schema_version != ?) ORDER BY r.seq`,
        )
        .all(scopeId, ...knownKinds, CONTRACT_VERSION) as Array<
        Parameters<Store["validateStructuralRow"]>[0] & {
          deleted_record_id: string | null;
          generation: number | null;
          deleted_at: string | null;
          deletion_epoch: string | null;
        }
      >;
      const records: StoredRecord[] = [];
      const deletedRecordIds: string[] = [];
      for (const row of rows) {
        const record = this.validateStructuralRow(row);
        if (row.deleted_record_id !== null) {
          const epoch =
            Store.parseEpoch(
              row.deletion_epoch ?? undefined,
              "deletion_epoch",
            ) ?? 0;
          if (
            !Number.isSafeInteger(row.generation) ||
            row.generation! < 1 ||
            row.generation! > epoch ||
            typeof row.deleted_at !== "string" ||
            !Number.isFinite(Date.parse(row.deleted_at))
          )
            throw new StoreError("STORE_LAYOUT", "invalid deletion tombstone");
          deletedRecordIds.push(row.deleted_record_id);
        }
        records.push({ seq: row.seq, kind: row.kind, record });
      }
      return { records, deletedRecordIds };
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  private validateStructuralRow(row: {
    seq: number;
    kind: RecordKind;
    record_id: string;
    schema_version: number;
    scope_id: string;
    session_id: string;
    created_at: string;
    payload: string;
  }): RecordByKind[RecordKind] {
    if (row.schema_version !== CONTRACT_VERSION)
      throw new StoreError(
        "UNKNOWN_SCHEMA",
        "audit cannot read an unknown record schema",
      );
    const parsed = this.decodeStoredPayload(row.kind, row.payload);
    const record = validateRecord(row.kind, parsed, {
      scopeId: row.scope_id,
      // Empty attribution is retained for historical migrated rows.
      sessionId: row.session_id || "historical",
      configRevision: INITIAL_CONFIG_REVISION,
      profileRevision: "audit",
      policyRevision: "audit",
      lastDurableSeq: Number.MAX_SAFE_INTEGER,
      maxInlineBytes: this.maxInlineBytes,
      resolveReference: () => true,
    });
    if (
      !Number.isSafeInteger(row.seq) ||
      row.seq < 1 ||
      record.recordId !== row.record_id ||
      record.scopeId !== row.scope_id ||
      record.createdAt !== row.created_at ||
      record.schemaVersion !== row.schema_version ||
      typeof row.session_id !== "string" ||
      (row.session_id !== "" && /\s|[\\/]/u.test(row.session_id))
    )
      throw new StoreError(
        "STORE_ATTRIBUTION",
        "stored row attribution differs from its payload",
      );
    return record;
  }

  /** Write paths reject a read-only store explicitly before any write attempt. */
  private assertWritable(): void {
    this.assertOpen();
    if (this.readOnly)
      throw new StoreError(
        "STORE_READ_ONLY",
        "store was opened read-only; writes are rejected explicitly",
        8,
      );
  }

  /** Durable cursor: highest committed seq (0 for an empty scope/store). */
  cursor(scopeId?: string): number {
    this.assertOpen();
    const sql =
      scopeId === undefined
        ? "SELECT COALESCE(MAX(seq), 0) AS s FROM records"
        : "SELECT COALESCE(MAX(seq), 0) AS s FROM records WHERE scope_id = ?";
    const row = (
      scopeId === undefined
        ? this.db.prepare(sql).get()
        : this.db.prepare(sql).get(scopeId)
    ) as { s: number | bigint };
    return Number(row.s);
  }

  private context(scopeId: string, caller: CallerContext): ContractContext {
    return {
      scopeId,
      sessionId: caller.sessionId,
      configRevision: caller.configRevision,
      profileRevision: caller.profileRevision,
      policyRevision: caller.policyRevision,
      lastDurableSeq: this.cursor(),
      maxInlineBytes: this.maxInlineBytes,
      resolveReference:
        caller.resolveReference ?? ((_id: string, _scopeId: string) => false),
    };
  }

  private eventContext(
    scopeId: string,
    caller: CallerContext,
    staged: readonly AppendInput[] = [],
  ): ContractContext {
    const context = this.context(scopeId, caller);
    context.resolveReference = (id, referencedScopeId) => {
      if (
        this.db
          .prepare("SELECT 1 FROM deletions WHERE record_id = ?")
          .get(id) !== undefined
      )
        return false;
      if (caller.resolveReference !== undefined)
        return caller.resolveReference(id, referencedScopeId) === true;
      return (
        this.db
          .prepare("SELECT 1 FROM records WHERE record_id = ? AND scope_id = ?")
          .get(id, referencedScopeId) !== undefined ||
        staged.some(
          (input) =>
            isRecordObject(input.record) &&
            input.record.recordId === id &&
            input.record.scopeId === referencedScopeId,
        )
      );
    };
    return context;
  }

  private assertEventSource(
    event: SplyceEvent,
    context: ContractContext,
  ): void {
    if (
      this.db
        .prepare("SELECT 1 FROM deletions WHERE record_id IN (?, ?)")
        .get(event.recordId, `event:${event.eventId}`) !== undefined
    )
      throw new StoreError("EVENT_DELETED", "event or source has been deleted");
    if (
      !context.resolveReference(event.recordId, event.scopeId) ||
      this.db
        .prepare("SELECT 1 FROM records WHERE record_id = ? AND scope_id = ?")
        .get(event.recordId, event.scopeId) === undefined
    )
      throw new StoreError(
        "EVENT_SOURCE",
        "event source record is unresolved or denied",
      );
  }

  private eventReadContext(
    scopeId: string,
    sessionId: string,
  ): ContractContext {
    const context = this.context(scopeId, {
      sessionId,
      configRevision: INITIAL_CONFIG_REVISION,
      profileRevision: "replay",
      policyRevision: "replay",
    });
    context.lastDurableSeq = Store.eventHighwater(this.db, scopeId, sessionId);
    context.resolveReference = (id) =>
      this.db.prepare("SELECT 1 FROM deletions WHERE record_id = ?").get(id) ===
      undefined;
    return context;
  }

  /**
   * Highest committed seq attributed to one session in a scope: the exclusive
   * cursor for that session's replay/resync. Other sessions' records never
   * advance another session's cursor, and 0 means the session has no
   * attributable records (nothing to replay from).
   */
  sessionCursor(scopeId: string, sessionId: string): number {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS s FROM records " +
          "WHERE scope_id = ? AND session_id = ?",
      )
      .get(scopeId, sessionId) as { s: number | bigint };
    return Number(row.s);
  }

  /**
   * The scope's effective configuration revision: the `acceptedConfigRevision`
   * of the latest `applied` configurationTransition, or
   * {@link INITIAL_CONFIG_REVISION} when none was ever applied. Pending,
   * draining and failed transitions never change it.
   */
  configRevision(scopeId: string): string {
    this.assertOpen();
    return Store.readConfigRevision(this.db, scopeId);
  }

  private static readConfigRevision(db: DatabaseSync, scopeId: string): string {
    // The query below reads raw payloads, so it must never trust a row the
    // normal reader would reject: an unreadable (future-schema) transition
    // means the effective revision is unknowable, so fail closed (S5).
    const unreadable = db
      .prepare(
        "SELECT schema_version FROM records WHERE scope_id = ? AND kind = 'configurationTransition' " +
          "AND schema_version != ? LIMIT 1",
      )
      .get(scopeId, CONTRACT_VERSION) as
      { schema_version: number | bigint } | undefined;
    if (unreadable !== undefined)
      throw new StoreError(
        "UNKNOWN_SCHEMA",
        `scope ${JSON.stringify(scopeId)} holds a configurationTransition with schemaVersion ${String(unreadable.schema_version)}; this store reads ${String(CONTRACT_VERSION)}, so the effective configuration revision cannot be determined`,
      );
    const row = db
      .prepare(
        "SELECT json_extract(payload, '$.acceptedConfigRevision') AS rev FROM records " +
          "WHERE scope_id = ? AND kind = 'configurationTransition' " +
          "AND json_extract(payload, '$.state') = 'applied' ORDER BY seq DESC LIMIT 1",
      )
      .get(scopeId) as { rev: string } | undefined;
    return row === undefined ? INITIAL_CONFIG_REVISION : row.rev;
  }

  private insertValidated(
    kind: RecordKind,
    record: RecordByKind[RecordKind],
    sessionId: string,
  ): number {
    const result = this.db
      .prepare(
        "INSERT INTO records (kind, record_id, schema_version, scope_id, session_id, created_at, payload) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        kind,
        record.recordId,
        CONTRACT_VERSION,
        record.scopeId,
        sessionId,
        record.createdAt,
        JSON.stringify(record),
      );
    return Number(result.lastInsertRowid);
  }

  /**
   * Validates against the frozen contract with the store's own durable cursor,
   * then commits. A returned success is durable; a thrown error acknowledges
   * nothing and leaves the store rollable/reopenable.
   */
  append(input: AppendInput, caller: CallerContext): Appended {
    this.assertWritable();
    if (input.kind === "event")
      throw new StoreError(
        "EVENT_COMMIT_REQUIRED",
        "event records require commitEvents",
      );
    assertNoNativeOnlyKinds([input]);
    const recordObject = input.record as Record<string, unknown> | undefined;
    const scopeId =
      isRecordObject(recordObject) && typeof recordObject.scopeId === "string"
        ? recordObject.scopeId
        : "";
    let validated: RecordByKind[RecordKind];
    try {
      validated = validateRecord(
        input.kind,
        input.record,
        this.context(scopeId, caller),
      );
    } catch (error) {
      throw mapSqliteError(error);
    }
    try {
      const seq = this.insertValidated(input.kind, validated, caller.sessionId);
      return { seq, recordId: validated.recordId };
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /** Atomic CAS for profile writers; ordinary append APIs retain their existing semantics. */
  compareAndAppend(
    input: AppendInput,
    caller: CallerContext,
    expected: EntityRevisionExpectation,
  ): Appended {
    let record: unknown;
    try {
      // Reference callbacks can mutate their original input, never this copy.
      record = snapshotPersistedJson(input.record);
    } catch (error) {
      throw mapSqliteError(error);
    }
    const { seqs } = this.commitBatch(
      [{ kind: input.kind, record }],
      [],
      caller,
      {
        expectedEntityRevision: { ...expected },
      },
    );
    return {
      seq: seqs[0]!,
      recordId: (record as Record<string, unknown>).recordId as string,
    };
  }

  /**
   * Ordered, atomic receipt commits: every input is validated first, then all
   * are committed in input order in one transaction. Any failure — including a
   * mid-batch constraint violation — rolls the whole batch back: the cursor
   * observable from a fresh connection is unchanged and the next write
   * succeeds on a clean handle.
   *
   * `expectedAbsentActionKey` makes the batch an atomic test-and-set: under
   * the SAME BEGIN IMMEDIATE as the inserts, an action record carrying that
   * idempotency key OR that actionId in the scope is looked up; if either
   * exists the batch throws ACTION_ALREADY_EXISTS and acknowledges nothing.
   * `expectedConfigRevision` is the same kind of in-transaction precondition for
   * configuration: the batch commits only if the scope's effective revision
   * still equals the expected one (TD-26 compare-and-set).
   *
   * Two processes that both observed the key absent can never both commit —
   * one wins the write lock, the other sees the row — and two host permit
   * IDs cannot create the same logical action under a new key.
   */
  appendBatch(
    inputs: readonly AppendInput[],
    caller: CallerContext,
    expectedAbsentActionKey?: {
      scopeId: string;
      idempotencyKey: string;
      actionId: string;
    },
    expectedOwnershipEpoch?: { workspaceId: string; epoch: number },
    expectedConfigRevision?: { scopeId: string; revision: string },
    expectedActionReservation?: {
      scopeId: string;
      actionId: string;
      idempotencyKey: string;
      recordId: string;
    },
  ): AppendBatchResult {
    if (inputs.some((input) => input.kind === "event"))
      throw new StoreError(
        "EVENT_COMMIT_REQUIRED",
        "event records require commitEvents",
      );
    assertNoNativeOnlyKinds(inputs);
    return this.commitBatch(inputs, [], caller, {
      ...(expectedAbsentActionKey === undefined
        ? {}
        : { expectedAbsentActionKey }),
      ...(expectedOwnershipEpoch === undefined
        ? {}
        : { expectedOwnershipEpoch }),
      ...(expectedConfigRevision === undefined
        ? {}
        : { expectedConfigRevision }),
      ...(expectedActionReservation === undefined
        ? {}
        : { expectedActionReservation }),
    });
  }

  /** Rejects every reused durable eventId, including identical retries. */
  commitEvents(
    receiptInputs: readonly AppendInput[],
    eventDrafts: readonly SplyceEventDraft[],
    caller: CallerContext,
    preconditions: EventPreconditions = {},
  ): AppendBatchResult & { events: SplyceEvent[] } {
    if (receiptInputs.some((input) => input.kind === "event"))
      throw new StoreError(
        "EVENT_COMMIT_REQUIRED",
        "receipts cannot contain event records",
      );
    assertNoNativeOnlyKinds(receiptInputs);
    return this.commitBatch(receiptInputs, eventDrafts, caller, preconditions);
  }

  private commitBatch(
    inputs: readonly AppendInput[],
    eventDrafts: readonly SplyceEventDraft[],
    caller: CallerContext,
    {
      expectedAbsentActionKey,
      expectedOwnershipEpoch,
      expectedConfigRevision,
      expectedActionReservation,
      expectedDeletionEpoch,
      expectedEntityRevision,
      expectedOnceGrant,
      expectedGrantMint,
      expectedActiveGrants,
      workspaceAdmission,
    }: EventPreconditions & {
      expectedEntityRevision?: EntityRevisionExpectation;
    } & NativeGrantPreconditions,
    importedWatermarks: readonly EventWatermark[] = [],
  ): AppendBatchResult & { events: SplyceEvent[] } {
    this.assertWritable();
    if (
      inputs.length === 0 &&
      eventDrafts.length === 0 &&
      importedWatermarks.length === 0 &&
      expectedAbsentActionKey === undefined &&
      expectedOwnershipEpoch === undefined &&
      expectedConfigRevision === undefined &&
      expectedActionReservation === undefined &&
      expectedDeletionEpoch === undefined &&
      expectedEntityRevision === undefined
    )
      return { seqs: [], events: [] };
    const prepared: Array<[RecordKind, RecordByKind[RecordKind]]> = [];
    try {
      for (const input of inputs) {
        const recordObject = input.record as Record<string, unknown>;
        const scopeId =
          isRecordObject(recordObject) &&
          typeof recordObject.scopeId === "string"
            ? recordObject.scopeId
            : "";
        let context = this.context(scopeId, caller);
        if (
          input.kind === "event" &&
          isRecordObject(recordObject.envelope) &&
          typeof recordObject.envelope.sessionId === "string"
        ) {
          const sessionId = recordObject.envelope.sessionId;
          const watermark = importedWatermarks.find(
            (item) => item.scopeId === scopeId && item.sessionId === sessionId,
          );
          if (watermark === undefined)
            throw new StoreError(
              "IMPORT_FORMAT",
              "event record has no selected session watermark",
            );
          context = this.eventContext(
            scopeId,
            { ...caller, sessionId },
            inputs,
          );
          context.lastDurableSeq = watermark.seq;
        }
        prepared.push([
          input.kind,
          validateRecord(input.kind, input.record, context),
        ]);
      }
    } catch (error) {
      throw mapSqliteError(error);
    }
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      if (expectedEntityRevision !== undefined) {
        const { kind, scopeId, entityId, expectedRevision } =
          expectedEntityRevision;
        const [entityField, revisionField] = (
          {
            providerConnection: ["providerConnectionId", "revision"],
            profileSnapshot: ["profileId", "profileRevision"],
            providerEndpoint: ["endpointId", "revision"],
          } as const
        )[kind] ?? ["", ""];
        const input = prepared[0];
        const opaque = (value: unknown) =>
          typeof value === "string" &&
          value.length > 0 &&
          !/\s|[\\/]/u.test(value);
        if (
          ![
            "providerConnection",
            "profileSnapshot",
            "providerEndpoint",
          ].includes(kind) ||
          prepared.length !== 1 ||
          input?.[0] !== kind ||
          !opaque(scopeId) ||
          !opaque(entityId) ||
          (expectedRevision !== null && !opaque(expectedRevision)) ||
          input[1].scopeId !== scopeId ||
          input[1][entityField] !== entityId ||
          !opaque(input[1][revisionField])
        )
          throw new StoreError(
            "ENTITY_GUARD_MISMATCH",
            "entity guard must match the inserted kind, scope, identity and revision",
          );
        // A future writer may have changed the entity shape, so even an
        // unidentifiable future row in this kind/scope makes "latest" unknown.
        const unreadable = this.db
          .prepare(
            "SELECT 1 FROM records WHERE kind = ? AND scope_id = ? AND schema_version != ? LIMIT 1",
          )
          .get(kind, scopeId, CONTRACT_VERSION);
        if (unreadable !== undefined)
          throw new StoreError(
            "UNKNOWN_SCHEMA",
            "entity revision is unknowable for this schema",
          );
        const latest = this.db
          .prepare(
            `SELECT json_extract(payload, '$.${revisionField}') AS revision FROM records WHERE kind = ? AND scope_id = ? AND json_extract(payload, '$.${entityField}') = ? ORDER BY seq DESC LIMIT 1`,
          )
          .get(kind, scopeId, entityId) as { revision: unknown } | undefined;
        const revision = latest === undefined ? null : latest.revision;
        if (revision !== expectedRevision)
          throw new StoreError(
            "ENTITY_STALE_REVISION",
            "entity revision changed; nothing appended",
          );
        const nextRevision = prepared[0]![1][revisionField];
        const reused = this.db
          .prepare(
            `SELECT 1 FROM records WHERE kind = ? AND scope_id = ? AND json_extract(payload, '$.${entityField}') = ? AND json_extract(payload, '$.${revisionField}') = ? LIMIT 1`,
          )
          .get(kind, scopeId, entityId, nextRevision as string);
        if (reused !== undefined)
          throw new StoreError(
            "ENTITY_REVISION_REUSED",
            "entity revision is immutable; nothing appended",
          );
      }
      if (
        expectedDeletionEpoch !== undefined &&
        (!Number.isSafeInteger(expectedDeletionEpoch) ||
          expectedDeletionEpoch < 0 ||
          this.deletionEpoch() !== expectedDeletionEpoch)
      )
        throw new StoreError(
          "STALE_DELETION_EPOCH",
          "deletion epoch changed before event publication",
        );
      if (expectedOwnershipEpoch !== undefined) {
        const { workspaceId, epoch } = expectedOwnershipEpoch;
        const row = this.db
          .prepare(
            "SELECT epoch FROM workspace_ownership WHERE workspace_id = ?",
          )
          .get(workspaceId) as { epoch: number | bigint } | undefined;
        const current = row === undefined ? 0 : Number(row.epoch);
        if (current !== epoch) {
          this.db.exec("ROLLBACK;");
          throw new StoreError(
            "OWNERSHIP_STALE_EPOCH",
            `workspace ${JSON.stringify(workspaceId)} ownership epoch is ${String(current)}, not the expected ${String(epoch)}; nothing appended`,
          );
        }
      }
      if (expectedConfigRevision !== undefined) {
        const { scopeId, revision } = expectedConfigRevision;
        const current = Store.readConfigRevision(this.db, scopeId);
        if (current !== revision) {
          this.db.exec("ROLLBACK;");
          throw new StoreError(
            "CONFIG_STALE_REVISION",
            `scope ${JSON.stringify(scopeId)} configuration revision is ${JSON.stringify(current)}, not the expected ${JSON.stringify(revision)}; nothing appended`,
          );
        }
      }
      if (expectedConfigRevision !== undefined) {
        // An accepted revision is never reused within a scope (including the
        // initial one): otherwise cfg-0 -> cfg-1 -> cfg-0 recreates the state a
        // stale writer expects and its compare-and-set would succeed (ABA).
        for (const [kind, record] of prepared) {
          if (kind !== "configurationTransition") continue;
          const transition = record as RecordByKind["configurationTransition"];
          if (transition.state !== "applied") continue;
          const taken =
            transition.acceptedConfigRevision === INITIAL_CONFIG_REVISION ||
            this.db
              .prepare(
                "SELECT 1 FROM records WHERE scope_id = ? AND kind = 'configurationTransition' " +
                  "AND json_extract(payload, '$.state') = 'applied' " +
                  "AND json_extract(payload, '$.acceptedConfigRevision') = ? LIMIT 1",
              )
              .get(
                expectedConfigRevision.scopeId,
                transition.acceptedConfigRevision,
              ) !== undefined;
          if (taken) {
            this.db.exec("ROLLBACK;");
            throw new StoreError(
              "CONFIG_REVISION_REUSED",
              `configuration revision ${JSON.stringify(transition.acceptedConfigRevision)} was already accepted in scope ${JSON.stringify(expectedConfigRevision.scopeId)}; nothing appended`,
            );
          }
        }
      }
      if (expectedAbsentActionKey !== undefined) {
        const { scopeId, idempotencyKey, actionId } = expectedAbsentActionKey;
        const existing = this.db
          .prepare(
            "SELECT 1 FROM records WHERE scope_id = ? AND kind = 'action' " +
              "AND (json_extract(payload, '$.idempotencyKey') = ? " +
              "OR json_extract(payload, '$.actionId') = ?) LIMIT 1",
          )
          .get(scopeId, idempotencyKey, actionId);
        if (existing !== undefined) {
          this.db.exec("ROLLBACK;");
          throw new StoreError(
            "ACTION_ALREADY_EXISTS",
            `an action record with idempotencyKey ${JSON.stringify(idempotencyKey)} or actionId ${JSON.stringify(actionId)} already exists in scope ${JSON.stringify(scopeId)}; nothing appended`,
          );
        }
      }
      for (const watermark of importedWatermarks) {
        const current = Store.eventHighwater(
          this.db,
          watermark.scopeId,
          watermark.sessionId,
        );
        if (watermark.seq < current)
          throw new StoreError(
            "STALE_EVENT_SEQUENCE",
            "import would roll back an event counter",
          );
        this.writeEventHighwater(
          watermark.scopeId,
          watermark.sessionId,
          watermark.seq,
        );
      }
      if (expectedActionReservation !== undefined) {
        const { scopeId, actionId, idempotencyKey, recordId } =
          expectedActionReservation;
        const rows = this.db
          .prepare(
            "SELECT record_id, json_extract(payload, '$.actionId') AS action_id, " +
              "json_extract(payload, '$.idempotencyKey') AS idempotency_key, json_extract(payload, '$.state') AS state " +
              "FROM records WHERE scope_id = ? AND kind = 'action' AND " +
              "(json_extract(payload, '$.actionId') = ? OR json_extract(payload, '$.idempotencyKey') = ?)",
          )
          .all(scopeId, actionId, idempotencyKey) as Array<{
          record_id: string;
          action_id: string;
          idempotency_key: string;
          state: string;
        }>;
        if (
          rows.length !== 1 ||
          rows[0]?.record_id !== recordId ||
          rows[0]?.action_id !== actionId ||
          rows[0]?.idempotency_key !== idempotencyKey ||
          rows[0]?.state !== "proposed"
        )
          throw new StoreError(
            "ACTION_RESERVATION_CHANGED",
            "action reservation changed; nothing appended",
          );
      }
      if (workspaceAdmission !== undefined) {
        const latest = this.currentWorkspaceIdForPath(
          workspaceAdmission.canonicalPath,
        );
        if (latest !== workspaceAdmission.expectedCurrent)
          throw new StoreError(
            "WORKSPACE_ADMISSION_CHANGED",
            "workspace admission changed concurrently; nothing appended",
          );
        this.db
          .prepare(
            "INSERT INTO workspace_paths (workspace_id, canonical_path) VALUES (?, ?)",
          )
          .run(
            workspaceAdmission.workspaceId,
            workspaceAdmission.canonicalPath,
          );
      }
      if (expectedGrantMint !== undefined) {
        this.requireCurrentWorkspace(expectedGrantMint.workspaceId);
        if (
          expectedGrantMint.capability !== "net.provider" &&
          this.db
            .prepare(
              "SELECT 1 FROM records WHERE kind = 'branchAnchor' AND json_extract(payload, '$.piSessionId') = ? LIMIT 1",
            )
            .get(expectedGrantMint.sessionId) === undefined
        )
          throw new StoreError(
            "SESSION_UNKNOWN",
            "grant session has no Pi-derived session record; nothing appended",
          );
      }
      for (const grantId of expectedActiveGrants ?? []) {
        const state = this.grantState(grantId);
        if (state === undefined)
          throw new StoreError("GRANT_REQUIRED", "grant does not exist");
        if (state.revoked)
          throw new StoreError("GRANT_REVOKED", "grant is already revoked");
      }
      if (expectedOnceGrant !== undefined) {
        this.checkGrant(expectedOnceGrant, "once");
        if (
          !prepared.some(
            ([kind, record]) =>
              kind === "action" &&
              record.actionId === expectedOnceGrant.actionId &&
              record.state === "running" &&
              record.argumentsDigest === expectedOnceGrant.argumentsDigest,
          )
        )
          throw new StoreError(
            "GRANT_MISMATCH",
            "once-grant consumption must commit with its action's running receipt; nothing appended",
          );
      }
      const seqs: number[] = [];
      for (const [kind, record] of prepared) {
        if (kind === "event") {
          const context = this.eventContext(record.scopeId, {
            ...caller,
            sessionId:
              isRecordObject(record.envelope) &&
              typeof record.envelope.sessionId === "string"
                ? record.envelope.sessionId
                : "",
          });
          context.lastDurableSeq = Store.eventHighwater(
            this.db,
            record.scopeId,
            context.sessionId,
          );
          const event = validateEvent(record.envelope, context);
          this.assertEventSource(event, context);
          this.assertNewEventId(event.eventId);
          seqs.push(this.insertValidated(kind, record, event.sessionId));
        } else seqs.push(this.insertValidated(kind, record, caller.sessionId));
      }
      const events: SplyceEvent[] = [];
      for (const draft of eventDrafts) {
        const current = Store.eventHighwater(
          this.db,
          draft.scopeId,
          draft.sessionId,
        );
        if (current === Number.MAX_SAFE_INTEGER)
          throw new StoreError(
            "EVENT_SEQUENCE_OVERFLOW",
            "event counter exhausted",
          );
        const context = this.eventContext(draft.scopeId, caller);
        context.lastDurableSeq = current;
        const event = validateEvent({ ...draft, seq: current + 1 }, context);
        this.assertEventSource(event, context);
        this.assertNewEventId(event.eventId);
        if (event.durable) {
          const record = validateRecord(
            "event",
            {
              schemaVersion: CONTRACT_VERSION,
              recordId: `event:${event.eventId}`,
              createdAt: event.createdAt,
              scopeId: event.scopeId,
              sourceIds: event.sourceIds,
              envelope: event,
            },
            context,
          );
          this.insertValidated("event", record, event.sessionId);
        }
        this.writeEventHighwater(event.scopeId, event.sessionId, event.seq);
        events.push(event);
      }
      if (importedWatermarks.length > 0) Store.eventWatermarks(this.db);
      this.db.exec("COMMIT;");
      return { seqs, events };
    } catch (error) {
      let rollbackError: unknown;
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
      } catch (rollback) {
        rollbackError = rollback;
      }
      if (rollbackError !== undefined) {
        // A failed rollback is never silent: the store cannot guarantee
        // durability state afterwards, so report both causes.
        throw new StoreError(
          "STORE_ROLLBACK_FAILED",
          `batch failed (${error instanceof Error ? error.message : String(error)}) and rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
        );
      }
      throw mapSqliteError(error);
    }
  }

  /** Project the unchanged v1 stored envelope onto the current wire version;
   * full validation still follows, and persisted bytes are never rewritten. */
  private decodeStoredPayload(kind: string, payload: string): unknown {
    let record: unknown;
    try {
      record = JSON.parse(payload);
    } catch {
      throw new StoreError("STORE_CORRUPT", "stored payload is not valid JSON");
    }
    if (
      kind === "event" &&
      isRecordObject(record) &&
      isRecordObject(record.envelope) &&
      record.envelope.protocolVersion === 1
    )
      return {
        ...record,
        envelope: { ...record.envelope, protocolVersion: PROTOCOL_VERSION },
      };
    return record;
  }

  private readRow(row: unknown): StoredRecord {
    const r = row as {
      seq: number | bigint;
      kind: string;
      schema_version: number | bigint;
      payload: string;
    };
    if (Number(r.schema_version) !== CONTRACT_VERSION) {
      throw new StoreError(
        "UNKNOWN_SCHEMA",
        `record ${r.kind} carries schemaVersion ${String(r.schema_version)}; this store reads ${String(CONTRACT_VERSION)}`,
      );
    }
    const record = this.decodeStoredPayload(r.kind, r.payload);
    if (r.kind === "event") {
      const attribution = this.db
        .prepare("SELECT scope_id, session_id FROM records WHERE seq = ?")
        .get(r.seq) as { scope_id: string; session_id: string };
      const context = this.eventReadContext(
        attribution.scope_id,
        attribution.session_id,
      );
      const validated = validateRecord("event", record, context);
      this.assertEventSource(validated.envelope, context);
      return { seq: Number(r.seq), kind: "event", record: validated };
    }
    return {
      seq: Number(r.seq),
      kind: r.kind as RecordKind,
      record: record as RecordByKind[RecordKind],
    };
  }

  private assertNewEventId(eventId: string): void {
    if (
      this.db
        .prepare("SELECT 1 FROM records WHERE kind = 'event' AND record_id = ?")
        .get(`event:${eventId}`) !== undefined
    )
      throw new StoreError(
        "EVENT_ALREADY_EXISTS",
        "durable eventId already exists; retry rejected without changes",
      );
  }

  private writeEventHighwater(
    scopeId: string,
    sessionId: string,
    seq: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO store_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(eventSequenceKey(scopeId, sessionId), String(seq));
  }

  private static eventHighwater(
    db: DatabaseSync,
    scopeId: string,
    sessionId: string,
    validateHistory = false,
  ): number {
    const key = eventSequenceKey(scopeId, sessionId);
    const row = db
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (row !== undefined && !/^(?:0|[1-9]\d*)$/u.test(row.value))
      throw new StoreError("STORE_LAYOUT", "invalid event counter metadata");
    const seq = row === undefined ? 0 : Store.parseEpoch(row.value, key)!;
    // Full audits run on open/replay/recovery; streaming checks only the newest envelope.
    // shortcut: scope index scans intervening sessions; qualify a session index for heavy interleaving.
    const durable = db
      .prepare(
        "SELECT record_id, json_extract(payload, '$.envelope.eventId') AS event_id, json_extract(payload, '$.envelope.seq') AS event_seq FROM records WHERE kind = 'event' AND scope_id = ? AND session_id = ? ORDER BY records.seq DESC" +
          (validateHistory ? "" : " LIMIT 1"),
      )
      .all(scopeId, sessionId) as Array<{
      record_id: string;
      event_id: unknown;
      event_seq: unknown;
    }>;
    const seen = new Set<number>();
    for (const event of durable) {
      if (
        typeof event.event_id !== "string" ||
        event.record_id !== `event:${event.event_id}` ||
        typeof event.event_seq !== "number" ||
        !Number.isSafeInteger(event.event_seq) ||
        event.event_seq <= 0 ||
        event.event_seq > seq ||
        seen.has(event.event_seq)
      )
        throw new StoreError(
          "STORE_LAYOUT",
          "durable events disagree with their event counter",
        );
      seen.add(event.event_seq);
    }
    return seq;
  }

  private static eventWatermarks(db: DatabaseSync): EventWatermark[] {
    const rows = db
      .prepare("SELECT key, value FROM store_meta WHERE substr(key, 1, ?) = ?")
      .all(EVENT_SEQUENCE_PREFIX.length, EVENT_SEQUENCE_PREFIX) as Array<{
      key: string;
      value: string;
    }>;
    const watermarks: EventWatermark[] = [];
    for (const row of rows) {
      let pair: unknown;
      try {
        pair = JSON.parse(row.key.slice(EVENT_SEQUENCE_PREFIX.length));
      } catch {
        throw new StoreError("STORE_LAYOUT", "invalid event counter key");
      }
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        typeof pair[1] !== "string" ||
        eventSequenceKey(pair[0], pair[1]) !== row.key
      )
        throw new StoreError("STORE_LAYOUT", "invalid event counter key");
      watermarks.push({
        scopeId: pair[0],
        sessionId: pair[1],
        seq: Store.eventHighwater(db, pair[0], pair[1], true),
      });
    }
    const sessions = db
      .prepare(
        "SELECT DISTINCT scope_id, session_id FROM records WHERE kind = 'event'",
      )
      .all() as Array<{ scope_id: string; session_id: string }>;
    for (const session of sessions)
      Store.eventHighwater(db, session.scope_id, session.session_id, true);
    return watermarks;
  }

  /** Highest ALLOCATED envelope sequence, including transient reservations; survives reopen. */
  eventHighwater(scopeId: string, sessionId: string): number {
    this.assertOpen();
    return Store.eventHighwater(this.db, scopeId, sessionId);
  }

  /** Highest retained durable envelope sequence; transient allocation is separate. */
  eventCursor(scopeId: string, sessionId: string): number {
    this.assertOpen();
    Store.eventHighwater(this.db, scopeId, sessionId);
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(json_extract(payload, '$.envelope.seq')), 0) AS seq FROM records WHERE kind = 'event' AND scope_id = ? AND session_id = ?",
      )
      .get(scopeId, sessionId) as { seq: number };
    return row.seq;
  }

  /** Retained envelopes only; deleted evidence fails closed. Transient gaps need a real snapshot. */
  replayEvents(
    scopeId: string,
    sessionId: string,
    afterSeq = 0,
  ): SplyceEvent[] {
    this.assertOpen();
    const highwater = Store.eventHighwater(this.db, scopeId, sessionId, true);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > highwater)
      throw new StoreError(
        "INVALID_CURSOR",
        "event cursor is outside this session's history",
      );
    const context = this.context(scopeId, {
      sessionId,
      configRevision: INITIAL_CONFIG_REVISION,
      profileRevision: "replay",
      policyRevision: "replay",
    });
    context.lastDurableSeq = highwater;
    context.resolveReference = (id) =>
      this.db.prepare("SELECT 1 FROM deletions WHERE record_id = ?").get(id) ===
      undefined;
    const rows = this.db
      .prepare(
        "SELECT seq, kind, schema_version, payload FROM records WHERE kind = 'event' AND scope_id = ? AND session_id = ? ORDER BY seq ASC",
      )
      .all(scopeId, sessionId);
    return rows
      .map((row) => {
        const entry = this.readRow(row);
        const record = validateRecord("event", entry.record, context);
        this.assertEventSource(record.envelope, context);
        return record.envelope;
      })
      .filter((event) => event.seq > afterSeq);
  }

  /** Reads one record by id; unknown contract versions are rejected (S5). */
  get(recordId: string): StoredRecord {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT seq, kind, schema_version, payload FROM records WHERE record_id = ?",
      )
      .get(recordId);
    if (row === undefined)
      throw new StoreError("STORE_NOT_FOUND", `no record ${recordId}`);
    return this.readRow(row);
  }

  /**
   * Ordered read of a scope's records after a cursor. When `sessionId` is
   * given, only records committed by that session are returned — replay for
   * one session never mixes another session's records. Records written
   * before session attribution (migrated v1 rows) carry '' and are excluded
   * from session-filtered reads.
   */
  list(scopeId: string, afterSeq = 0, sessionId?: string): ListResult {
    this.assertOpen();
    const rows = (
      sessionId === undefined
        ? this.db
            .prepare(
              "SELECT seq, kind, schema_version, payload FROM records " +
                "WHERE scope_id = ? AND seq > ? ORDER BY seq ASC",
            )
            .all(scopeId, afterSeq)
        : this.db
            .prepare(
              "SELECT seq, kind, schema_version, payload FROM records " +
                "WHERE scope_id = ? AND seq > ? AND session_id = ? ORDER BY seq ASC",
            )
            .all(scopeId, afterSeq, sessionId)
    ) as unknown[];
    const records: StoredRecord[] = [];
    let skippedUnknownSchema = 0;
    for (const row of rows) {
      try {
        records.push(this.readRow(row));
      } catch (error) {
        if (error instanceof StoreError && error.code === "UNKNOWN_SCHEMA") {
          skippedUnknownSchema += 1;
          continue;
        }
        throw error;
      }
    }
    return { records, skippedUnknownSchema };
  }

  /**
   * Parses an epoch counter from store_meta. A persisted epoch must be a
   * finite nonnegative safe integer; anything malformed fails closed so a
   * corrupt counter can never silently restart at zero or allocate NaN.
   */
  private static parseEpoch(
    raw: string | undefined,
    key: string,
  ): number | undefined {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new StoreError(
        "STORE_LAYOUT",
        `store_meta ${key} = ${JSON.stringify(raw)} is not a finite nonnegative safe integer; failing closed`,
      );
    return value;
  }

  /**
   * Records a deletion tombstone under a globally monotonic deletion epoch
   * persisted in `store_meta`. The epoch is what backups carry, so a restore
   * that would drop any tombstone is refused.
   */
  noteDeletion(recordId: string): number {
    this.assertWritable();
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      const epoch = Store.epochOf(this.db, "deletion_epoch", "deletions") + 1;
      this.db
        .prepare(
          "INSERT INTO deletions (record_id, generation, deleted_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(record_id) DO UPDATE SET generation = excluded.generation, deleted_at = excluded.deleted_at",
        )
        .run(recordId, epoch, new Date().toISOString());
      this.db
        .prepare(
          "INSERT INTO store_meta (key, value) VALUES ('deletion_epoch', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(epoch));
      this.db.exec("COMMIT;");
      return epoch;
    } catch (error) {
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
      } catch {
        // fall through to the reportable error
      }
      throw mapSqliteError(error);
    }
  }

  /**
   * Reads a persisted epoch counter from a read-only handle. A missing counter
   * is NEVER treated as zero when history may exist: absence with any history
   * rows fails closed, so old layouts cannot be silently migrated.
   */
  private static epochOf(
    db: DatabaseSync,
    key: string,
    historyTable: string,
  ): number {
    const row = db
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    const parsed = Store.parseEpoch(row?.value, key);
    if (parsed !== undefined) return parsed;
    const history = db
      .prepare(`SELECT COUNT(*) AS n FROM ${historyTable}`)
      .get() as { n: number | bigint };
    if (Number(history.n) > 0)
      throw new StoreError(
        "STORE_LAYOUT",
        `${historyTable} history exists but ${key} metadata is absent; refusing to treat history as zero`,
      );
    return 0;
  }

  /** Full read-only validation of a backup file before it may overwrite live bytes. */
  private static validateBackup(dbPath: string): {
    deletionEpoch: number;
    ownershipEpoch: number;
    eventWatermarks: EventWatermark[];
  } {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const stamped = db
        .prepare("SELECT value FROM store_meta WHERE key = 'layout_version'")
        .get() as { value: string } | undefined;
      if (stamped === undefined)
        throw new StoreError(
          "STORE_LAYOUT",
          "backup is not a stamped store (no layout_version); refusing to restore",
        );
      Store.validateStamped(db, stamped.value);
      return {
        eventWatermarks: Store.eventWatermarks(db),
        deletionEpoch: Store.epochOf(db, "deletion_epoch", "deletions"),
        ownershipEpoch: Store.epochOf(
          db,
          "ownership_epoch",
          "workspace_ownership",
        ),
      };
    } finally {
      db.close();
    }
  }

  /** Highest deletion epoch recorded in a (backup) database file. */
  static deletionEpochOf(dbPath: string): number {
    return Store.validateBackup(dbPath).deletionEpoch;
  }

  /** Consistent backup through SQLite itself (`VACUUM INTO`), never a raw copy. */
  backup(targetPath: string): void {
    this.assertOpen();
    try {
      this.db.exec(`VACUUM INTO '${targetPath.replaceAll("'", "''")}'`);
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /** Highest deletion epoch recorded in this store's live database. */
  deletionEpoch(): number {
    this.assertOpen();
    return Store.epochOf(this.db, "deletion_epoch", "deletions");
  }

  /** Live ownership epoch (same fail-closed rule as the deletion epoch). */
  ownershipEpoch(): number {
    this.assertOpen();
    return Store.epochOf(this.db, "ownership_epoch", "workspace_ownership");
  }

  /**
   * Restores a backup with full safety ordering: the backup's layout and epoch
   * metadata are validated read-only BEFORE any live byte is touched, so an
   * invalid or future-layout backup preserves acknowledged live records. A
   * restore never rolls back workspace ownership: a snapshot older than the
   * live ownership epoch would resurrect a stale owner or permit epoch reuse,
   * so it is refused.
   */
  restore(backupPath: string): void {
    this.assertWritable();
    let backup: {
      deletionEpoch: number;
      ownershipEpoch: number;
      eventWatermarks: EventWatermark[];
    };
    try {
      backup = Store.validateBackup(backupPath);
    } catch (error) {
      throw error instanceof StoreError ? error : mapSqliteError(error);
    }
    const liveDeletionEpoch = this.deletionEpoch();
    if (backup.deletionEpoch < liveDeletionEpoch)
      throw new StoreError(
        "STALE_RESTORE",
        `backup deletion epoch ${String(backup.deletionEpoch)} is older than current ${String(liveDeletionEpoch)}`,
      );
    const liveOwnershipEpoch = this.ownershipEpoch();
    if (backup.ownershipEpoch < liveOwnershipEpoch)
      throw new StoreError(
        "STALE_OWNERSHIP",
        `backup ownership epoch ${String(backup.ownershipEpoch)} is older than current ${String(liveOwnershipEpoch)}; restoring would roll back the workspace writer state`,
      );

    const liveWatermarks = Store.eventWatermarks(this.db);
    const assertEventRecovery = (watermarks: readonly EventWatermark[]) => {
      for (const live of liveWatermarks) {
        const restored = watermarks.find(
          (item) =>
            item.scopeId === live.scopeId && item.sessionId === live.sessionId,
        );
        if ((restored?.seq ?? 0) < live.seq)
          throw new StoreError(
            "STALE_EVENT_SEQUENCE",
            "restore would roll back an acknowledged event sequence",
          );
      }
    };
    assertEventRecovery(backup.eventWatermarks);

    // Stage the replacement next to the live file and revalidate the staged
    // bytes: the live file is untouched until a validated, reopenable
    // replacement exists.
    const staging = `${this.path}.restore-staging`;
    const original = `${this.path}.restore-original`;
    try {
      copyFileSync(backupPath, staging);
      assertEventRecovery(Store.validateBackup(staging).eventWatermarks);
    } catch (error) {
      try {
        // The staging path is store-reserved; clear any blocking artifact so
        // a later restore attempt is not permanently wedged.
        rmSync(staging, { recursive: true, force: true });
      } catch {
        // the reportable error is the copy/validation failure
      }
      throw error instanceof StoreError ? error : mapSqliteError(error);
    }

    // Swap with the original preserved until the staged store reopens. The
    // recovery path below never deletes the live path unless the original
    // bytes were successfully preserved first (phase-tracked), and every
    // collision fails closed BEFORE the live store is closed.
    if (existsSync(original))
      throw new StoreError(
        "STORE_RESTORE_COLLISION",
        `recovery path ${original} is occupied; refusing to start the swap`,
      );
    this.close();
    let reopened: Store | undefined;
    let originalPreserved = false;
    let swapped = false;
    try {
      for (const suffix of ["-wal", "-shm"])
        if (existsSync(this.path + suffix)) rmSync(this.path + suffix);
      if (existsSync(this.path)) {
        renameSync(this.path, original);
        originalPreserved = true;
      }
      renameSync(staging, this.path);
      swapped = true;
      reopened = Store.open(this.path, {
        busyTimeoutMs: this.busyTimeoutMs,
        maxInlineBytes: this.maxInlineBytes,
      });
      this.db = reopened.db;
      this.closed = false;
    } catch (error) {
      try {
        if (reopened !== undefined) reopened.close();
      } catch {
        // recovery below owns the reportable failure
      }
      let recovered = false;
      try {
        // Only remove the live path when it holds the failed staged copy AND
        // the original bytes are safely preserved.
        if (swapped && originalPreserved) rmSync(this.path, { force: true });
        if (originalPreserved && !existsSync(this.path))
          renameSync(original, this.path);
        const recoveredStore = Store.open(this.path, {
          busyTimeoutMs: this.busyTimeoutMs,
          maxInlineBytes: this.maxInlineBytes,
        });
        this.db = recoveredStore.db;
        this.closed = false;
        recovered = true;
      } catch (recoveryError) {
        throw new StoreError(
          "STORE_RESTORE_FAILED",
          `restore failed (${error instanceof Error ? error.message : String(error)}) and live recovery also failed (${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)})`,
        );
      }
      if (!recovered)
        throw new StoreError(
          "STORE_RESTORE_FAILED",
          `restore failed and live state is uncertain (${error instanceof Error ? error.message : String(error)})`,
        );
      throw error instanceof StoreError ? error : mapSqliteError(error);
    }
    try {
      rmSync(original, { force: true });
    } catch {
      // leftover preserved copy is harmless; the live store is authoritative
    }
  }

  /**
   * Durable canonical-workspace ownership: at most one live writer per
   * workspace, keyed by canonical workspace id rather than session. The write
   * is a compare-and-set serialized by `BEGIN IMMEDIATE` and persisted in the
   * same authoritative store as the receipts.
   */
  acquireWorkspace(workspaceId: string, sessionId: string): WorkspaceOwnership {
    this.assertWritable();
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      const row = this.db
        .prepare(
          "SELECT owner_session_id, epoch FROM workspace_ownership WHERE workspace_id = ?",
        )
        .get(workspaceId) as
        { owner_session_id: string; epoch: number | bigint } | undefined;
      let ownership: WorkspaceOwnership;
      if (row === undefined) {
        // Epochs never repeat: the counter is globally monotonic in store_meta,
        // so a released workspace is re-acquired at a strictly higher epoch.
        const epoch =
          Store.epochOf(this.db, "ownership_epoch", "workspace_ownership") + 1;
        this.db
          .prepare(
            "INSERT INTO workspace_ownership (workspace_id, owner_session_id, epoch, acquired_at, renewed_at) " +
              "VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            workspaceId,
            sessionId,
            epoch,
            new Date().toISOString(),
            new Date().toISOString(),
          );
        this.db
          .prepare(
            "INSERT INTO store_meta (key, value) VALUES ('ownership_epoch', ?) " +
              "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run(String(epoch));
        ownership = { workspaceId, ownerSessionId: sessionId, epoch };
      } else if (row.owner_session_id === sessionId) {
        ownership = {
          workspaceId,
          ownerSessionId: sessionId,
          epoch: Number(row.epoch),
        };
      } else {
        throw new StoreError(
          "OWNERSHIP_CONFLICT",
          `workspace ${workspaceId} is owned by session ${row.owner_session_id}`,
        );
      }
      this.db.exec("COMMIT;");
      return ownership;
    } catch (error) {
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
      } catch {
        // fall through to the reportable error
      }
      throw mapSqliteError(error);
    }
  }

  /**
   * Compare-and-set renewal: the epoch advances only when the caller is the
   * current owner presenting the current epoch; anything else is refused.
   */
  renewWorkspace(
    workspaceId: string,
    sessionId: string,
    expectedEpoch: number,
  ): WorkspaceOwnership {
    this.assertWritable();
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      const row = this.db
        .prepare(
          "SELECT owner_session_id, epoch FROM workspace_ownership WHERE workspace_id = ?",
        )
        .get(workspaceId) as
        { owner_session_id: string; epoch: number | bigint } | undefined;
      if (row === undefined)
        throw new StoreError(
          "OWNERSHIP_NOT_FOUND",
          `workspace ${workspaceId} is not owned`,
        );
      if (row.owner_session_id !== sessionId)
        throw new StoreError(
          "OWNERSHIP_CONFLICT",
          `workspace ${workspaceId} is owned by session ${row.owner_session_id}`,
        );
      if (Number(row.epoch) !== expectedEpoch)
        throw new StoreError(
          "OWNERSHIP_STALE_EPOCH",
          `workspace ${workspaceId} is at epoch ${String(row.epoch)}, caller presented ${String(expectedEpoch)}`,
        );
      // Renewals allocate from the global epoch too: the next epoch is never
      // lower than the global counter, so a stale epoch can never revalidate
      // after releases/renewals of other workspaces.
      const epoch =
        Math.max(
          Store.epochOf(this.db, "ownership_epoch", "workspace_ownership"),
          Number(row.epoch),
        ) + 1;
      this.db
        .prepare(
          "UPDATE workspace_ownership SET epoch = ?, renewed_at = ? WHERE workspace_id = ?",
        )
        .run(epoch, new Date().toISOString(), workspaceId);
      this.db
        .prepare(
          "INSERT INTO store_meta (key, value) VALUES ('ownership_epoch', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(epoch));
      this.db.exec("COMMIT;");
      return { workspaceId, ownerSessionId: sessionId, epoch };
    } catch (error) {
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
      } catch {
        // fall through to the reportable error
      }
      throw mapSqliteError(error);
    }
  }

  /** Releases ownership; only the current owner with the current epoch succeeds. */
  releaseWorkspace(
    workspaceId: string,
    sessionId: string,
    expectedEpoch: number,
  ): void {
    this.assertOpen();
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      const row = this.db
        .prepare(
          "SELECT owner_session_id, epoch FROM workspace_ownership WHERE workspace_id = ?",
        )
        .get(workspaceId) as
        { owner_session_id: string; epoch: number | bigint } | undefined;
      if (row === undefined)
        throw new StoreError(
          "OWNERSHIP_NOT_FOUND",
          `workspace ${workspaceId} is not owned`,
        );
      if (row.owner_session_id !== sessionId)
        throw new StoreError(
          "OWNERSHIP_CONFLICT",
          `workspace ${workspaceId} is owned by session ${row.owner_session_id}`,
        );
      if (Number(row.epoch) !== expectedEpoch)
        throw new StoreError(
          "OWNERSHIP_STALE_EPOCH",
          `workspace ${workspaceId} is at epoch ${String(row.epoch)}, caller presented ${String(expectedEpoch)}`,
        );
      // Release advances the global fence: a backup taken before this
      // release carries the old epoch, so restoring it can never resurrect
      // the released owner or a stale token.
      const epoch =
        Math.max(
          Store.epochOf(this.db, "ownership_epoch", "workspace_ownership"),
          Number(row.epoch),
        ) + 1;
      this.db
        .prepare(
          "INSERT INTO store_meta (key, value) VALUES ('ownership_epoch', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(epoch));
      this.db
        .prepare("DELETE FROM workspace_ownership WHERE workspace_id = ?")
        .run(workspaceId);
      this.db.exec("COMMIT;");
    } catch (error) {
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
      } catch {
        // fall through to the reportable error
      }
      throw mapSqliteError(error);
    }
  }

  /** Current ownership row for a workspace, or undefined when unowned. */
  workspaceOwner(workspaceId: string): WorkspaceOwnership | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT owner_session_id, epoch FROM workspace_ownership WHERE workspace_id = ?",
      )
      .get(workspaceId) as
      { owner_session_id: string; epoch: number | bigint } | undefined;
    if (row === undefined) return undefined;
    return {
      workspaceId,
      ownerSessionId: row.owner_session_id,
      epoch: Number(row.epoch),
    };
  }

  /** S8 export: legacy record lines, plus one versioned header when event counters exist. */
  exportJSONL(targetPath: string, scopeId?: string): number {
    this.assertOpen();
    const rows =
      scopeId === undefined
        ? (this.db
            .prepare(
              "SELECT seq, kind, schema_version, payload FROM records ORDER BY seq ASC",
            )
            .all() as unknown[])
        : (this.db
            .prepare(
              "SELECT seq, kind, schema_version, payload FROM records WHERE scope_id = ? ORDER BY seq ASC",
            )
            .all(scopeId) as unknown[]);
    const lines: string[] = [];
    const watermarks = Store.eventWatermarks(this.db).filter(
      (item) => scopeId === undefined || item.scopeId === scopeId,
    );
    if (watermarks.length > 0)
      lines.push(
        JSON.stringify({
          format: "splyce-event-ledger",
          version: 1,
          watermarks,
        }),
      );
    for (const row of rows) {
      const stored = this.readRow(row);
      lines.push(
        JSON.stringify({
          seq: stored.seq,
          kind: stored.kind,
          record: stored.record,
        }),
      );
    }
    writeFileSync(
      targetPath,
      lines.join("\n") + (lines.length ? "\n" : ""),
      "utf8",
    );
    return rows.length;
  }

  /** S8 import: replays a JSONL export into this store in file order. */
  importJSONL(sourcePath: string, caller: CallerContext): number {
    this.assertWritable();
    const text = readFileSync(sourcePath, "utf8");
    const inputs: AppendInput[] = [];
    const watermarks: EventWatermark[] = [];
    let first = true;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const entry: unknown = JSON.parse(line);
      if (!isRecordObject(entry))
        throw new StoreError("IMPORT_FORMAT", "invalid JSONL entry");
      if (Object.hasOwn(entry, "format")) {
        if (
          !first ||
          entry.format !== "splyce-event-ledger" ||
          entry.version !== 1 ||
          Object.keys(entry).length !== 3 ||
          !Array.isArray(entry.watermarks) ||
          entry.watermarks.length === 0
        )
          throw new StoreError("IMPORT_FORMAT", "invalid event ledger header");
        const seen = new Set<string>();
        for (const item of entry.watermarks) {
          if (
            !isRecordObject(item) ||
            Object.keys(item).length !== 3 ||
            typeof item.scopeId !== "string" ||
            typeof item.sessionId !== "string" ||
            typeof item.seq !== "number" ||
            !Number.isSafeInteger(item.seq) ||
            item.seq < 0
          )
            throw new StoreError("IMPORT_FORMAT", "invalid event watermark");
          const key = eventSequenceKey(item.scopeId, item.sessionId);
          if (seen.has(key))
            throw new StoreError("IMPORT_FORMAT", "duplicate event watermark");
          seen.add(key);
          watermarks.push({
            scopeId: item.scopeId,
            sessionId: item.sessionId,
            seq: item.seq,
          });
        }
      } else {
        if (typeof entry.kind !== "string")
          throw new StoreError("IMPORT_FORMAT", "invalid record kind");
        if (entry.kind === "event" && watermarks.length === 0)
          throw new StoreError(
            "IMPORT_FORMAT",
            "event records require a watermark header",
          );
        inputs.push({ kind: entry.kind as RecordKind, record: entry.record });
      }
      first = false;
    }
    this.commitBatch(inputs, [], caller, {}, watermarks);
    return inputs.length;
  }

  // ---- TD-13 admitted workspaces and grants (native write path only) ----

  /**
   * Admits a native-resolved directory. The same path with the same identity
   * returns the existing workspace; the same path with another identity is
   * WORKSPACE_IDENTITY_CHANGED unless `readmit` is set, which supersedes the
   * old workspaceId (its grants stop working) with a fresh one.
   */
  admitWorkspace(
    input: WorkspaceAdmissionInput,
    caller: CallerContext,
    { readmit = false }: { readmit?: boolean } = {},
  ): AdmittedWorkspace {
    this.assertWritable();
    if (
      !isRecordObject(input) ||
      Object.keys(input).sort().join(",") !==
        "canonicalPath,fileId,volumeSerial"
    )
      throw new StoreError("WORKSPACE_INPUT", "unexpected admission fields");
    const { canonicalPath, volumeSerial, fileId } = input;
    // Validated before the idempotent return: a stored row in any other
    // encoding never equals decimal input, so it needs re-admission.
    if (
      !canonicalUnsigned(volumeSerial, 0xffff_ffffn) ||
      !canonicalUnsigned(fileId, 0xffff_ffff_ffff_ffffn)
    )
      throw new StoreError(
        "WORKSPACE_INPUT",
        "directory identity must be canonical decimal u32 volumeSerial and u64 fileId",
      );
    const displayName = workspaceDisplayName(canonicalPath);
    for (let attempt = 0; ; attempt += 1) {
      const currentId = this.currentWorkspaceIdForPath(canonicalPath);
      const current =
        currentId === null ? undefined : this.workspaceRecord(currentId);
      if (
        current !== undefined &&
        current.volumeSerial === volumeSerial &&
        current.fileId === fileId
      )
        return { ...current, canonicalPath };
      if (current !== undefined && !readmit)
        throw new StoreError(
          "WORKSPACE_IDENTITY_CHANGED",
          "directory identity changed at this path; re-admit is required",
        );
      const workspaceId = `ws-${randomUUID()}`;
      const now = new Date().toISOString();
      const record: AdmittedWorkspaceRecord = {
        schemaVersion: CONTRACT_VERSION,
        recordId: `${workspaceId}.admitted`,
        createdAt: now,
        scopeId: workspaceId,
        sourceIds: [],
        workspaceId,
        displayName,
        admittedAt: now,
        revision: String(Number(current?.revision ?? "0") + 1),
        volumeSerial,
        fileId,
      };
      try {
        this.commitBatch([{ kind: "admittedWorkspace", record }], [], caller, {
          workspaceAdmission: {
            canonicalPath,
            workspaceId,
            expectedCurrent: currentId,
          },
        });
        return { ...record, canonicalPath };
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof StoreError &&
          error.code === "WORKSPACE_ADMISSION_CHANGED"
        )
          continue;
        throw error;
      }
    }
  }

  /** Engine/native-only read (includes canonicalPath); project with workspaceView for the renderer. */
  getWorkspace(workspaceId: string): AdmittedWorkspace | undefined {
    this.assertOpen();
    try {
      const record = this.workspaceRecord(workspaceId);
      const path = this.workspacePath(workspaceId);
      return record === undefined || path === undefined
        ? undefined
        : { ...record, canonicalPath: path };
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /**
   * Engine/native-only: current admitted workspaces (includes canonicalPath),
   * excluding superseded and deleted ones, ordered by admittedAt then workspaceId.
   */
  listWorkspaces(): AdmittedWorkspace[] {
    this.assertOpen();
    if (!this.hasWorkspacePaths()) return [];
    try {
      return (
        this.db
          .prepare(
            "SELECT p.canonical_path, r.seq, r.kind, r.schema_version, r.payload FROM workspace_paths p " +
              "JOIN records r ON r.record_id = p.workspace_id || '.admitted' " +
              "WHERE p.rowid = (SELECT MAX(q.rowid) FROM workspace_paths q WHERE q.canonical_path = p.canonical_path) " +
              "AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.record_id = r.record_id)",
          )
          .all() as Array<{ canonical_path: string }>
      )
        .map((row) => ({
          ...(this.readRow(row).record as AdmittedWorkspaceRecord),
          canonicalPath: row.canonical_path,
        }))
        .sort((a, b) =>
          a.admittedAt < b.admittedAt
            ? -1
            : a.admittedAt > b.admittedAt
              ? 1
              : a.workspaceId < b.workspaceId
                ? -1
                : 1,
        );
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /** Renderer-safe listing: no path, no directory identity. */
  listWorkspaceViews(): WorkspaceView[] {
    return this.listWorkspaces().map(workspaceView);
  }

  /**
   * Mints a grant on a current admitted workspace. fs.read/fs.write/shell.run
   * require the Pi-derived session to already exist in this store.
   */
  mintGrant(input: GrantInput, caller: CallerContext): GrantRecord {
    this.assertWritable();
    if (
      !isRecordObject(input) ||
      Object.hasOwn(input, "consumedAt") ||
      Object.hasOwn(input, "revokedAt")
    )
      throw new StoreError("GRANT_INPUT", "grant input is invalid");
    const grantId = `grant-${randomUUID()}`;
    const record = {
      ...input,
      schemaVersion: CONTRACT_VERSION,
      recordId: grantId,
      createdAt: new Date().toISOString(),
      scopeId: input.workspaceId,
      sourceIds: [],
      grantId,
    } as GrantRecord;
    this.commitBatch([{ kind: "grant", record }], [], caller, {
      expectedGrantMint: input,
    });
    return record;
  }

  /**
   * Read-only check for a session grant at dispatch; same typed errors as consume.
   * Caller contract: this cannot verify `use.observedIdentity` under a lock, so native
   * dispatch MUST pass `observedIdentity` on every use (and once grants re-verify at consume).
   */
  requireGrant(use: GrantUse): GrantRecord {
    this.assertOpen();
    try {
      return this.checkGrant(use, "session");
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /**
   * Read-only check for a once grant around effect handoff. Accepts the grant
   * while unconsumed, or when it was consumed together with this action's
   * running receipt and that receipt is still the action's latest (so the
   * action's own consumption is not a replay). Every other state keeps the
   * typed errors of consume.
   */
  checkOnceGrantForActive(use: OnceGrantConsumption): GrantRecord {
    this.assertOpen();
    try {
      return this.checkGrant(use, "once", true);
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /**
   * Consumes a once grant in the SAME transaction as the action's
   * approved->running receipts: either both commit or neither does.
   */
  consumeOnceGrant(
    consumption: OnceGrantConsumption,
    receipts: readonly AppendInput[],
    caller: CallerContext,
    preconditions: EventPreconditions = {},
  ): AppendBatchResult {
    this.assertWritable();
    assertNoNativeOnlyKinds(receipts);
    if (receipts.some((input) => input.kind === "event"))
      throw new StoreError(
        "EVENT_COMMIT_REQUIRED",
        "event records require commitEvents",
      );
    const state = this.grantState(consumption.grantId);
    if (state === undefined)
      throw new StoreError("GRANT_REQUIRED", "no such grant; nothing appended");
    if (state.grant.scope !== "once")
      throw new StoreError(
        "GRANT_MISMATCH",
        "only a once grant can be consumed; nothing appended",
      );
    const now = new Date().toISOString();
    const consumed: GrantRecord = {
      ...state.grant,
      recordId: `${state.grant.grantId}.consumed`,
      createdAt: now,
      consumedAt: now,
    };
    const { seqs } = this.commitBatch(
      [...receipts, { kind: "grant", record: consumed }],
      [],
      caller,
      { ...preconditions, expectedOnceGrant: consumption },
    );
    return { seqs };
  }

  /** Revokes one grant (append-only `<grantId>.revoked`). */
  revokeGrant(grantId: string, caller: CallerContext): void {
    this.assertWritable();
    this.revokeGrants([grantId], caller);
  }

  /** Profile change: revokes every live net.provider grant on a workspace; returns the count. */
  revokeProviderGrants(workspaceId: string, caller: CallerContext): number {
    this.assertWritable();
    const ids = (
      this.db
        .prepare(
          "SELECT DISTINCT json_extract(payload, '$.grantId') AS id FROM records WHERE kind = 'grant' " +
            "AND json_extract(payload, '$.workspaceId') = ? AND json_extract(payload, '$.capability') = 'net.provider'",
        )
        .all(workspaceId) as Array<{ id: string }>
    )
      .map((row) => row.id)
      .filter((id) => this.grantState(id)?.revoked === false);
    if (ids.length > 0) this.revokeGrants(ids, caller);
    return ids.length;
  }

  /** Native/engine-only: the canonical URL of an endpoint at a pinned revision. */
  resolveEndpoint(
    scopeId: string,
    endpointRef: string,
    revision: string,
  ): string {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT seq, kind, schema_version, payload FROM records WHERE kind = 'providerEndpoint' AND scope_id = ? " +
          "AND json_extract(payload, '$.endpointId') = ? AND json_extract(payload, '$.revision') = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(scopeId, endpointRef, revision);
    if (row === undefined)
      throw new StoreError(
        "ENDPOINT_UNKNOWN",
        "no endpoint at that pinned revision",
      );
    return (this.readRow(row).record as ProviderEndpointRecord).canonicalUrl;
  }

  private revokeGrants(
    grantIds: readonly string[],
    caller: CallerContext,
  ): void {
    const now = new Date().toISOString();
    const inputs = grantIds.map((grantId) => {
      const state = this.grantState(grantId);
      if (state === undefined)
        throw new StoreError("GRANT_REQUIRED", "no such grant");
      const record: GrantRecord = {
        ...state.grant,
        recordId: `${grantId}.revoked`,
        createdAt: now,
        revokedAt: now,
      };
      return { kind: "grant" as const, record };
    });
    this.commitBatch(inputs, [], caller, { expectedActiveGrants: grantIds });
  }

  private currentWorkspaceIdForPath(canonicalPath: string): string | null {
    if (!this.hasWorkspacePaths()) return null;
    const row = this.db
      .prepare(
        "SELECT workspace_id FROM workspace_paths WHERE canonical_path = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(canonicalPath) as { workspace_id: string } | undefined;
    return row?.workspace_id ?? null;
  }

  private workspacePath(workspaceId: string): string | undefined {
    if (!this.hasWorkspacePaths()) return undefined;
    const row = this.db
      .prepare(
        "SELECT canonical_path FROM workspace_paths WHERE workspace_id = ?",
      )
      .get(workspaceId) as { canonical_path: string } | undefined;
    return row?.canonical_path;
  }

  /** Read-only opens of a pre-TD-13 store have no path table (nothing admitted). */
  private hasWorkspacePaths(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_paths'",
        )
        .get() !== undefined
    );
  }

  private workspaceRecord(
    workspaceId: string,
  ): AdmittedWorkspaceRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT seq, kind, schema_version, payload FROM records WHERE kind = 'admittedWorkspace' " +
          "AND json_extract(payload, '$.workspaceId') = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(workspaceId);
    return row === undefined
      ? undefined
      : (this.readRow(row).record as AdmittedWorkspaceRecord);
  }

  /** Fails unless the workspace was admitted natively and is not superseded. */
  private requireCurrentWorkspace(
    workspaceId: string,
    observed?: DirectoryIdentity,
  ): void {
    const record = this.workspaceRecord(workspaceId);
    const path = this.workspacePath(workspaceId);
    if (record === undefined || path === undefined)
      throw new StoreError(
        "WORKSPACE_NOT_ADMITTED",
        "workspace was not admitted by the native write path",
      );
    if (
      this.currentWorkspaceIdForPath(path) !== workspaceId ||
      (observed !== undefined &&
        (observed.volumeSerial !== record.volumeSerial ||
          observed.fileId !== record.fileId))
    )
      throw new StoreError(
        "WORKSPACE_IDENTITY_CHANGED",
        "workspace directory identity changed; re-admit is required",
      );
  }

  /** Folds a grant's append-only history: the mint plus any consumed/revoked revisions. */
  private grantState(
    grantId: string,
  ):
    | { grant: GrantRecord; consumedSeq: number | undefined; revoked: boolean }
    | undefined {
    const history = this.db
      .prepare(
        "SELECT seq, kind, schema_version, payload FROM records WHERE kind = 'grant' " +
          "AND json_extract(payload, '$.grantId') = ? ORDER BY seq ASC",
      )
      .all(grantId)
      .map((row) => {
        const { seq, record } = this.readRow(row);
        return { seq, record: record as GrantRecord };
      });
    const grant = history.find(({ record }) => record.recordId === grantId);
    if (grant === undefined) return undefined;
    return {
      grant: grant.record,
      consumedSeq: history.find(({ record }) => record.consumedAt !== undefined)
        ?.seq,
      revoked: history.some(({ record }) => record.revokedAt !== undefined),
    };
  }

  /** True when the consumption committed with this action's running receipt and nothing followed it. */
  private consumedByActiveAction(consumedSeq: number, use: GrantUse): boolean {
    const row = this.db
      .prepare(
        "SELECT seq, kind, schema_version, payload FROM records WHERE kind = 'action' " +
          "AND json_extract(payload, '$.actionId') = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(use.actionId ?? null);
    if (row === undefined) return false;
    const latest = this.readRow(row);
    const action = latest.record as ActionRecord;
    return (
      latest.seq < consumedSeq &&
      action.state === "running" &&
      action.argumentsDigest === use.argumentsDigest
    );
  }

  private checkGrant(
    use: GrantUse,
    scope: GrantRecord["scope"],
    active = false,
  ): GrantRecord {
    const state = this.grantState(use.grantId);
    if (state === undefined)
      throw new StoreError("GRANT_REQUIRED", "no such grant; nothing appended");
    if (state.revoked)
      throw new StoreError(
        "GRANT_REVOKED",
        "grant was revoked; nothing appended",
      );
    if (
      state.consumedSeq !== undefined &&
      !(active && this.consumedByActiveAction(state.consumedSeq, use))
    )
      throw new StoreError(
        "GRANT_CONSUMED",
        "once grant was already consumed; nothing appended",
      );
    const { grant } = state;
    if (
      grant.scope !== scope ||
      grant.workspaceId !== use.workspaceId ||
      grant.sessionId !== use.sessionId ||
      grant.capability !== use.capability ||
      grant.actionId !== use.actionId ||
      grant.argumentsDigest !== use.argumentsDigest ||
      grant.origin !== use.origin
    )
      throw new StoreError(
        "GRANT_MISMATCH",
        "grant does not match this workspace, session, capability or action; nothing appended",
      );
    this.requireCurrentWorkspace(grant.workspaceId, use.observedIdentity);
    return grant;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (error) {
      throw mapSqliteError(error);
    }
  }
}
