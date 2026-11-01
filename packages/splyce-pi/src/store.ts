// TD-09: physical authoritative store (J0). Built-in `node:sqlite` adapter per
// the TD-03 store-qualification selection (fallback: better-sqlite3 13.0.3,
// never both). Single authority for operational receipts; everything else is a
// rebuildable projection. Erasable-syntax-only (runs under Node type stripping).

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  lstatSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ActionRecord,
  type AdmittedWorkspaceRecord,
  CONTRACT_VERSION,
  type ContractContext,
  ContractError,
  type GrantRecord,
  PROTOCOL_VERSION,
  type ProviderEndpointRecord,
  RECORD_SCHEMAS,
  type RecordByKind,
  type RecordKind,
  type SplyceEvent,
  type SplyceEventDraft,
  originView,
  snapshotPersistedJson,
  validateEvent,
  validateRecord,
} from "./contracts.js";
import {
  type SetupInput,
  SetupMetadataError,
  type TrustedCatalog,
  validateSetupMetadata,
} from "./setup-metadata.js";

export type {
  SetupInput,
  SetupMetadata,
  TrustedCatalog,
  TrustedCatalogEntry,
} from "./setup-metadata.js";

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
  /** Native-supplied pinned model catalog; only it can vouch for a `catalog` model descriptor. */
  trustedCatalog?: TrustedCatalog;
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
  /** Compare-and-set on the scope's record cursor (recovery fenced writes). */
  expectedScopeCursor?: { scopeId: string; seq: number };
  /** Compare-and-set on one session's record cursor (recovery fenced writes). */
  expectedSessionCursor?: {
    scopeId: string;
    sessionId: string;
    seq: number;
  };
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

export interface SetupResult {
  endpoint: RecordByKind["providerEndpoint"];
  connection: RecordByKind["providerConnection"];
  profile: RecordByKind["profileSnapshot"];
}

export type NativeSessionSetupCommand = "profile.select" | "session.start";
export interface NativeSessionSetupRequest {
  requestId: string;
  workspaceId: string;
  profileId: string;
  expectedConfigRevision: string;
  expectedProfileRevision?: string;
}
export interface NativeSetupBinding {
  binding: NonNullable<RecordByKind["profileSnapshot"]["bindings"]>[number];
  connection: RecordByKind["providerConnection"];
  endpoint: RecordByKind["providerEndpoint"];
  descriptorArtifact: RecordByKind["artifact"] | null;
}
export interface NativeProfileSelectionResult {
  selectedProfileId: string;
  profileRevision: string;
  configRevision: string;
}
export interface NativeSessionStartResult {
  sessionId: string;
  sessionRevision: string;
  policyRevision: string;
  readiness: { state: "unavailable"; code?: "SESSION_BIND_FAILED" };
}
export type NativeBranchAnchor = Pick<
  RecordByKind["branchAnchor"],
  | "branchAnchorId"
  | "piSessionId"
  | "parentAnchorId"
  | "forkPointEntryId"
  | "firstChildEntryId"
  | "activeLeafEntryId"
>;
export interface NativeSessionSetupCommit<
  T = NativeProfileSelectionResult | NativeSessionStartResult,
> {
  result: T;
  workspaceId: string;
  profileId: string;
  profileRevision: string;
  configRevision: string;
  bindings: readonly NativeSetupBinding[];
  grantIds: readonly string[];
  replayed: boolean;
  branchAnchor?: NativeBranchAnchor;
}
type NativeSetupStoredCommit = NativeSessionSetupCommit<
  | NativeProfileSelectionResult
  | Omit<NativeSessionStartResult, "policyRevision">
>;

export interface NativeSessionSetupPreparation {
  command: NativeSessionSetupCommand;
  request: Readonly<NativeSessionSetupRequest>;
  workspace: AdmittedWorkspace;
  profile: RecordByKind["profileSnapshot"];
  bindings: readonly NativeSetupBinding[];
  origins: readonly string[];
  replay?: NativeSetupStoredCommit;
}
interface NativeSetupReceipt {
  version: 1;
  command: NativeSessionSetupCommand;
  request: NativeSessionSetupRequest;
  profileRecordId: string;
  bindingRefs: {
    role: string;
    connectionRecordId: string;
    endpointRecordId: string;
    descriptorRecordId: string | null;
  }[];
  configRevision: string;
  sessionId: string | null;
  anchorRecordId: string | null;
  grantIds: string[];
}
interface NativeSetupAuthority {
  workspace: AdmittedWorkspace;
  profile: RecordByKind["profileSnapshot"];
  bindings: NativeSetupBinding[];
  origins: string[];
  fingerprint: string;
  revokedGrants: GrantRecord[];
}
interface NativeSetupCapture {
  command: NativeSessionSetupCommand;
  request: NativeSessionSetupRequest;
  authority: NativeSetupAuthority;
}
interface SetupState {
  records: {
    seq: number;
    kind: RecordKind;
    record: RecordByKind[RecordKind] & Record<string, unknown>;
  }[];
  deletedRecordIds: string[];
  workspace: AdmittedWorkspace | null;
  deletionEpoch: number;
  configRevision: string;
}
const NATIVE_SETUP_MEDIA = "application/vnd.splyce.native-session-setup+json";
const NATIVE_SETUP_FAILED_MEDIA =
  "application/vnd.splyce.native-session-unavailable+json";
function nativeSetupInvalid(code = "SETUP_INVALID"): never {
  throw new StoreError(code, "Native setup unavailable");
}
function nativeSetupId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.isWellFormed() &&
    value.length > 0 &&
    new TextEncoder().encode(value).length <= 128 &&
    !/[\s\p{Cc}\p{Cf}/\\]/u.test(value)
  );
}
function nativeSetupRequest(
  command: NativeSessionSetupCommand,
  input: unknown,
): NativeSessionSetupRequest {
  const keys = [
    "requestId",
    "workspaceId",
    "profileId",
    "expectedConfigRevision",
    ...(command === "profile.select" ? ["expectedProfileRevision"] : []),
  ];
  if (
    (command !== "profile.select" && command !== "session.start") ||
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    nativeSetupInvalid();
  const captured: Record<string, string> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      !nativeSetupId(descriptor.value)
    )
      nativeSetupInvalid();
    captured[key] = descriptor.value;
  }
  return captured as unknown as NativeSessionSetupRequest;
}
function nativeSetupDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function nativeSetupKey(requestId: string): string {
  return `native-session-setup:${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
}
function nativeSetupFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) nativeSetupFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class Store {
  readonly path: string;
  /** @internal the underlying SQLite handle; reassigned only by restore(). */
  db: DatabaseSync;
  private guard: DatabaseSync | undefined;
  private readonly busyTimeoutMs: number;
  private readonly maxInlineBytes: number;
  /** @internal closed flag; reset only by restore(). */
  closed = false;
  private readonly nativeSetupCaptures = new WeakMap<
    NativeSessionSetupPreparation,
    NativeSetupCapture
  >();

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
    const writer = Store.writerGuard(path, 5000);
    try {
      Store.migrateLocked(writer.path, attribution);
    } finally {
      writer.guard.close();
    }
  }

  private static migrateLocked(
    path: string,
    attribution?: { sessionId: string },
  ): void {
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
    if (options.readOnly === true || path === ":memory:")
      return Store.openDatabase(path, options);
    const writer = Store.writerGuard(path, options.busyTimeoutMs ?? 5000);
    try {
      const store = Store.openDatabase(writer.path, options);
      store.guard = writer.guard;
      return store;
    } catch (error) {
      writer.guard.close();
      throw error;
    }
  }

  private static writerGuard(
    path: string,
    timeout: number,
  ): { path: string; guard: DatabaseSync } {
    let guard: DatabaseSync | undefined;
    try {
      path = lstatSync(path, { throwIfNoEntry: false })
        ? realpathSync.native(path)
        : join(realpathSync.native(dirname(resolve(path))), basename(path));
      const lockPath = path + ".restore-lock";
      if (lstatSync(lockPath, { throwIfNoEntry: false })?.isSymbolicLink())
        throw new StoreError("STORE_RESTORE_LOCK", "ambiguous lock path");
      guard = new DatabaseSync(lockPath, { timeout });
      if (statSync(lockPath).nlink !== 1)
        throw new StoreError("STORE_RESTORE_LOCK", "ambiguous lock identity");
      Store.holdWriter(guard);
      Store.assertStorePath(path);
      return { path, guard };
    } catch (error) {
      guard?.close();
      throw mapSqliteError(error);
    }
  }

  // An empty rollback-mode SQLite file supplies OS-backed, cross-process reader/writer
  // locks. Never remove it: a second inode would split the admission domain.
  private static holdWriter(guard: DatabaseSync): void {
    if (
      (
        guard.prepare("PRAGMA journal_mode").get() as
          { journal_mode?: string } | undefined
      )?.journal_mode !== "delete"
    )
      throw new StoreError(
        "STORE_RESTORE_LOCK",
        "restore lock mode is ambiguous",
      );
    guard.exec("BEGIN; SELECT rootpage FROM sqlite_schema;");
  }

  private static assertStorePath(path: string): void {
    if (
      existsSync(path)
        ? statSync(path).nlink !== 1
        : existsSync(path + ".restore-original")
    )
      throw new StoreError(
        "STORE_RESTORE_LOCK",
        "ambiguous live store identity or recovery state",
      );
  }

  private static openDatabase(path: string, options: StoreOptions = {}): Store {
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

  /**
   * Native-only: everything setup needs from one scope, observed in ONE read
   * transaction. `workspace` is the current admitted workspace (private
   * canonicalPath and directory identity) or null if superseded/deleted/unknown.
   */
  readSetupState(workspaceId: string): SetupState {
    this.assertOpen();
    try {
      this.db.exec("BEGIN;");
      try {
        const state = this.readSetupStateLocked(workspaceId);
        this.db.exec("COMMIT;");
        return state;
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
        throw error;
      }
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /** Caller owns the SQLite observation/commit transaction. */
  private readSetupStateLocked(workspaceId: string): SetupState {
    const kinds = [
      "providerEndpoint",
      "providerConnection",
      "profileSnapshot",
      "artifact",
      "configurationTransition",
      "admittedWorkspace",
    ];
    const rows = this.db
      .prepare(
        "SELECT r.*, d.record_id AS deleted_record_id, d.generation, d.deleted_at, " +
          "(SELECT value FROM store_meta WHERE key = 'deletion_epoch') AS deletion_epoch " +
          "FROM records r LEFT JOIN deletions d ON d.record_id = r.record_id " +
          `WHERE r.scope_id = ? AND r.kind IN (${kinds.map(() => "?").join(",")}) ORDER BY r.seq`,
      )
      .all(workspaceId, ...kinds) as Array<
      Parameters<Store["validateStructuralRow"]>[0] & {
        deleted_record_id: string | null;
        generation: number | null;
        deleted_at: string | null;
        deletion_epoch: string | null;
      }
    >;
    const records: SetupState["records"] = [];
    const deletedRecordIds: string[] = [];
    for (const row of rows) {
      const record = this.validateStructuralRow(row);
      if (row.deleted_record_id !== null) {
        const epoch =
          Store.parseEpoch(row.deletion_epoch ?? undefined, "deletion_epoch") ??
          0;
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
      records.push({
        seq: row.seq,
        kind: row.kind,
        record: record as RecordByKind[RecordKind] & Record<string, unknown>,
      });
    }
    const workspace = this.currentWorkspace(workspaceId) ?? null;
    const deletionEpoch = this.deletionEpoch();
    const configRevision = Store.readConfigRevision(this.db, workspaceId);
    return {
      records,
      deletedRecordIds,
      workspace,
      deletionEpoch,
      configRevision,
    };
  }

  /** Native owner captures this before awaiting credential presence; the proof cannot be cloned. */
  prepareNativeSessionSetup(
    command: NativeSessionSetupCommand,
    input: unknown,
  ): NativeSessionSetupPreparation {
    this.assertOpen();
    const request = nativeSetupRequest(command, input);
    try {
      this.db.exec("BEGIN;");
      try {
        const workspace = this.currentWorkspace(request.workspaceId);
        if (!workspace) nativeSetupInvalid("WORKSPACE_SUPERSEDED");
        const receipt = this.nativeSetupReceipt(
          nativeSetupKey(request.requestId) + ":request",
        );
        if (
          receipt &&
          (receipt.command !== command ||
            JSON.stringify(receipt.request) !== JSON.stringify(request))
        )
          nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
        const replay = receipt
          ? this.nativeSetupReplay(receipt, true)
          : undefined;
        const authority = receipt
          ? {
              workspace,
              profile: this.nativeSetupRecord(
                receipt.profileRecordId,
                request.workspaceId,
                "profileSnapshot",
              ).record as RecordByKind["profileSnapshot"],
              bindings: [...replay!.bindings],
              origins: [
                ...new Set(
                  replay!.bindings.map(({ endpoint }) => originView(endpoint)),
                ),
              ].sort(),
              fingerprint: "",
              revokedGrants: [],
            }
          : this.nativeSetupAuthority(command, request);
        const preparation: NativeSessionSetupPreparation = nativeSetupFreeze({
          command,
          request: { ...request },
          workspace: structuredClone(authority.workspace),
          profile: structuredClone(authority.profile),
          bindings: structuredClone(authority.bindings),
          origins: [...authority.origins],
          ...(replay ? { replay: structuredClone(replay) } : {}),
        });
        this.nativeSetupCaptures.set(preparation, {
          command,
          request,
          authority,
        });
        this.db.exec("COMMIT;");
        return preparation;
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
        throw error;
      }
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  commitNativeProfileSelection(
    preparation: NativeSessionSetupPreparation,
    caller: CallerContext,
  ): NativeSessionSetupCommit<NativeProfileSelectionResult> {
    if (this.nativeSetupCaptures.get(preparation)?.command !== "profile.select")
      nativeSetupInvalid();
    return this.commitNativeSessionSetup(
      preparation,
      undefined,
      caller,
    ) as NativeSessionSetupCommit<NativeProfileSelectionResult>;
  }

  commitNativeSessionStart(
    preparation: NativeSessionSetupPreparation,
    prepared:
      { piSessionId: string; branchAnchor: NativeBranchAnchor } | undefined,
    caller: CallerContext,
    currentPolicyRevision: (workspaceId: string) => string,
  ): NativeSessionSetupCommit<NativeSessionStartResult> {
    if (this.nativeSetupCaptures.get(preparation)?.command !== "session.start")
      nativeSetupInvalid();
    return this.commitNativeSessionSetup(
      preparation,
      prepared,
      caller,
      currentPolicyRevision,
    ) as NativeSessionSetupCommit<NativeSessionStartResult>;
  }

  private nativeSetupRecord(
    recordId: string,
    scopeId: string,
    kind: RecordKind,
  ): StoredRecord {
    const row = this.db
      .prepare("SELECT * FROM records WHERE record_id = ?")
      .get(recordId) as
      Parameters<Store["validateStructuralRow"]>[0] | undefined;
    if (
      !row ||
      row.kind !== kind ||
      row.scope_id !== scopeId ||
      this.db
        .prepare("SELECT 1 FROM deletions WHERE record_id = ?")
        .get(recordId)
    )
      nativeSetupInvalid("STALE_REVISION");
    return {
      seq: Number(row.seq),
      kind,
      record: this.validateStructuralRow(row),
    };
  }

  private nativeSetupReceipt(recordId: string): NativeSetupReceipt | undefined {
    const row = this.db
      .prepare("SELECT * FROM records WHERE record_id = ?")
      .get(recordId) as
      Parameters<Store["validateStructuralRow"]>[0] | undefined;
    if (!row) {
      if (
        this.db
          .prepare("SELECT 1 FROM deletions WHERE record_id = ?")
          .get(recordId)
      )
        nativeSetupInvalid("SETUP_DELETED");
      return undefined;
    }
    if (
      this.db
        .prepare("SELECT 1 FROM deletions WHERE record_id = ?")
        .get(recordId)
    )
      nativeSetupInvalid("SETUP_DELETED");
    const record = this.validateStructuralRow(row) as unknown as Record<
      string,
      unknown
    >;
    const body = record.nativeSetup as NativeSetupReceipt | undefined;
    if (
      row.kind !== "artifact" ||
      record.artifactId !== recordId ||
      record.mediaType !== NATIVE_SETUP_MEDIA ||
      record.retentionClass !== "workspace" ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).sort().join(",") !==
        "anchorRecordId,bindingRefs,command,configRevision,grantIds,profileRecordId,request,sessionId,version" ||
      body.version !== 1 ||
      !nativeSetupId(body.profileRecordId) ||
      !nativeSetupId(body.configRevision) ||
      !Array.isArray(body.bindingRefs) ||
      !Array.isArray(body.grantIds) ||
      !body.grantIds.every(nativeSetupId) ||
      new Set(body.grantIds).size !== body.grantIds.length ||
      (body.command !== "profile.select" && body.command !== "session.start")
    )
      nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
    const request = nativeSetupRequest(body.command, body.request);
    if (
      JSON.stringify(request) !== JSON.stringify(body.request) ||
      record.scopeId !== request.workspaceId ||
      recordId !== nativeSetupKey(request.requestId) + ":request" ||
      record.digest !== nativeSetupDigest(body) ||
      record.byteLength !==
        new TextEncoder().encode(JSON.stringify(body)).length ||
      (body.command === "profile.select"
        ? body.sessionId !== null ||
          body.anchorRecordId !== null ||
          body.grantIds.length !== 0
        : !nativeSetupId(body.sessionId) || !nativeSetupId(body.anchorRecordId))
    )
      nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
    for (const ref of body.bindingRefs) {
      if (
        !ref ||
        typeof ref !== "object" ||
        Object.keys(ref).sort().join(",") !==
          "connectionRecordId,descriptorRecordId,endpointRecordId,role" ||
        !nativeSetupId(ref.role) ||
        !nativeSetupId(ref.connectionRecordId) ||
        !nativeSetupId(ref.endpointRecordId) ||
        (ref.descriptorRecordId !== null &&
          !nativeSetupId(ref.descriptorRecordId))
      )
        nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
    }
    return body;
  }

  private nativeSetupArtifactReference(
    state: SetupState,
    scopeId: string,
    id: string,
  ): StoredRecord {
    // Count the full history before checking liveness: a deleted alias must not fall back.
    const matches = state.records.filter(
      ({ kind, record }) =>
        kind === "artifact" &&
        record.scopeId === scopeId &&
        (record.artifactId === id || record.recordId === id),
    );
    const exact = this.db
      .prepare("SELECT kind FROM records WHERE scope_id = ? AND record_id = ?")
      .get(scopeId, id) as { kind: string } | undefined;
    const match = matches[0];
    if (
      matches.length !== 1 ||
      !match ||
      (exact && exact.kind !== "artifact") ||
      state.deletedRecordIds.includes(match.record.recordId)
    )
      nativeSetupInvalid("STALE_REVISION");
    return match;
  }

  private nativeSetupBindings(
    profile: RecordByKind["profileSnapshot"],
    state: SetupState,
    latest: boolean,
  ): NativeSetupBinding[] {
    if (!profile.bindings?.length) nativeSetupInvalid();
    const deleted = new Set(state.deletedRecordIds);
    const live = (row: StoredRecord | undefined): StoredRecord => {
      if (!row || deleted.has(row.record.recordId))
        nativeSetupInvalid("STALE_REVISION");
      return row;
    };
    const referenced = (id: string) =>
      this.nativeSetupArtifactReference(state, profile.scopeId, id);
    for (const ref of [profile.limitsArtifactId, ...profile.egressPolicyRefs]) {
      if (referenced(ref).kind !== "artifact") nativeSetupInvalid();
    }
    return profile.bindings.map((binding) => {
      if (typeof binding.modelId !== "string") nativeSetupInvalid();
      const connections = state.records.filter(
        ({ kind, record }) =>
          kind === "providerConnection" &&
          record.providerConnectionId === binding.providerConnectionId,
      );
      const connectionRow = live(
        latest
          ? connections.at(-1)
          : connections.find(
              ({ record }) => record.revision === binding.connectionRevision,
            ),
      );
      const connection =
        connectionRow.record as RecordByKind["providerConnection"];
      if (
        connection.revision !== binding.connectionRevision ||
        connections.filter(
          ({ record }) => record.revision === binding.connectionRevision,
        ).length !== 1 ||
        referenced(connection.accountScopeRef).kind !== "artifact"
      )
        nativeSetupInvalid("STALE_REVISION");
      const separator = connection.endpointRef.lastIndexOf("@");
      if (separator < 1) nativeSetupInvalid();
      const endpointId = connection.endpointRef.slice(0, separator),
        revision = connection.endpointRef.slice(separator + 1);
      const endpoints = state.records.filter(
        ({ kind, record }) =>
          kind === "providerEndpoint" && record.endpointId === endpointId,
      );
      const endpoint = live(
        latest
          ? endpoints.at(-1)
          : endpoints.find(({ record }) => record.revision === revision),
      ).record as RecordByKind["providerEndpoint"];
      if (
        endpoint.revision !== revision ||
        endpoints.filter(({ record }) => record.revision === revision)
          .length !== 1 ||
        endpoint.apiFamily !== connection.apiFamily ||
        (endpoint.locality === "loopback"
          ? connection.locality !== "local"
          : connection.locality !== "hosted")
      )
        nativeSetupInvalid("STALE_REVISION");
      const descriptors = state.records.filter(
        ({ kind, record }) =>
          kind === "artifact" &&
          profile.sourceIds.includes(record.recordId) &&
          record.mediaType === "application/vnd.splyce.model-descriptor+json" &&
          record.role === binding.role &&
          record.modelId === binding.modelId,
      );
      if (binding.role === "chat" && descriptors.length !== 1)
        nativeSetupInvalid();
      if (descriptors.length > 1) nativeSetupInvalid();
      const descriptorArtifact = descriptors.length
        ? (live(descriptors[0]).record as RecordByKind["artifact"])
        : null;
      if (descriptorArtifact) {
        const descriptor = (
          descriptorArtifact as RecordByKind["artifact"] &
            Record<string, unknown>
        ).descriptor as Record<string, unknown> | undefined;
        if (
          !descriptor ||
          typeof descriptor !== "object" ||
          Array.isArray(descriptor) ||
          !["catalog", "user"].includes(String(descriptor.source)) ||
          !Number.isSafeInteger(descriptor.contextWindow) ||
          Number(descriptor.contextWindow) < 1 ||
          Number(descriptor.contextWindow) > 2 ** 21 ||
          !Number.isSafeInteger(descriptor.maxOutputTokens) ||
          Number(descriptor.maxOutputTokens) < 1 ||
          Number(descriptor.maxOutputTokens) >
            Number(descriptor.contextWindow) ||
          typeof descriptor.reasoning !== "boolean" ||
          typeof descriptor.costKnown !== "boolean" ||
          (descriptor.source === "user" && descriptor.costKnown !== false) ||
          (descriptor.source === "catalog"
            ? !nativeSetupId(descriptor.catalogVersion)
            : Object.hasOwn(descriptor, "catalogVersion")) ||
          Object.keys(descriptor).sort().join(",") !==
            [
              "source",
              "contextWindow",
              "maxOutputTokens",
              "reasoning",
              "input",
              "costKnown",
              ...(descriptor.source === "catalog" ? ["catalogVersion"] : []),
            ]
              .sort()
              .join(",") ||
          Number(descriptor.maxOutputTokens) > 2 ** 20 ||
          !Array.isArray(descriptor.input) ||
          descriptor.input.length === 0 ||
          !descriptor.input.every(
            (item) => item === "text" || item === "image",
          ) ||
          new Set(descriptor.input).size !== descriptor.input.length ||
          descriptorArtifact.digest !== nativeSetupDigest(descriptor) ||
          descriptorArtifact.byteLength !==
            new TextEncoder().encode(JSON.stringify(descriptor)).length
        )
          nativeSetupInvalid();
      }
      return { binding, connection, endpoint, descriptorArtifact };
    });
  }

  private nativeProviderGrants(
    workspaceId: string,
    includeReads = false,
  ): GrantRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM records WHERE scope_id = ? AND kind = 'grant' ORDER BY seq",
      )
      .all(workspaceId) as Parameters<Store["validateStructuralRow"]>[0][];
    const minted = new Map<string, GrantRecord>(),
      revoked = new Set<string>();
    for (const row of rows) {
      const grant = this.validateStructuralRow(row) as GrantRecord;
      if (
        grant.workspaceId !== workspaceId ||
        !(
          grant.capability === "net.provider" ||
          (includeReads && grant.capability === "fs.read")
        )
      )
        continue;
      if (grant.recordId === grant.grantId) minted.set(grant.grantId, grant);
      // Match dispatch's append-only grant fold: a tombstone alone does not revoke authority.
      if (grant.revokedAt !== undefined) revoked.add(grant.grantId);
    }
    return [...minted.values()]
      .filter((grant) => !revoked.has(grant.grantId))
      .sort((a, b) => a.grantId.localeCompare(b.grantId));
  }

  private nativeSetupAuthority(
    command: NativeSessionSetupCommand,
    request: NativeSessionSetupRequest,
  ): NativeSetupAuthority {
    const state = this.readSetupStateLocked(request.workspaceId);
    if (!state.workspace) nativeSetupInvalid("WORKSPACE_SUPERSEDED");
    const transitions = state.records.filter(
      ({ kind, record }) =>
        kind === "configurationTransition" && record.state === "applied",
    );
    const latestConfig = transitions.at(-1);
    const selected = transitions.findLast(
      ({ record }) =>
        typeof record.profileId === "string" &&
        typeof record.profileRevision === "string",
    );
    if (
      [latestConfig, selected].some(
        (row) => row && state.deletedRecordIds.includes(row.record.recordId),
      )
    )
      nativeSetupInvalid("STALE_REVISION");
    const configRevision = latestConfig
      ? String(latestConfig.record.acceptedConfigRevision)
      : INITIAL_CONFIG_REVISION;
    if (configRevision !== request.expectedConfigRevision)
      nativeSetupInvalid("STALE_REVISION");
    const profileRow = state.records
      .filter(
        ({ kind, record }) =>
          kind === "profileSnapshot" && record.profileId === request.profileId,
      )
      .at(-1);
    if (
      !profileRow ||
      state.deletedRecordIds.includes(profileRow.record.recordId)
    )
      nativeSetupInvalid("STALE_REVISION");
    const profile = profileRow.record as RecordByKind["profileSnapshot"];
    if (
      command === "profile.select"
        ? profile.profileRevision !== request.expectedProfileRevision
        : selected?.record.profileId !== profile.profileId ||
          selected.record.profileRevision !== profile.profileRevision
    )
      nativeSetupInvalid("STALE_REVISION");
    const bindings = this.nativeSetupBindings(profile, state, true);
    const grants = this.nativeProviderGrants(request.workspaceId);
    const receipts = this.db
      .prepare(
        "SELECT record_id FROM records WHERE scope_id = ? AND kind = 'artifact' AND json_extract(payload, '$.mediaType') = ? ORDER BY seq",
      )
      .all(request.workspaceId, NATIVE_SETUP_MEDIA) as { record_id: string }[];
    const sessions = receipts
      .filter(
        ({ record_id }) =>
          !this.db
            .prepare("SELECT 1 FROM deletions WHERE record_id = ?")
            .get(record_id),
      )
      .map(({ record_id }) => this.nativeSetupReceipt(record_id)!)
      .filter((receipt) => receipt.command === "session.start");
    const sessionProfiles = grants.map((grant) => {
      const receipt = sessions.find(
        (entry) => entry.sessionId === grant.sessionId,
      );
      const boundProfile =
        receipt && !state.deletedRecordIds.includes(receipt.profileRecordId)
          ? (state.records.find(
              ({ record }) => record.recordId === receipt.profileRecordId,
            )?.record as RecordByKind["profileSnapshot"] | undefined)
          : undefined;
      return {
        grant,
        profileId: boundProfile?.profileId ?? null,
        profileRevision: boundProfile?.profileRevision ?? null,
      };
    });
    const descriptorRefs = [
      ...new Set([
        profile.limitsArtifactId,
        ...profile.egressPolicyRefs,
        ...bindings.map(({ connection }) => connection.accountScopeRef),
      ]),
    ].map((id) =>
      this.nativeSetupArtifactReference(state, profile.scopeId, id),
    );
    const fingerprint = JSON.stringify({
      workspace: state.workspace,
      profile: profileRow,
      latestConfig,
      selected,
      bindings,
      descriptorRefs,
      sessionProfiles,
      grantDeletions: this.db
        .prepare(
          "SELECT d.record_id FROM deletions d JOIN records r ON r.record_id = d.record_id WHERE r.scope_id = ? AND r.kind = 'grant' ORDER BY d.record_id",
        )
        .all(request.workspaceId),
    });
    return {
      workspace: state.workspace,
      profile,
      bindings,
      origins: [
        ...new Set(bindings.map(({ endpoint }) => originView(endpoint))),
      ].sort(),
      fingerprint,
      revokedGrants: sessionProfiles
        .filter(
          (entry) =>
            entry.profileId !== profile.profileId ||
            entry.profileRevision !== profile.profileRevision,
        )
        .map(({ grant }) => grant),
    };
  }

  private nativeSetupArtifact(
    recordId: string,
    scopeId: string,
    mediaType: string,
    field: string,
    body: unknown,
  ): AppendInput {
    return {
      kind: "artifact",
      record: {
        schemaVersion: CONTRACT_VERSION,
        recordId,
        createdAt: new Date().toISOString(),
        scopeId,
        sourceIds: [],
        artifactId: recordId,
        mediaType,
        retentionClass: "workspace",
        digest: nativeSetupDigest(body),
        byteLength: new TextEncoder().encode(JSON.stringify(body)).length,
        [field]: body,
      },
    };
  }

  private nativeSetupCaller(
    caller: CallerContext,
    workspaceId: string,
    staged: Set<string>,
    sessionId = caller.sessionId,
  ): CallerContext {
    return {
      sessionId,
      configRevision: caller.configRevision,
      profileRevision: caller.profileRevision,
      policyRevision: caller.policyRevision,
      resolveReference: (id, scopeId) =>
        scopeId === workspaceId &&
        (staged.has(id) ||
          this.db
            .prepare(
              "SELECT 1 FROM records r WHERE scope_id = ? AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.record_id = r.record_id) AND " +
                "(record_id = ? OR json_extract(payload, '$.workspaceId') = ? OR json_extract(payload, '$.piSessionId') = ? OR json_extract(payload, '$.branchAnchorId') = ?) LIMIT 1",
            )
            .get(workspaceId, id, id, id, id) !== undefined),
    };
  }

  private nativeSetupFailed(
    receipt: NativeSetupReceipt,
    sessionRevision: string,
  ): boolean {
    const recordId = nativeSetupKey(receipt.request.requestId) + ":unavailable";
    const row = this.db
      .prepare("SELECT * FROM records WHERE record_id = ?")
      .get(recordId) as
      Parameters<Store["validateStructuralRow"]>[0] | undefined;
    if (!row) return false;
    const record = this.nativeSetupRecord(
      recordId,
      receipt.request.workspaceId,
      "artifact",
    ).record as RecordByKind["artifact"] & Record<string, unknown>;
    const expected = {
      sessionId: receipt.sessionId,
      sessionRevision,
      code: "SESSION_BIND_FAILED",
    };
    if (
      record.artifactId !== recordId ||
      record.mediaType !== NATIVE_SETUP_FAILED_MEDIA ||
      JSON.stringify(record.unavailable) !== JSON.stringify(expected) ||
      record.digest !== nativeSetupDigest(expected) ||
      record.byteLength !==
        new TextEncoder().encode(JSON.stringify(expected)).length
    )
      nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
    return true;
  }

  private nativeSetupReplay(
    receipt: NativeSetupReceipt,
    replayed: boolean,
  ): NativeSetupStoredCommit {
    const workspaceId = receipt.request.workspaceId;
    const state = this.readSetupStateLocked(workspaceId);
    const profile = this.nativeSetupRecord(
      receipt.profileRecordId,
      workspaceId,
      "profileSnapshot",
    ).record as RecordByKind["profileSnapshot"];
    if (profile.profileId !== receipt.request.profileId)
      nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
    const bindings = this.nativeSetupBindings(profile, state, false);
    const refs = bindings.map(
      ({ binding, connection, endpoint, descriptorArtifact }) => ({
        role: binding.role,
        connectionRecordId: connection.recordId,
        endpointRecordId: endpoint.recordId,
        descriptorRecordId: descriptorArtifact?.recordId ?? null,
      }),
    );
    if (JSON.stringify(refs) !== JSON.stringify(receipt.bindingRefs))
      nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
    const common = {
      workspaceId,
      profileId: profile.profileId,
      profileRevision: profile.profileRevision,
      configRevision: receipt.configRevision,
      bindings,
      grantIds: receipt.grantIds,
      replayed,
    };
    if (receipt.command === "profile.select") {
      const transition = this.nativeSetupRecord(
        nativeSetupKey(receipt.request.requestId) + ":applied",
        workspaceId,
        "configurationTransition",
      ).record as RecordByKind["configurationTransition"];
      if (
        transition.state !== "applied" ||
        transition.acceptedConfigRevision !== receipt.configRevision ||
        transition.expectedConfigRevision !==
          receipt.request.expectedConfigRevision ||
        transition.profileId !== profile.profileId ||
        transition.profileRevision !== profile.profileRevision
      )
        nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
      return {
        ...common,
        result: {
          selectedProfileId: profile.profileId,
          profileRevision: profile.profileRevision,
          configRevision: receipt.configRevision,
        },
      };
    }
    const anchorRow = this.nativeSetupRecord(
      receipt.anchorRecordId!,
      workspaceId,
      "branchAnchor",
    );
    const anchor = anchorRow.record as RecordByKind["branchAnchor"];
    const attribution = this.db
      .prepare("SELECT session_id FROM records WHERE record_id = ?")
      .get(anchor.recordId) as { session_id: string };
    if (
      anchor.piSessionId !== receipt.sessionId ||
      attribution.session_id !== receipt.sessionId
    )
      nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
    const origins = [
      ...new Set(bindings.map(({ endpoint }) => originView(endpoint))),
    ].sort();
    // Older starts contain only provider grants; retain their replay shape.
    if (![origins.length, origins.length + 1].includes(receipt.grantIds.length))
      nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
    for (let index = 0; index < receipt.grantIds.length; index++) {
      const grant = this.nativeSetupRecord(
        receipt.grantIds[index]!,
        workspaceId,
        "grant",
      ).record as GrantRecord;
      if (
        grant.sessionId !== receipt.sessionId ||
        grant.workspaceId !== workspaceId ||
        grant.capability !==
          (index < origins.length ? "net.provider" : "fs.read") ||
        grant.scope !== "session" ||
        grant.origin !== origins[index] ||
        grant.recordId !== grant.grantId
      )
        nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
    }
    const sessionRevision = String(anchorRow.seq);
    return {
      ...common,
      branchAnchor: this.nativeSetupAnchor(anchor, receipt.sessionId!),
      result: {
        sessionId: receipt.sessionId!,
        sessionRevision,
        readiness: {
          state: "unavailable",
          ...(this.nativeSetupFailed(receipt, sessionRevision)
            ? { code: "SESSION_BIND_FAILED" as const }
            : {}),
        },
      },
    };
  }

  private nativeSetupAnchor(
    input: unknown,
    piSessionId: string,
    strict = false,
  ): NativeBranchAnchor {
    if (!input || typeof input !== "object" || Array.isArray(input))
      nativeSetupInvalid();
    const keys = [
      "branchAnchorId",
      "piSessionId",
      "parentAnchorId",
      "forkPointEntryId",
      "firstChildEntryId",
      "activeLeafEntryId",
    ];
    if (strict && Reflect.ownKeys(input).length !== keys.length)
      nativeSetupInvalid();
    const anchor: Record<string, string | null> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !(
          nativeSetupId(descriptor.value) ||
          (key !== "branchAnchorId" &&
            key !== "piSessionId" &&
            descriptor.value === null)
        )
      )
        nativeSetupInvalid();
      anchor[key] = descriptor.value;
    }
    if (anchor.piSessionId !== piSessionId) nativeSetupInvalid();
    return anchor as unknown as NativeBranchAnchor;
  }

  private nativeSetupPolicyRevision(
    currentPolicyRevision: ((workspaceId: string) => string) | undefined,
    workspaceId: string,
  ): string {
    if (typeof currentPolicyRevision !== "function") nativeSetupInvalid();
    let revision: unknown;
    try {
      revision = currentPolicyRevision(workspaceId);
    } catch {
      nativeSetupInvalid();
    }
    if (
      typeof revision !== "string" ||
      revision.length > 128 ||
      !/^(0|[1-9][0-9]*)$/u.test(revision)
    )
      nativeSetupInvalid();
    return revision;
  }

  private commitNativeSessionSetup(
    preparation: NativeSessionSetupPreparation,
    prepared:
      { piSessionId: string; branchAnchor: NativeBranchAnchor } | undefined,
    caller: CallerContext,
    currentPolicyRevision?: (workspaceId: string) => string,
  ): NativeSessionSetupCommit {
    const capture = this.nativeSetupCaptures.get(preparation);
    if (
      !capture ||
      (capture.command === "profile.select" && prepared !== undefined)
    )
      nativeSetupInvalid();
    const { command, request } = capture;
    // Capture factory metadata before any lock-time callback can observe caller-owned objects.
    let piSessionId: string | undefined,
      branchAnchor: NativeBranchAnchor | undefined;
    if (prepared !== undefined) {
      if (
        !prepared ||
        typeof prepared !== "object" ||
        Reflect.ownKeys(prepared).length !== 2
      )
        nativeSetupInvalid();
      const id = Object.getOwnPropertyDescriptor(prepared, "piSessionId"),
        anchor = Object.getOwnPropertyDescriptor(prepared, "branchAnchor");
      if (
        !id ||
        !anchor ||
        !Object.hasOwn(id, "value") ||
        !Object.hasOwn(anchor, "value") ||
        !nativeSetupId(id.value)
      )
        nativeSetupInvalid();
      piSessionId = id.value;
      branchAnchor = this.nativeSetupAnchor(anchor.value, piSessionId!, true);
    }
    if (prepared && !nativeSetupId(piSessionId)) nativeSetupInvalid();
    const key = nativeSetupKey(request.requestId),
      receiptId = key + ":request";
    const staged = new Set<string>([
      request.workspaceId,
      ...(piSessionId ? [piSessionId] : []),
    ]);
    const batchCaller = this.nativeSetupCaller(
      caller,
      request.workspaceId,
      staged,
      piSessionId ?? caller.sessionId,
    );
    let replay: NativeSessionSetupCommit | undefined,
      receipt: NativeSetupReceipt | undefined;
    let authority: NativeSetupAuthority | undefined;
    let seqs: number[];
    let policyRevision: string | undefined;
    try {
      ({ seqs } = this.commitBatch([], [], batchCaller, {
        expectedConfigRevision: {
          scopeId: request.workspaceId,
          revision: request.expectedConfigRevision,
        },
        nativeSetup: () => {
          if (command === "session.start")
            policyRevision = this.nativeSetupPolicyRevision(
              currentPolicyRevision,
              request.workspaceId,
            );
          if (!this.currentWorkspace(request.workspaceId))
            nativeSetupInvalid("WORKSPACE_SUPERSEDED");
          const prior = this.nativeSetupReceipt(receiptId);
          if (prior) {
            if (
              prior.command !== command ||
              JSON.stringify(prior.request) !== JSON.stringify(request)
            )
              nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
            const stored = this.nativeSetupReplay(prior, true);
            replay = {
              ...stored,
              result:
                command === "session.start"
                  ? { ...stored.result, policyRevision: policyRevision! }
                  : stored.result,
            } as NativeSessionSetupCommit;
            throw new StoreError(
              "NATIVE_SETUP_REPLAY",
              "Native setup already committed",
            );
          }
          authority = this.nativeSetupAuthority(command, request);
          if (authority.fingerprint !== capture.authority.fingerprint)
            nativeSetupInvalid("STALE_REVISION");
          if (command === "session.start" && (!branchAnchor || !piSessionId))
            nativeSetupInvalid();
          const configRevision =
            command === "profile.select"
              ? `cfg-native-${key.slice(key.lastIndexOf(":") + 1)}`
              : request.expectedConfigRevision;
          const grantIds =
            command === "session.start"
              ? [
                  ...authority.origins.map(
                    (_, index) => `${key}:grant:${index}`,
                  ),
                  `${key}:grant:read`,
                ]
              : [];
          receipt = {
            version: 1,
            command,
            request: { ...request },
            profileRecordId: authority.profile.recordId,
            bindingRefs: authority.bindings.map(
              ({ binding, connection, endpoint, descriptorArtifact }) => ({
                role: binding.role,
                connectionRecordId: connection.recordId,
                endpointRecordId: endpoint.recordId,
                descriptorRecordId: descriptorArtifact?.recordId ?? null,
              }),
            ),
            configRevision,
            sessionId: command === "session.start" ? piSessionId! : null,
            anchorRecordId:
              command === "session.start"
                ? `${branchAnchor!.branchAnchorId}.1`
                : null,
            grantIds,
          };
          const base = (recordId: string) => ({
            schemaVersion: CONTRACT_VERSION,
            recordId,
            scopeId: request.workspaceId,
            createdAt: new Date().toISOString(),
            sourceIds: [] as string[],
          });
          let inputs: AppendInput[];
          if (command === "profile.select") {
            inputs = [
              {
                kind: "configurationTransition",
                record: {
                  ...base(key + ":applied"),
                  transitionId: key,
                  expectedConfigRevision: request.expectedConfigRevision,
                  acceptedConfigRevision: configRevision,
                  intentRef: receiptId,
                  changedValuesArtifactId: receiptId,
                  state: "applied",
                  outcomeRef: receiptId,
                  profileId: authority.profile.profileId,
                  profileRevision: authority.profile.profileRevision,
                },
              },
              ...authority.revokedGrants.map((grant) => ({
                kind: "grant" as const,
                record: {
                  ...grant,
                  recordId: `${grant.grantId}.revoked`,
                  createdAt: new Date().toISOString(),
                  revokedAt: new Date().toISOString(),
                },
              })),
            ];
          } else {
            if (
              this.db
                .prepare(
                  "SELECT 1 FROM records WHERE kind = 'branchAnchor' AND json_extract(payload, '$.piSessionId') = ? LIMIT 1",
                )
                .get(piSessionId!)
            )
              nativeSetupInvalid("STALE_REVISION");
            inputs = [
              {
                kind: "branchAnchor",
                record: { ...base(receipt.anchorRecordId!), ...branchAnchor },
              },
              ...authority.origins.map((origin, index) => ({
                kind: "grant" as const,
                record: {
                  ...base(grantIds[index]!),
                  grantId: grantIds[index]!,
                  workspaceId: request.workspaceId,
                  sessionId: piSessionId!,
                  capability: "net.provider",
                  scope: "session",
                  origin,
                },
              })),
              {
                kind: "grant",
                record: {
                  ...base(grantIds.at(-1)!),
                  grantId: grantIds.at(-1)!,
                  workspaceId: request.workspaceId,
                  sessionId: piSessionId!,
                  capability: "fs.read",
                  scope: "session",
                },
              },
            ];
          }
          inputs.push(
            this.nativeSetupArtifact(
              receiptId,
              request.workspaceId,
              NATIVE_SETUP_MEDIA,
              "nativeSetup",
              receipt,
            ),
          );
          for (const input of inputs) {
            const record = input.record as Record<string, unknown>;
            staged.add(String(record.recordId));
            if (typeof record.branchAnchorId === "string")
              staged.add(record.branchAnchorId);
          }
          return inputs;
        },
      }));
    } catch (error) {
      if (
        error instanceof StoreError &&
        error.code === "NATIVE_SETUP_REPLAY" &&
        replay
      )
        return nativeSetupFreeze(structuredClone(replay));
      if (
        error instanceof StoreError &&
        ["CONFIG_STALE_REVISION", "CONFIG_REVISION_REUSED"].includes(error.code)
      )
        nativeSetupInvalid("STALE_REVISION");
      throw error;
    }
    const saved = receipt!,
      current = authority!;
    const common = {
      workspaceId: request.workspaceId,
      profileId: current.profile.profileId,
      profileRevision: current.profile.profileRevision,
      configRevision: saved.configRevision,
      bindings: current.bindings,
      grantIds: saved.grantIds,
      replayed: false,
    };
    return nativeSetupFreeze(
      structuredClone(
        command === "profile.select"
          ? {
              ...common,
              result: {
                selectedProfileId: current.profile.profileId,
                profileRevision: current.profile.profileRevision,
                configRevision: saved.configRevision,
              },
            }
          : {
              ...common,
              branchAnchor: branchAnchor!,
              result: {
                sessionId: piSessionId!,
                sessionRevision: String(seqs[0]),
                policyRevision: policyRevision!,
                readiness: { state: "unavailable" as const },
              },
            },
      ),
    );
  }

  /** A replayed identity is not permission to publish readiness for stale or revoked authority. */
  assertNativeSessionStartCurrent(input: {
    workspaceId: string;
    sessionId: string;
    sessionRevision: string;
  }): void {
    this.assertOpen();
    const fields = ["workspaceId", "sessionId", "sessionRevision"];
    if (
      !input ||
      typeof input !== "object" ||
      Reflect.ownKeys(input).length !== fields.length
    )
      nativeSetupInvalid();
    const captured: Record<string, string> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !nativeSetupId(descriptor.value)
      )
        nativeSetupInvalid();
      captured[field] = descriptor.value;
    }
    const workspaceId = captured.workspaceId!,
      sessionId = captured.sessionId!;
    if (
      !/^[1-9][0-9]*$/u.test(captured.sessionRevision!) ||
      !Number.isSafeInteger(Number(captured.sessionRevision))
    )
      nativeSetupInvalid();
    try {
      this.db.exec("BEGIN;");
      try {
        if (!this.currentWorkspace(workspaceId))
          nativeSetupInvalid("WORKSPACE_SUPERSEDED");
        const rows = this.db
          .prepare(
            "SELECT record_id FROM records WHERE scope_id = ? AND kind = 'artifact' AND json_extract(payload, '$.mediaType') = ? AND json_extract(payload, '$.nativeSetup.sessionId') = ?",
          )
          .all(workspaceId, NATIVE_SETUP_MEDIA, sessionId) as {
          record_id: string;
        }[];
        if (rows.length !== 1) nativeSetupInvalid("STALE_REVISION");
        const receipt = this.nativeSetupReceipt(rows[0]!.record_id);
        if (!receipt || receipt.command !== "session.start")
          nativeSetupInvalid("STALE_REVISION");
        const original = this.nativeSetupReplay(
          receipt,
          true,
        ) as NativeSessionSetupCommit<NativeSessionStartResult>;
        if (
          original.result.sessionId !== sessionId ||
          original.result.sessionRevision !== captured.sessionRevision ||
          original.result.readiness.code !== undefined
        )
          nativeSetupInvalid("STALE_REVISION");
        // This path deliberately checks current selection/CAS instead of accepting the replay result.
        const current = this.nativeSetupAuthority(
          "session.start",
          receipt.request,
        );
        if (
          current.profile.profileId !== original.profileId ||
          current.profile.profileRevision !== original.profileRevision ||
          receipt.configRevision !== this.configRevision(workspaceId)
        )
          nativeSetupInvalid("STALE_REVISION");
        const grantRows = this.db
          .prepare(
            "SELECT * FROM records WHERE kind = 'grant' AND json_extract(payload, '$.sessionId') = ? AND json_extract(payload, '$.capability') IN ('net.provider', 'fs.read') ORDER BY seq",
          )
          .all(sessionId) as Parameters<Store["validateStructuralRow"]>[0][];
        const grants = grantRows
          .map((row) => this.validateStructuralRow(row) as GrantRecord)
          .filter(
            (grant) =>
              grant.recordId === grant.grantId &&
              (grant.capability === "net.provider" ||
                receipt.grantIds.includes(grant.grantId)),
          );
        const live = grants.filter((grant) => {
          const state = this.grantState(grant.grantId);
          return (
            state !== undefined &&
            !state.revoked &&
            state.consumedSeq === undefined
          );
        });
        if (
          live.length !== receipt.grantIds.length ||
          live.some(
            (grant) =>
              !receipt.grantIds.includes(grant.grantId) ||
              grant.workspaceId !== workspaceId ||
              grant.scopeId !== workspaceId ||
              grant.scope !== "session" ||
              (grant.capability === "net.provider" &&
                !current.origins.includes(grant.origin!)),
          )
        )
          nativeSetupInvalid("STALE_REVISION");
        for (const grantId of receipt.grantIds) {
          const grant = live.find((entry) => entry.grantId === grantId);
          if (!grant) nativeSetupInvalid("STALE_REVISION");
          this.checkGrant(
            {
              grantId,
              workspaceId,
              sessionId,
              capability: grant.capability,
              ...(grant.origin === undefined ? {} : { origin: grant.origin }),
              observedIdentity: current.workspace,
            },
            "session",
          );
        }
        this.db.exec("COMMIT;");
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
        throw error;
      }
    } catch (error) {
      // Readiness failures expose a fixed typed copy, never stored values or SQLite diagnostics.
      nativeSetupInvalid(
        error instanceof StoreError && error.code === "WORKSPACE_SUPERSEDED"
          ? "WORKSPACE_SUPERSEDED"
          : "STALE_REVISION",
      );
    }
  }

  /** Failed live attachment keeps the committed identity and revokes its provider authority atomically. */
  failNativeSessionStart(
    input: { workspaceId: string; sessionId: string; sessionRevision: string },
    caller: CallerContext,
    currentPolicyRevision: (workspaceId: string) => string,
  ): NativeSessionSetupCommit<NativeSessionStartResult> {
    const fields = ["workspaceId", "sessionId", "sessionRevision"];
    if (
      !input ||
      typeof input !== "object" ||
      Reflect.ownKeys(input).length !== fields.length
    )
      nativeSetupInvalid();
    const captured: Record<string, string> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !nativeSetupId(descriptor.value)
      )
        nativeSetupInvalid();
      captured[field] = descriptor.value;
    }
    const workspaceId = captured.workspaceId!,
      sessionId = captured.sessionId!;
    const staged = new Set<string>([workspaceId, sessionId]);
    let result: NativeSessionSetupCommit<NativeSessionStartResult> | undefined;
    this.commitBatch(
      [],
      [],
      this.nativeSetupCaller(caller, workspaceId, staged, sessionId),
      {
        nativeSetup: () => {
          const policyRevision = this.nativeSetupPolicyRevision(
            currentPolicyRevision,
            workspaceId,
          );
          const rows = this.db
            .prepare(
              "SELECT record_id FROM records WHERE scope_id = ? AND kind = 'artifact' AND json_extract(payload, '$.mediaType') = ? AND json_extract(payload, '$.nativeSetup.sessionId') = ?",
            )
            .all(workspaceId, NATIVE_SETUP_MEDIA, sessionId) as {
            record_id: string;
          }[];
          if (rows.length !== 1) nativeSetupInvalid("STALE_REVISION");
          const receipt = this.nativeSetupReceipt(rows[0]!.record_id)!;
          // Compensation must still revoke authority if a profile/descriptor was deleted after commit.
          const anchorRow = this.db
            .prepare("SELECT * FROM records WHERE record_id = ?")
            .get(receipt.anchorRecordId!) as
            Parameters<Store["validateStructuralRow"]>[0] | undefined;
          const profileRow = this.db
            .prepare("SELECT * FROM records WHERE record_id = ?")
            .get(receipt.profileRecordId) as
            Parameters<Store["validateStructuralRow"]>[0] | undefined;
          if (
            !anchorRow ||
            !profileRow ||
            anchorRow.kind !== "branchAnchor" ||
            profileRow.kind !== "profileSnapshot" ||
            anchorRow.scope_id !== workspaceId ||
            profileRow.scope_id !== workspaceId ||
            anchorRow.session_id !== sessionId
          )
            nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
          const anchor = this.validateStructuralRow(
            anchorRow,
          ) as RecordByKind["branchAnchor"];
          const profile = this.validateStructuralRow(
            profileRow,
          ) as RecordByKind["profileSnapshot"];
          if (
            anchor.piSessionId !== sessionId ||
            profile.profileId !== receipt.request.profileId
          )
            nativeSetupInvalid("SETUP_REQUEST_CONFLICT");
          const original: NativeSessionSetupCommit<NativeSessionStartResult> = {
            workspaceId,
            profileId: profile.profileId,
            profileRevision: profile.profileRevision,
            configRevision: receipt.configRevision,
            bindings: [],
            grantIds: receipt.grantIds,
            replayed: true,
            branchAnchor: this.nativeSetupAnchor(anchor, sessionId),
            result: {
              sessionId,
              sessionRevision: String(anchorRow.seq),
              policyRevision,
              readiness: { state: "unavailable" },
            },
          };
          if (original.result.sessionRevision !== captured.sessionRevision)
            nativeSetupInvalid("STALE_REVISION");
          const inputs: AppendInput[] = this.nativeProviderGrants(
            workspaceId,
            true,
          )
            .filter((grant) => grant.sessionId === sessionId)
            .map((grant) => ({
              kind: "grant",
              record: {
                ...grant,
                recordId: `${grant.grantId}.revoked`,
                createdAt: new Date().toISOString(),
                revokedAt: new Date().toISOString(),
              },
            }));
          if (!this.nativeSetupFailed(receipt, captured.sessionRevision!))
            inputs.push(
              this.nativeSetupArtifact(
                nativeSetupKey(receipt.request.requestId) + ":unavailable",
                workspaceId,
                NATIVE_SETUP_FAILED_MEDIA,
                "unavailable",
                {
                  sessionId,
                  sessionRevision: captured.sessionRevision!,
                  code: "SESSION_BIND_FAILED",
                },
              ),
            );
          for (const entry of inputs)
            staged.add(
              String((entry.record as Record<string, unknown>).recordId),
            );
          result = {
            ...original,
            result: {
              ...original.result,
              readiness: { state: "unavailable", code: "SESSION_BIND_FAILED" },
            },
          };
          return inputs;
        },
      },
    );
    return nativeSetupFreeze(structuredClone(result!));
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

  reserveSetupCredential(
    setup: SetupInput,
    binding: {
      metadataHash: string;
      intentId: string;
      modelDescriptorHash: string;
      kind: "new" | "keep";
      credentialRef: string | null;
    },
    caller: CallerContext,
    expectedDeletionEpoch: number,
    checkDescriptors: () => boolean,
    descriptors: readonly { recordId: string; digest: string }[],
    intentRecord: RecordByKind["artifact"],
  ): {
    credentialRef: string;
    reservation: { recordId: string; digest: string; created: boolean };
  } {
    const recordId = `setup:${createHash("sha256").update(setup.requestId).digest("hex").slice(0, 32)}:credres`;
    const credentialRef =
      binding.kind === "new"
        ? `splyce-credential:v1:${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
        : binding.credentialRef;
    if (
      credentialRef === null ||
      !/^splyce-credential:v1:[a-f0-9]{64}$/u.test(credentialRef)
    )
      throw new StoreError(
        "SETUP_CREDENTIAL_UNAVAILABLE",
        "credential reference unavailable",
      );
    const body = {
      workspaceId: setup.workspaceId,
      metadataHash: binding.metadataHash,
      intentId: binding.intentId,
      modelDescriptorHash: binding.modelDescriptorHash,
      kind: binding.kind,
      credentialRef,
    };
    const json = JSON.stringify(body);
    const digest = `sha256:${createHash("sha256").update(json).digest("hex")}`;
    const record = {
      schemaVersion: CONTRACT_VERSION,
      recordId,
      createdAt: new Date().toISOString(),
      scopeId: setup.workspaceId,
      sourceIds: [],
      artifactId: recordId,
      digest,
      mediaType: "application/vnd.splyce.credential-reservation+json",
      byteLength: new TextEncoder().encode(json).length,
      retentionClass: "workspace",
      reservation: body,
    };
    let existing: typeof record | undefined;
    try {
      this.commitBatch(
        [
          { kind: "artifact", record: intentRecord },
          { kind: "artifact", record },
        ],
        [],
        caller,
        {
          reservationCheck: () => {
            if (
              this.deletionEpoch() !== expectedDeletionEpoch ||
              this.currentWorkspace(setup.workspaceId) === undefined
            )
              throw new StoreError(
                "SETUP_INVALID",
                "setup workspace or deletion epoch changed",
              );
            for (const [kind, field, id, rev, expected] of [
              [
                "providerEndpoint",
                "endpointId",
                setup.endpoint.endpointId,
                "revision",
                setup.expected.endpointRevision,
              ],
              [
                "providerConnection",
                "providerConnectionId",
                setup.connection.providerConnectionId,
                "revision",
                setup.expected.connectionRevision,
              ],
              [
                "profileSnapshot",
                "profileId",
                setup.profile.profileId,
                "profileRevision",
                setup.expected.profileRevision,
              ],
            ] as const) {
              const latest = this.db
                .prepare(
                  `SELECT payload, schema_version, EXISTS (SELECT 1 FROM deletions d WHERE d.record_id = records.record_id) AS deleted FROM records WHERE kind = ? AND scope_id = ? AND json_extract(payload, '$.${field}') = ? ORDER BY seq DESC LIMIT 1`,
                )
                .get(kind, setup.workspaceId, id) as
                | { payload: string; schema_version: number; deleted: number }
                | undefined;
              if (
                latest &&
                (Number(latest.schema_version) !== CONTRACT_VERSION ||
                  Number(latest.deleted) !== 0)
              )
                throw new StoreError(
                  "SETUP_STALE_REVISION",
                  "entity unavailable",
                );
              const current = latest
                ? (JSON.parse(latest.payload) as Record<string, unknown>)
                : undefined;
              if ((current?.[rev] ?? null) !== expected)
                throw new StoreError(
                  "SETUP_STALE_REVISION",
                  "entity revision changed",
                );
              if (
                kind === "providerConnection" &&
                binding.kind === "keep" &&
                current?.credentialRef !== credentialRef
              )
                throw new StoreError(
                  "SETUP_REQUEST_CONFLICT",
                  "credential changed",
                );
            }
            for (const descriptor of descriptors) {
              const current = this.db
                .prepare(
                  "SELECT kind, schema_version, payload, EXISTS (SELECT 1 FROM deletions d WHERE d.record_id = records.record_id) AS deleted FROM records WHERE record_id = ?",
                )
                .get(descriptor.recordId) as
                | {
                    kind: string;
                    schema_version: number;
                    payload: string;
                    deleted: number;
                  }
                | undefined;
              if (
                !current ||
                current.kind !== "artifact" ||
                Number(current.schema_version) !== CONTRACT_VERSION ||
                Number(current.deleted) !== 0 ||
                (JSON.parse(current.payload) as { digest?: string }).digest !==
                  descriptor.digest
              )
                throw new StoreError(
                  "SETUP_DESCRIPTOR_UNAVAILABLE",
                  "descriptor changed",
                );
            }
            if (!checkDescriptors())
              throw new StoreError(
                "SETUP_DESCRIPTOR_UNAVAILABLE",
                "descriptor changed",
              );
            const intent = this.db
              .prepare(
                "SELECT kind, schema_version, payload, EXISTS (SELECT 1 FROM deletions d WHERE d.record_id = records.record_id) AS deleted FROM records WHERE record_id = ?",
              )
              .get(binding.intentId) as
              | {
                  kind: string;
                  schema_version: number;
                  payload: string;
                  deleted: number;
                }
              | undefined;
            const currentIntent = intent
              ? (JSON.parse(intent.payload) as Record<string, unknown>)
              : undefined;
            if (
              intent &&
              (intent.kind !== "artifact" ||
                Number(intent.schema_version) !== CONTRACT_VERSION ||
                Number(intent.deleted) !== 0 ||
                [
                  "recordId",
                  "scopeId",
                  "artifactId",
                  "digest",
                  "mediaType",
                  "byteLength",
                  "retentionClass",
                ].some(
                  (key) =>
                    currentIntent?.[key] !==
                    (intentRecord as unknown as Record<string, unknown>)[key],
                ))
            )
              throw new StoreError(
                "SETUP_REQUEST_CONFLICT",
                "intent unavailable or changed",
              );
            const row = this.reservationRow(recordId);
            if (Boolean(intent) !== Boolean(row))
              throw new StoreError(
                "SETUP_REQUEST_CONFLICT",
                "intent and reservation must both exist",
              );
            if (row !== undefined) {
              const stored = row as typeof record;
              const prior = stored.reservation;
              if (
                !prior ||
                prior.workspaceId !== body.workspaceId ||
                prior.metadataHash !== body.metadataHash ||
                prior.intentId !== body.intentId ||
                prior.modelDescriptorHash !== body.modelDescriptorHash ||
                prior.kind !== body.kind ||
                (body.kind === "keep" &&
                  prior.credentialRef !== body.credentialRef)
              )
                throw new StoreError(
                  "SETUP_REQUEST_CONFLICT",
                  "reservation binding changed",
                );
              existing = stored;
              throw new StoreError(
                "SETUP_RESERVATION_REPLAY",
                "reservation already exists",
              );
            }
          },
        },
      );
    } catch (error) {
      if (!(
        error instanceof StoreError &&
        error.code === "SETUP_RESERVATION_REPLAY" &&
        existing
      ))
        throw error;
      return {
        credentialRef: existing.reservation.credentialRef,
        reservation: { recordId, digest: existing.digest, created: false },
      };
    }
    return { credentialRef, reservation: { recordId, digest, created: true } };
  }

  private reservationRow(recordId: string): Record<string, any> | undefined {
    const row = this.db
      .prepare(
        "SELECT seq, kind, schema_version, payload, EXISTS (SELECT 1 FROM deletions d WHERE d.record_id = records.record_id) AS deleted FROM records WHERE record_id = ?",
      )
      .get(recordId) as
      | {
          seq: number;
          kind: string;
          schema_version: number;
          payload: string;
          deleted: number;
        }
      | undefined;
    if (!row) {
      if (
        this.db
          .prepare("SELECT 1 FROM deletions WHERE record_id = ?")
          .get(recordId)
      )
        throw new StoreError("SETUP_DELETED", "reservation deleted");
      return undefined;
    }
    if (Number(row.deleted) !== 0)
      throw new StoreError("SETUP_DELETED", "reservation deleted");
    const record = this.readRow(row).record as unknown as Record<string, any>;
    const body = record.reservation;
    const json = JSON.stringify(body);
    if (
      row.kind !== "artifact" ||
      record.recordId !== recordId ||
      record.artifactId !== recordId ||
      record.mediaType !==
        "application/vnd.splyce.credential-reservation+json" ||
      record.retentionClass !== "workspace" ||
      !body ||
      typeof body !== "object" ||
      JSON.stringify(Object.keys(body).sort()) !==
        JSON.stringify([
          "credentialRef",
          "intentId",
          "kind",
          "metadataHash",
          "modelDescriptorHash",
          "workspaceId",
        ]) ||
      typeof body.metadataHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(body.metadataHash) ||
      typeof body.modelDescriptorHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(body.modelDescriptorHash) ||
      typeof body.intentId !== "string" ||
      !body.intentId.startsWith("native-descriptor:") ||
      !["new", "keep"].includes(body.kind) ||
      record.scopeId !== body.workspaceId ||
      typeof body.credentialRef !== "string" ||
      !/^splyce-credential:v1:[a-f0-9]{64}$/u.test(body.credentialRef) ||
      record.digest !==
        `sha256:${createHash("sha256").update(json).digest("hex")}` ||
      record.byteLength !== new TextEncoder().encode(json).length
    )
      throw new StoreError("SETUP_REQUEST_CONFLICT", "reservation corrupt");
    return record;
  }

  /**
   * TD-26 first-run setup: endpoint, connection and profile revisions commit in
   * ONE transaction with per-entity CAS under the same lock. Record ids derive
   * from requestId, so an identical retry returns the stored result and appends
   * nothing; the same requestId with a different payload is SETUP_REQUEST_CONFLICT.
   * Only a credentialRef is accepted: unknown fields (apiKey, ...) are rejected.
   */
  commitSetup(
    input: unknown,
    caller: CallerContext,
    expectedDeletionEpoch?: number,
    reservation?: {
      recordId: string;
      digest: string;
      credentialRef: string;
      metadataHash: string;
      intentId: string;
      modelDescriptorHash: string;
      kind: "new" | "keep";
    },
  ): SetupResult {
    let setup: SetupInput;
    try {
      setup = validateSetupMetadata(
        input,
        caller.trustedCatalog === undefined
          ? {}
          : { trustedCatalog: caller.trustedCatalog },
      );
    } catch (error) {
      if (error instanceof SetupMetadataError)
        throw new StoreError(error.code, error.message);
      throw error;
    }
    const scopeId = setup.workspaceId;
    // Hashed so a 128-character requestId still fits the recordId bound.
    const key = createHash("sha256")
      .update(setup.requestId)
      .digest("hex")
      .slice(0, 32);
    const ids = {
      endpoint: `setup:${key}:endpoint`,
      connection: `setup:${key}:connection`,
      profile: `setup:${key}:profile`,
    };
    // Identity of the whole accepted request; replays compare it under the write lock.
    const digestRef = `setup-request:sha256:${createHash("sha256")
      .update(JSON.stringify(setup))
      .digest("hex")}`;
    const base = (recordId: string) => ({
      schemaVersion: CONTRACT_VERSION,
      recordId,
      createdAt: new Date().toISOString(),
      scopeId,
      sourceIds: [digestRef],
    });
    const endpoint = {
      ...base(ids.endpoint),
      endpointId: setup.endpoint.endpointId,
      canonicalUrl: setup.endpoint.canonicalUrl,
      apiFamily: setup.endpoint.apiFamily,
      locality: setup.endpoint.locality,
      revision: setup.endpoint.revision,
    };
    // displayName is rejected as an unknown field: the connection record has no such field.
    const connection = {
      ...base(ids.connection),
      sourceIds: reservation ? [digestRef, reservation.recordId] : [digestRef],
      providerConnectionId: setup.connection.providerConnectionId,
      revision: setup.connection.revision,
      apiFamily: setup.connection.apiFamily,
      apiVersion: setup.descriptors.apiVersion,
      endpointRef: setup.connection.endpointRef,
      credentialRef: setup.connection.credentialRef,
      adapterRevision: setup.descriptors.adapterRevision,
      accountScopeRef: setup.descriptors.accountScopeRef,
      locality: setup.connection.locality,
    };
    // One immutable artifact per described binding; the profile links it through sourceIds.
    const descriptorArtifacts = setup.profile.bindings.flatMap((binding) => {
      if (binding.modelDescriptor === undefined) return [];
      const recordId = `setup:${key}:modeldesc:${binding.role}`;
      const json = JSON.stringify(binding.modelDescriptor);
      return [
        {
          ...base(recordId),
          artifactId: recordId,
          digest: `sha256:${createHash("sha256").update(json).digest("hex")}`,
          mediaType: "application/vnd.splyce.model-descriptor+json",
          byteLength: new TextEncoder().encode(json).length,
          retentionClass: "workspace",
          role: binding.role,
          modelId: binding.modelId,
          descriptor: binding.modelDescriptor,
        },
      ];
    });
    const profile = {
      ...base(ids.profile),
      sourceIds: [digestRef, ...descriptorArtifacts.map((a) => a.recordId)],
      profileId: setup.profile.profileId,
      profileRevision: setup.profile.profileRevision,
      configRevision: this.configRevision(scopeId),
      roleBindingRefs: [] as string[],
      installedModuleRefs: [] as string[],
      bindings: setup.profile.bindings.map(
        ({ modelDescriptor: _descriptor, ...pinned }) => pinned,
      ),
      egressPolicyRefs: [...setup.descriptors.egressPolicyRefs],
      limitsArtifactId: setup.descriptors.limitsArtifactId,
    };
    const resolve = (ref: string): boolean => {
      try {
        return caller.resolveReference?.(ref, scopeId) === true;
      } catch {
        return false;
      }
    };
    const unresolved: [string, string][] = [
      ["connection.credentialRef", setup.connection.credentialRef],
      ["descriptors.accountScopeRef", setup.descriptors.accountScopeRef],
      ["descriptors.limitsArtifactId", setup.descriptors.limitsArtifactId],
      ...setup.descriptors.egressPolicyRefs.map((ref, i): [string, string] => [
        `descriptors.egressPolicyRefs[${i}]`,
        ref,
      ]),
    ];
    for (const [field, ref] of unresolved)
      if (!resolve(ref))
        throw new StoreError(
          "SETUP_INVALID",
          `setup reference does not resolve: ${field}`,
        );
    // The endpoint revision exists only inside this batch; everything else is the caller's.
    const batchCaller: CallerContext = {
      ...caller,
      resolveReference: (ref, refScope) =>
        (refScope === scopeId &&
          (ref === connection.endpointRef ||
            ref === digestRef ||
            ref === reservation?.recordId ||
            descriptorArtifacts.some((a) => a.recordId === ref))) ||
        resolve(ref),
    };
    let replayed: SetupResult | undefined;
    try {
      this.commitBatch(
        [
          { kind: "providerEndpoint", record: endpoint },
          { kind: "providerConnection", record: connection },
          { kind: "profileSnapshot", record: profile },
          ...descriptorArtifacts.map((record) => ({
            kind: "artifact" as const,
            record,
          })),
        ],
        [],
        batchCaller,
        {
          expectedSetup: {
            workspaceId: scopeId,
            ...(reservation ? { reservation } : {}),
            expectedDeletionEpoch,
            recordIds: [
              ...Object.values(ids),
              ...descriptorArtifacts.map((a) => a.recordId),
            ],
            digestRef,
            onReplay: (records) => {
              replayed = {
                endpoint: records[0] as RecordByKind["providerEndpoint"],
                connection: records[1] as RecordByKind["providerConnection"],
                profile: records[2] as RecordByKind["profileSnapshot"],
              };
            },
            unresolved: (): string | undefined =>
              unresolved.find(([, ref]) => !resolve(ref))?.[0],
          },
          expectedEntityRevision: [
            {
              kind: "providerEndpoint",
              scopeId,
              entityId: endpoint.endpointId,
              expectedRevision: setup.expected.endpointRevision,
            },
            {
              kind: "providerConnection",
              scopeId,
              entityId: connection.providerConnectionId,
              expectedRevision: setup.expected.connectionRevision,
            },
            {
              kind: "profileSnapshot",
              scopeId,
              entityId: profile.profileId,
              expectedRevision: setup.expected.profileRevision,
            },
          ],
        },
      );
    } catch (error) {
      // The lock-time observation found all three records of this exact request.
      if (
        error instanceof StoreError &&
        error.code === "SETUP_REPLAY" &&
        replayed !== undefined
      )
        return replayed;
      throw error;
    }
    return {
      endpoint: endpoint as RecordByKind["providerEndpoint"],
      connection: connection as RecordByKind["providerConnection"],
      profile: profile as RecordByKind["profileSnapshot"],
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
    /** Cursor/deletion-epoch fences (used by recovery) checked under the same lock. */
    expected: Pick<
      EventPreconditions,
      "expectedScopeCursor" | "expectedSessionCursor" | "expectedDeletionEpoch"
    > = {},
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
      ...expected,
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
      expectedScopeCursor,
      expectedSessionCursor,
      expectedEntityRevision,
      expectedSetup,
      reservationCheck,
      nativeSetup,
      expectedOnceGrant,
      expectedGrantMint,
      expectedActiveGrants,
      workspaceAdmission,
    }: EventPreconditions & {
      expectedEntityRevision?:
        EntityRevisionExpectation | readonly EntityRevisionExpectation[];
      reservationCheck?: () => void;
      /** Native setup resolves authority and builds its batch under this write lock. */
      nativeSetup?: () => readonly AppendInput[];
      expectedSetup?: {
        workspaceId: string;
        reservation?: {
          recordId: string;
          digest: string;
          credentialRef: string;
          metadataHash: string;
          intentId: string;
          modelDescriptorHash: string;
          kind: "new" | "keep";
        };
        expectedDeletionEpoch: number | undefined;
        recordIds: readonly string[];
        digestRef: string;
        /** Receives the stored records, read under the same lock, when the request is a replay. */
        onReplay: (records: readonly unknown[]) => void;
        /** Re-resolves the setup references; returns the first failing field. */
        unresolved: () => string | undefined;
      };
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
      expectedScopeCursor === undefined &&
      expectedSessionCursor === undefined &&
      expectedEntityRevision === undefined &&
      nativeSetup === undefined
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
      reservationCheck?.();
      for (const input of nativeSetup?.() ?? []) {
        const record = input.record as Record<string, unknown>;
        prepared.push([
          input.kind,
          validateRecord(
            input.kind,
            input.record,
            this.context(String(record.scopeId ?? ""), caller),
          ),
        ]);
      }
      if (expectedSetup !== undefined) {
        if (
          expectedSetup.expectedDeletionEpoch !== undefined &&
          (!Number.isSafeInteger(expectedSetup.expectedDeletionEpoch) ||
            expectedSetup.expectedDeletionEpoch < 0 ||
            this.deletionEpoch() !== expectedSetup.expectedDeletionEpoch)
        )
          throw new StoreError(
            "SETUP_INVALID",
            "deletion epoch changed before setup commit",
          );
        // The target must still be the current admitted, non-superseded, non-deleted workspace.
        if (this.currentWorkspace(expectedSetup.workspaceId) === undefined)
          throw new StoreError(
            "SETUP_INVALID",
            "setup reference does not resolve: workspace",
          );
        if (expectedSetup.reservation) {
          const expected = expectedSetup.reservation;
          const stored = this.reservationRow(expected.recordId);
          if (
            !stored ||
            stored.digest !== expected.digest ||
            stored.scopeId !== expectedSetup.workspaceId ||
            stored.reservation.credentialRef !== expected.credentialRef ||
            stored.reservation.metadataHash !== expected.metadataHash ||
            stored.reservation.intentId !== expected.intentId ||
            stored.reservation.modelDescriptorHash !==
              expected.modelDescriptorHash ||
            stored.reservation.kind !== expected.kind ||
            !prepared.some(
              ([kind, record]) =>
                kind === "providerConnection" &&
                record.credentialRef === expected.credentialRef &&
                record.sourceIds.includes(expected.recordId),
            )
          )
            throw new StoreError(
              "SETUP_REQUEST_CONFLICT",
              "reservation changed before setup commit",
            );
        }
        // One observation of all participating rows (tombstones included) under the lock.
        const rows = expectedSetup.recordIds.map(
          (id) =>
            this.db
              .prepare(
                "SELECT seq, kind, schema_version, payload, json_extract(payload, '$.sourceIds[0]') AS digest, " +
                  "EXISTS (SELECT 1 FROM deletions d WHERE d.record_id = records.record_id) AS deleted " +
                  "FROM records WHERE record_id = ?",
              )
              .get(id) as
              | {
                  seq: number;
                  kind: string;
                  schema_version: number;
                  payload: string;
                  digest: unknown;
                  deleted: number | bigint;
                }
              | undefined,
        );
        if (rows.some((row) => row !== undefined)) {
          // A tombstoned record is never replayed or resurrected.
          if (
            rows.some((row) => row !== undefined && Number(row.deleted) !== 0)
          )
            throw new StoreError(
              "SETUP_DELETED",
              "a record of this setup request was deleted; nothing appended",
            );
          if (
            rows.every(
              (row) =>
                row !== undefined && row.digest === expectedSetup.digestRef,
            )
          ) {
            expectedSetup.onReplay(
              rows.map((row) => this.readRow(row!).record),
            );
            throw new StoreError(
              "SETUP_REPLAY",
              "setup request already committed; nothing appended",
            );
          }
          throw new StoreError(
            "SETUP_REQUEST_CONFLICT",
            "requestId was already used with a different setup request; nothing appended",
          );
        }
        // A descriptor removed after the early check must not commit.
        const field = expectedSetup.unresolved();
        if (field !== undefined)
          throw new StoreError(
            "SETUP_INVALID",
            `setup reference does not resolve: ${field}`,
          );
      }
      const expectations: readonly EntityRevisionExpectation[] =
        expectedEntityRevision === undefined
          ? []
          : Array.isArray(expectedEntityRevision)
            ? expectedEntityRevision
            : [expectedEntityRevision as EntityRevisionExpectation];
      // Every prepared record is guarded exactly once: one expectation per kind.
      if (
        expectedEntityRevision !== undefined &&
        prepared.length !==
          expectations.length +
            (expectedSetup === undefined
              ? 0
              : prepared.filter(([kind]) => kind === "artifact").length)
      )
        throw new StoreError(
          "ENTITY_GUARD_MISMATCH",
          "entity guard must match the inserted kind, scope, identity and revision",
        );
      for (const expectation of expectations) {
        const { kind, scopeId, entityId, expectedRevision } = expectation;
        const [entityField, revisionField] = (
          {
            providerConnection: ["providerConnectionId", "revision"],
            profileSnapshot: ["profileId", "profileRevision"],
            providerEndpoint: ["endpointId", "revision"],
          } as const
        )[kind] ?? ["", ""];
        const input = prepared.find(([k]) => k === kind);
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
          prepared.filter(([k]) => k === kind).length !== 1 ||
          input === undefined ||
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
        const nextRevision = input[1][revisionField];
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
      if (expectedScopeCursor !== undefined) {
        const { scopeId, seq } = expectedScopeCursor;
        const valid = Number.isSafeInteger(seq) && seq >= 0;
        const current = this.cursor(scopeId);
        if (!valid || current !== seq) {
          this.db.exec("ROLLBACK;");
          throw new StoreError(
            "SCOPE_CURSOR_STALE",
            `scope ${JSON.stringify(scopeId)} record cursor is ${String(current)}, not the expected ${String(seq)}; nothing appended`,
          );
        }
      }
      if (expectedSessionCursor !== undefined) {
        const { scopeId, sessionId, seq } = expectedSessionCursor;
        const valid =
          Number.isSafeInteger(seq) &&
          seq >= 0 &&
          typeof sessionId === "string" &&
          sessionId.length > 0;
        const current = this.sessionCursor(scopeId, sessionId);
        if (!valid || current !== seq) {
          this.db.exec("ROLLBACK;");
          throw new StoreError(
            "SESSION_CURSOR_STALE",
            `session ${JSON.stringify(sessionId)} record cursor in scope ${JSON.stringify(scopeId)} is ${String(current)}, not the expected ${String(seq)}; nothing appended`,
          );
        }
      }
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
    const guard = this.guard;
    if (!guard)
      throw new StoreError(
        "STORE_RESTORE_LOCK",
        "restore requires a file-backed writer",
      );
    const options = {
      busyTimeoutMs: this.busyTimeoutMs,
      maxInlineBytes: this.maxInlineBytes,
    };
    // Close the live handle before changing lock modes. Another restorer can win
    // either transition; always reopen the authoritative path under the new lock.
    this.db.close();
    this.closed = true;
    try {
      guard.exec("ROLLBACK; BEGIN EXCLUSIVE;");
      Store.assertStorePath(this.path);
      const exclusive = Store.openDatabase(this.path, options);
      try {
        exclusive.restoreExclusive(backupPath);
      } finally {
        exclusive.close();
      }
    } catch (error) {
      throw mapSqliteError(error);
    } finally {
      try {
        if (guard.isTransaction) guard.exec("ROLLBACK;");
        Store.holdWriter(guard);
        if (!existsSync(this.path))
          throw new StoreError(
            "STORE_RESTORE_FAILED",
            "live store requires recovery",
          );
        Store.assertStorePath(this.path);
        this.db = Store.openDatabase(this.path, options).db;
        this.closed = false;
      } catch (error) {
        guard.close();
        this.guard = undefined;
        throw mapSqliteError(error);
      }
    }
  }

  private restoreExclusive(backupPath: string): void {
    this.assertShellCleanup();
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

    const reservationRows = (db: DatabaseSync) =>
      db
        .prepare(
          "SELECT record_id, kind, scope_id, schema_version, payload FROM records WHERE record_id GLOB 'setup:*:credres' ORDER BY record_id",
        )
        .all() as Array<{
        record_id: string;
        kind: string;
        scope_id: string;
        schema_version: number;
        payload: string;
      }>;
    const liveReservations = reservationRows(this.db);
    const assertReservations = (path: string) => {
      const snapshot = new DatabaseSync(path, { readOnly: true });
      try {
        const restored = new Map(
          reservationRows(snapshot).map((row) => [row.record_id, row]),
        );
        for (const live of liveReservations) {
          const candidate = restored.get(live.record_id);
          if (!candidate || JSON.stringify(candidate) !== JSON.stringify(live))
            throw new StoreError(
              "RESTORE_RESERVATION_MISMATCH",
              "restore would change a credential reservation",
            );
        }
      } finally {
        snapshot.close();
      }
    };
    assertReservations(backupPath);

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
      assertReservations(staging);
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
        if (existsSync(this.path + suffix))
          throw new StoreError(
            "STORE_BUSY",
            "a live SQLite reader still owns the journal",
          );
      if (existsSync(this.path)) {
        renameSync(this.path, original);
        originalPreserved = true;
      }
      renameSync(staging, this.path);
      swapped = true;
      reopened = Store.openDatabase(this.path, {
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
        const recoveredStore = Store.openDatabase(this.path, {
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

  /** A shell intent outlives both its caller and an ownership row released by older hosts. */
  assertShellCleanup(workspaceId?: string): void {
    const scoped = workspaceId !== undefined;
    const pending = this.db
      .prepare(
        `
      WITH receipts AS (
        SELECT a.seq, a.scope_id, a.session_id, json_extract(a.payload,'$.runId') AS run_id,
          json_extract(a.payload,'$.ownershipEpoch') AS epoch, json_extract(a.payload,'$.actionId') AS action_id,
          json_extract(a.payload,'$.capabilityId') AS capability, 1 AS intent, NULL AS cleanup
        FROM records a WHERE a.kind = 'action' ${scoped ? "AND a.scope_id = ?" : ""}
          AND json_extract(a.payload,'$.state') = 'running'
          AND json_extract(a.payload,'$.capabilityId') IN ('workspace.bash','workspace.powershell')
        UNION ALL
        SELECT o.seq, o.scope_id, o.session_id, json_extract(src.payload,'$.runId'),
          json_extract(src.payload,'$.ownershipEpoch'), json_extract(src.payload,'$.actionId'),
          json_extract(src.payload,'$.capabilityId'), 0,
          CASE WHEN d.record_id IS NULL THEN json_extract(o.payload,'$.cleanupState') END
        FROM records o CROSS JOIN json_each(o.payload,'$.sourceIds') refs
        CROSS JOIN records src ON src.record_id = refs.value AND src.kind = 'action'
          AND src.scope_id = o.scope_id AND src.session_id IS o.session_id
          AND json_extract(src.payload,'$.actionId') = json_extract(o.payload,'$.actionId')
        LEFT JOIN deletions d ON d.record_id = o.record_id
        WHERE o.kind = 'outcome' ${scoped ? "AND o.scope_id = ?" : ""}
          AND json_extract(src.payload,'$.capabilityId') IN ('workspace.bash','workspace.powershell')
      ), ranked AS (
        SELECT cleanup, max(intent) OVER effect AS started,
          row_number() OVER (effect ORDER BY seq DESC) AS rank FROM receipts
        WINDOW effect AS (PARTITION BY scope_id,session_id,run_id,epoch,action_id,capability)
      )
      SELECT 1 FROM ranked WHERE rank = 1 AND started = 1 AND cleanup IS NOT 'complete' LIMIT 1
    `,
      )
      .get(...(scoped ? [workspaceId, workspaceId] : []));
    if (pending)
      throw new StoreError(
        "OWNERSHIP_CONFLICT",
        "Workspace shell cleanup requires reconciliation",
      );
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
      this.assertShellCleanup(workspaceId);
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
      this.assertShellCleanup(workspaceId);
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
      this.assertShellCleanup(workspaceId);
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
    events: readonly SplyceEventDraft[] = [],
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
      events,
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

  /** The admitted workspace if it is still current: path mapped to it, not superseded, not deleted. */
  private currentWorkspace(workspaceId: string): AdmittedWorkspace | undefined {
    const record = this.workspaceRecord(workspaceId);
    const path = this.workspacePath(workspaceId);
    if (
      record === undefined ||
      path === undefined ||
      this.currentWorkspaceIdForPath(path) !== workspaceId ||
      this.db
        .prepare("SELECT 1 FROM deletions WHERE record_id = ?")
        .get(record.recordId) !== undefined
    )
      return undefined;
    return { ...record, canonicalPath: path };
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
    } finally {
      this.guard?.close();
    }
  }
}
