// TD-09 / J0_store_contract — durable store commits against the merged
// contract (e8d56b5) per the TD-03 store-qualification experiment (S1–S8)
// and the TD-09 acceptance row: fresh / corrupt / read-only / reopen cases;
// failed writes acknowledge no durability.
//
// Trials per case: J0_TRIALS env (default 1). Every run prints `n` per case.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION } from "@splyce/pi/contracts";
import { Store, StoreError } from "../../packages/splyce-pi/dist/store.js";

const CHILD = fileURLToPath(new URL("./store-kill-child.ts", import.meta.url));

const fixtures = JSON.parse(
  readFileSync(
    new URL("../fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;

const caller = {
  sessionId: "s1",
  configRevision: "cfg1",
  profileRevision: "profile1",
  policyRevision: "policy1",
  resolveReference: () => true,
};

let counter = 0;
const record = (
  kind: keyof typeof fixtures,
  overrides: Record<string, unknown> = {},
) => {
  counter += 1;
  const base = structuredClone(fixtures[kind]) as Record<string, unknown>;
  base.recordId = `rec-${String(counter)}`;
  base.scopeId = "w-demo";
  return Object.assign(base, overrides);
};

const trials = Number(process.env["J0_TRIALS"] ?? "1");
const tmpRoot = mkdtempSync(join(tmpdir(), "j0-store-"));
let tmpCounter = 0;
const freshDir = () => {
  tmpCounter += 1;
  const dir = join(tmpRoot, `t${String(tmpCounter)}`);
  mkdirSync(dir);
  return dir;
};

const waitFor = (file: string, timeoutMs = 15000) => {
  const start = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timeout waiting ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
};

const killTree = (pid: number) => {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], {
    stdio: "ignore",
  });
  if (result.status !== 0)
    throw new Error(`taskkill failed for ${String(pid)}`);
};

const spawnChild = (mode: string, dir: string) =>
  spawn(process.execPath, [CHILD, mode, dir], { stdio: "ignore" });

test("S1 fresh commit and reopen", () => {
  for (let i = 0; i < trials; i += 1) {
    const dir = freshDir();
    const path = join(dir, "store.db");
    const store = Store.open(path);
    const input = record("run");
    const appended = store.append({ kind: "run", record: input }, caller);
    const cursorAfter = store.cursor();
    store.close();

    const reopened = Store.open(path);
    const got = reopened.get(input.recordId as string);
    assert.equal(got.seq, appended.seq);
    assert.equal(
      (got.record as Record<string, unknown>).schemaVersion,
      CONTRACT_VERSION,
    );
    assert.equal(reopened.cursor(), appended.seq);
    assert.equal(cursorAfter, appended.seq);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`S1 n=${String(trials)} pass`);
});

test("S2 forced kill mid-transaction (child processes)", () => {
  for (let i = 0; i < trials; i += 1) {
    // killed after acknowledged commit: the record must be present.
    {
      const dir = freshDir();
      const child = spawnChild("commit-then-signal", dir);
      waitFor(join(dir, "ack.json"));
      const ack = JSON.parse(readFileSync(join(dir, "ack.json"), "utf8")) as {
        seq: number;
      };
      killTree(child.pid as number);
      const reopened = Store.open(join(dir, "store.db"));
      assert.ok(reopened.cursor() >= ack.seq);
      const got = reopened.get("rec-child-ack");
      assert.equal(got.seq, ack.seq);
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
    // killed inside an open transaction: nothing committed, never partial.
    {
      const dir = freshDir();
      const child = spawnChild("mid-transaction", dir);
      waitFor(join(dir, "mid.json"));
      killTree(child.pid as number);
      const reopened = Store.open(join(dir, "store.db"));
      // the acknowledged first append survives; the uncommitted one must not.
      assert.ok(reopened.get("rec-child-open"));
      assert.throws(() => reopened.get("rec-uncommitted"), StoreError);
      const { records } = reopened.list("w-demo");
      assert.ok(!records.some((r) => r.record.recordId === "rec-uncommitted"));
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`S2 n=${String(trials * 2)} pass (2 kills per trial)`);
});

test("S3 unwritable target: explicit error, no acknowledgement, no fallback", () => {
  for (let i = 0; i < trials; i += 1) {
    const dir = freshDir();
    const path = join(dir, "store.db");
    const store = Store.open(path);
    const seeded = store.append({ kind: "run", record: record("run") }, caller);
    store.close();

    // (a) explicitly read-only handle: the write fails before any
    // acknowledgement and nothing silently falls back to memory.
    const readOnly = Store.open(path, { readOnly: true });
    assert.throws(
      () => readOnly.append({ kind: "run", record: record("run") }, caller),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "STORE_READ_ONLY" &&
        error.errcode === 8,
    );
    readOnly.close();

    // (b) read-only file attribute: opening/committing fails closed.
    chmodSync(path, 0o444);
    let refused = false;
    try {
      const ro = Store.open(path);
      try {
        ro.append({ kind: "run", record: record("run") }, caller);
      } finally {
        ro.close();
      }
    } catch (error) {
      refused = error instanceof StoreError;
    }
    assert.ok(refused, "read-only file must fail closed");
    chmodSync(path, 0o666);

    // No acknowledged change: the durable cursor is still the seeded one.
    const verify = Store.open(path);
    assert.equal(verify.cursor(), seeded.seq);
    verify.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`S3 n=${String(trials)} pass`);
});

test("S4 corrupt or truncated file fails closed", () => {
  for (let i = 0; i < trials; i += 1) {
    // (a) garbage bytes are not a store.
    const dir = freshDir();
    const path = join(dir, "garbage.db");
    writeFileSync(
      path,
      Buffer.from("definitely not a sqlite database file"),
      "utf8",
    );
    assert.throws(
      () => Store.open(path),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "STORE_CORRUPT" &&
        error.errcode === 26,
    );
    rmSync(dir, { recursive: true, force: true });

    // (b) a truncated/garbage -wal beside a copy: reopen stays readable with
    // no partial or invented data.
    const dir2 = freshDir();
    const path2 = join(dir2, "store.db");
    const store = Store.open(path2);
    const input = record("run");
    const appended = store.append({ kind: "run", record: input }, caller);
    store.close();
    copyFileSync(path2, join(dir2, "copy.db"));
    // Simulate a truncated/garbage WAL left beside the copy. After a clean
    // close SQLite checkpoints and removes the WAL, so we overwrite whatever
    // is (or is not) there with junk bytes.
    writeFileSync(
      join(dir2, "copy.db-wal"),
      Buffer.from("junk-wal-bytes"),
      "utf8",
    );
    const reopened = Store.open(join(dir2, "copy.db"));
    // No partial read and no invented data: exactly the acknowledged record.
    const { records, skippedUnknownSchema } = reopened.list("w-demo");
    assert.equal(skippedUnknownSchema, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.seq, appended.seq);
    assert.equal(records[0]?.record.recordId, input.recordId);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
  console.log(`S4 n=${String(trials * 2)} pass (garbage + truncated wal)`);
});

test("S5 unknown required schema is rejected on read; the rest stays readable", () => {
  for (let i = 0; i < trials; i += 1) {
    const dir = freshDir();
    const store = Store.open(join(dir, "store.db"));
    const first = record("run");
    const second = record("run");
    store.append({ kind: "run", record: first }, caller);
    store.append({ kind: "run", record: second }, caller);
    store.close();
    const raw = new DatabaseSync(join(dir, "store.db"), { timeout: 5000 });
    raw
      .prepare("UPDATE records SET schema_version = ? WHERE record_id = ?")
      .run(999, second.recordId);
    raw.close();

    const reopened = Store.open(join(dir, "store.db"));
    assert.throws(
      () => reopened.get(second.recordId as string),
      (error: unknown) =>
        error instanceof StoreError && error.code === "UNKNOWN_SCHEMA",
    );
    const got = reopened.get(first.recordId as string);
    assert.equal(got.record.recordId, first.recordId);
    const listed = reopened.list("w-demo");
    assert.equal(listed.records.length, 1);
    assert.equal(listed.skippedUnknownSchema, 1);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`S5 n=${String(trials)} pass`);
});

test("S6 second writer: one commits, the other gets a busy error; no lost update", () => {
  for (let i = 0; i < trials; i += 1) {
    const dir = freshDir();
    const path = join(dir, "store.db");
    const store = Store.open(path);
    store.append({ kind: "run", record: record("run") }, caller);

    const child = spawnChild("busy-hold", dir);
    waitFor(join(dir, "held.json"));

    // Zero-ish timeout: the parent's second write must fail explicitly — the
    // busy error surfaces at open (migration is a write transaction) or at
    // append; either way it is explicit, before any acknowledgement.
    let contender: Store | undefined;
    let refused = false;
    try {
      contender = Store.open(path, { busyTimeoutMs: 200 });
      assert.throws(
        () => contender?.append({ kind: "run", record: record("run") }, caller),
        (error: unknown) =>
          error instanceof StoreError && error.code === "STORE_BUSY",
      );
    } catch (error) {
      refused = error instanceof StoreError && error.code === "STORE_BUSY";
      if (!refused) throw error;
    } finally {
      // Always release the holder, even when the assertion above fails.
      writeFileSync(join(dir, "release.json"), "{}", "utf8");
      contender?.close();
    }
    assert.ok(refused, "second writer must be refused with STORE_BUSY");

    // The holder commits; nothing is lost or interleaved.
    waitFor(join(dir, "child-trace-committed.json"));
    store.close();
    const reopened = Store.open(path);
    assert.ok(reopened.get("rec-child-second"));
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`S6 n=${String(trials)} pass`);
});

test("S7 backup and restore with deletion-epoch guard", () => {
  for (let i = 0; i < trials; i += 1) {
    const dir = freshDir();
    const path = join(dir, "store.db");
    const store = Store.open(path);
    const a = record("run");
    const b = record("run");
    store.append({ kind: "run", record: a }, caller);
    store.append({ kind: "run", record: b }, caller);

    // Delete A, snapshot; then delete B: the snapshot's deletion epoch (1) is
    // behind the live epoch (2), so restoring it would lose B's tombstone.
    store.noteDeletion(a.recordId as string);
    const backupPath = join(dir, "backup.db");
    store.backup(backupPath);
    store.noteDeletion(b.recordId as string);
    assert.throws(
      () => store.restore(backupPath),
      (error: unknown) =>
        error instanceof StoreError && error.code === "STALE_RESTORE",
    );

    // A current-epoch snapshot restores cleanly, and the restore is
    // observable: post-snapshot record `c` is gone afterwards.
    const freshBackup = join(dir, "backup2.db");
    store.backup(freshBackup);
    const c = record("run");
    store.append({ kind: "run", record: c }, caller);
    store.close();

    const reopened = Store.open(path);
    reopened.restore(freshBackup);
    assert.ok(reopened.get(a.recordId as string));
    assert.ok(reopened.get(b.recordId as string));
    assert.throws(() => reopened.get(c.recordId as string), StoreError);
    assert.equal(Store.deletionEpochOf(path), 2);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`S7 n=${String(trials)} pass`);
});

test("batch rollback: duplicate mid-batch leaves nothing acknowledged and the handle clean", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const dup = record("run");
  assert.throws(() =>
    store.appendBatch(
      [
        { kind: "run", record: dup },
        { kind: "run", record: dup }, // same record_id: UNIQUE violation mid-batch
      ],
      caller,
    ),
  );
  // The same handle rolls back cleanly and the next write succeeds.
  const next = store.append({ kind: "run", record: record("run") }, caller);
  assert.equal(next.seq, 1);
  store.close();

  // From a fresh connection: exactly the post-rollback acknowledged write.
  const verify = Store.open(path);
  assert.equal(verify.cursor(), 1);
  const { records } = verify.list("w-demo");
  assert.equal(records.length, 1);
  verify.close();
  rmSync(dir, { recursive: true, force: true });
});

test("durable canonical-workspace ownership: single writer, CAS epoch", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const ws = "C:\\workspaces\\demo"; // canonical workspace id

  // First writer wins; epoch starts at 1.
  const a = store.acquireWorkspace(ws, "session-a");
  assert.equal(a.ownerSessionId, "session-a");
  assert.equal(a.epoch, 1);

  // A second session cannot acquire a live workspace.
  assert.throws(
    () => store.acquireWorkspace(ws, "session-b"),
    (error: unknown) =>
      error instanceof StoreError && error.code === "OWNERSHIP_CONFLICT",
  );

  // Renewal is a CAS on the epoch: stale epochs are refused.
  const renewed = store.renewWorkspace(ws, "session-a", 1);
  assert.equal(renewed.epoch, 2);
  assert.throws(
    () => store.renewWorkspace(ws, "session-a", 1),
    (error: unknown) =>
      error instanceof StoreError && error.code === "OWNERSHIP_STALE_EPOCH",
  );
  assert.throws(
    () => store.renewWorkspace(ws, "session-b", 2),
    (error: unknown) =>
      error instanceof StoreError && error.code === "OWNERSHIP_CONFLICT",
  );

  // Release requires the current epoch; afterwards another session acquires.
  assert.throws(
    () => store.releaseWorkspace(ws, "session-a", 1),
    (error: unknown) =>
      error instanceof StoreError && error.code === "OWNERSHIP_STALE_EPOCH",
  );
  store.releaseWorkspace(ws, "session-a", 2); // release advances the fence to 3
  assert.equal(store.workspaceOwner(ws), undefined);
  const b = store.acquireWorkspace(ws, "session-b");
  assert.equal(b.epoch, 4); // epochs never repeat, even after release

  // Ownership survives reopen: it is durable state, not memory.
  store.close();
  const reopened = Store.open(path);
  const owner = reopened.workspaceOwner(ws);
  assert.equal(owner?.ownerSessionId, "session-b");
  assert.equal(owner?.epoch, 4);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("stale ownership epochs can never revalidate across workspaces", () => {
  const dir = freshDir();
  const store = Store.open(join(dir, "store.db"));
  const w1 = "C:\\workspaces\\one";
  const w2 = "C:\\workspaces\\two";

  const a1 = store.acquireWorkspace(w1, "s-a"); // epoch 1
  const b1 = store.acquireWorkspace(w2, "s-b"); // epoch 2
  assert.equal(a1.epoch, 1);
  assert.equal(b1.epoch, 2);

  // b renews -> 3, releases; a renews from epoch 1 -> must be 4 (global), so
  // b's stale epoch 3 can never revalidate on re-acquire (gets 5).
  const b3 = store.renewWorkspace(w2, "s-b", 2);
  assert.equal(b3.epoch, 3);
  store.releaseWorkspace(w2, "s-b", 3); // release advances the fence to 4
  const a4 = store.renewWorkspace(w1, "s-a", 1);
  assert.equal(a4.epoch, 5);
  const b5 = store.acquireWorkspace(w2, "s-b");
  assert.equal(b5.epoch, 6);
  assert.throws(
    () => store.renewWorkspace(w2, "s-b", 3),
    (error: unknown) =>
      error instanceof StoreError && error.code === "OWNERSHIP_STALE_EPOCH",
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a stamped v1 store with missing tables fails closed, never healed", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  // Build a database that claims layout_version 1 but has no store tables
  // (interrupted initialization) — open must refuse it, not create them.
  const raw = new DatabaseSync(path, { timeout: 5000 });
  raw.exec(
    "CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  raw
    .prepare(
      "INSERT INTO store_meta (key, value) VALUES ('layout_version', '2')",
    )
    .run();
  raw.close();

  assert.throws(
    () => Store.open(path),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "STORE_LAYOUT" &&
      typeof error.message === "string" &&
      error.message.includes("records"),
  );
  // The refused store stays untouched: no healing happened.
  const verify = new DatabaseSync(path, { readOnly: true });
  const tables = (
    verify
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  verify.close();
  assert.ok(!tables.includes("records"));
  rmSync(dir, { recursive: true, force: true });
});

test("S8 export and import: ids, ordering and schemaVersion survive", () => {
  for (let i = 0; i < trials; i += 1) {
    const dir = freshDir();
    const source = Store.open(join(dir, "source.db"));
    const one = record("run");
    const two = record("run");
    source.append({ kind: "run", record: one }, caller);
    source.append({ kind: "run", record: two }, caller);
    const jsonl = join(dir, "export.jsonl");
    const count = source.exportJSONL(jsonl);
    assert.equal(count, 2);
    source.close();

    const target = Store.open(join(dir, "target.db"));
    target.importJSONL(jsonl, caller);
    const listed = target.list("w-demo");
    assert.equal(listed.records.length, 2);
    assert.equal(listed.records[0]?.record.recordId, one.recordId);
    assert.equal(listed.records[1]?.record.recordId, two.recordId);
    assert.equal(
      (listed.records[1]?.record as Record<string, unknown>).schemaVersion,
      CONTRACT_VERSION,
    );
    target.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`S8 n=${String(trials)} pass`);
});

test("failed writes acknowledge no durability", () => {
  const dir = freshDir();
  const store = Store.open(join(dir, "store.db"));
  const before = store.cursor();
  // A non-object payload violates the record contract (JSON object shape).
  assert.throws(() =>
    store.append({ kind: "run", record: "not-a-record" }, caller),
  );
  assert.equal(store.cursor(), before);

  // Atomic batch: an invalid member rolls the whole batch back.
  assert.throws(() =>
    store.appendBatch(
      [
        { kind: "run", record: record("run") },
        { kind: "run", record: "not-a-record" },
      ],
      caller,
    ),
  );
  const listed = store.list("w-demo");
  assert.equal(listed.records.length, before);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("restore preserves live records when the backup is invalid or future-layout", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const live = record("run");
  store.append({ kind: "run", record: live }, caller);

  // Garbage file: not a database at all.
  const garbage = join(dir, "garbage.db");
  writeFileSync(garbage, "this is not sqlite", "utf8");
  assert.throws(() => store.restore(garbage));

  // Valid SQLite but a future layout stamp.
  const future = join(dir, "future.db");
  const fdb = new DatabaseSync(future);
  fdb.exec(
    "CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  fdb.prepare("INSERT INTO store_meta VALUES ('layout_version', '2')").run();
  fdb.close();
  assert.throws(() => store.restore(future));

  // Live acknowledged records are untouched after every failed restore.
  assert.equal(store.get(live.recordId as string).seq, 1);
  assert.equal(store.cursor(), 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("backup without epoch metadata but with history is refused, never zero", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const a = record("run");
  store.append({ kind: "run", record: a }, caller);
  store.noteDeletion(a.recordId as string);
  const backupPath = join(dir, "backup.db");
  store.backup(backupPath);

  // Strip the epoch metadata from the backup copy: history remains.
  const stripped = join(dir, "stripped.db");
  copyFileSync(backupPath, stripped);
  const raw = new DatabaseSync(stripped);
  raw.prepare("DELETE FROM store_meta WHERE key = 'deletion_epoch'").run();
  raw.close();

  assert.throws(
    () => store.restore(stripped),
    (error: unknown) =>
      error instanceof StoreError && error.code === "STORE_LAYOUT",
  );
  // The live store still serves its acknowledged state.
  assert.equal(store.cursor(), 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("restore never rolls back workspace ownership to permit a second writer", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const backupPath = join(dir, "backup.db");
  store.backup(backupPath); // taken before any ownership existed

  // Live: a session acquires ownership (global epoch 1).
  store.acquireWorkspace("C:\\ws\\demo", "session-a");

  // Restoring the pre-ownership snapshot would resurrect an unowned (or
  // stale-owner) state and permit a second writer � it is refused.
  assert.throws(
    () => store.restore(backupPath),
    (error: unknown) =>
      error instanceof StoreError && error.code === "STALE_OWNERSHIP",
  );
  // Ownership survived the failed restore.
  const owner = store.workspaceOwner("C:\\ws\\demo");
  assert.equal(owner?.ownerSessionId, "session-a");
  assert.equal(owner?.epoch, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("read-only open validates, reads, and rejects writes explicitly", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const a = record("run");
  store.append({ kind: "run", record: a }, caller);
  store.close();

  const ro = Store.open(path, { readOnly: true });
  assert.equal(ro.cursor(), 1);
  assert.equal(ro.get(a.recordId as string).record.recordId, a.recordId);
  assert.throws(
    () => ro.append({ kind: "run", record: record("run") }, caller),
    (error: unknown) =>
      error instanceof StoreError && error.code === "STORE_READ_ONLY",
  );
  assert.throws(
    () => ro.noteDeletion(a.recordId as string),
    (error: unknown) =>
      error instanceof StoreError && error.code === "STORE_READ_ONLY",
  );
  ro.close();
  rmSync(dir, { recursive: true, force: true });
});

test("release advances the ownership fence: pre-release backup cannot resurrect the owner", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const ws = "C:\\ws\\fence";
  store.acquireWorkspace(ws, "session-a"); // epoch 1
  const backupPath = join(dir, "backup.db");
  store.backup(backupPath); // carries ownership epoch 1 with owner A
  store.releaseWorkspace(ws, "session-a", 1); // live fence advances to 2

  // Restoring the pre-release snapshot would resurrect released owner A with
  // a stale token and block session B � refused.
  assert.throws(
    () => store.restore(backupPath),
    (error: unknown) =>
      error instanceof StoreError && error.code === "STALE_OWNERSHIP",
  );
  // The released state survived the refused restore; B can acquire.
  assert.equal(store.workspaceOwner(ws), undefined);
  const b = store.acquireWorkspace(ws, "session-b");
  assert.equal(b.epoch, 3);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("restore stages the replacement and preserves live data on staging failure", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const live = record("run");
  store.append({ kind: "run", record: live }, caller);
  const backupPath = join(dir, "backup.db");
  store.backup(backupPath);
  store.append({ kind: "run", record: record("run") }, caller);

  // A directory occupies the staging path: the staging copy cannot be made,
  // so restore must fail before ANY live byte is swapped.
  mkdirSync(`${path}.restore-staging`);
  assert.throws(() => store.restore(backupPath));
  assert.equal(store.cursor(), 2);
  assert.ok(store.get(live.recordId as string));
  store.close();

  // A successful restore leaves no preserved original behind.
  const reopened = Store.open(path);
  reopened.restore(backupPath);
  assert.ok(!existsSync(`${path}.restore-original`));
  assert.ok(!existsSync(`${path}.restore-staging`));
  assert.equal(reopened.cursor(), 1); // backup state, per restore semantics
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("malformed epoch metadata fails closed everywhere", () => {
  for (const bad of ["abc", "-3", "1.5", "9007199254740992"]) {
    const dir = freshDir();
    const path = join(dir, "store.db");
    const store = Store.open(path);
    store.append({ kind: "run", record: record("run") }, caller);
    const del = record("run");
    store.append({ kind: "run", record: del }, caller);
    store.noteDeletion(del.recordId as string); // creates deletion_epoch row
    store.close();
    const raw = new DatabaseSync(path);
    raw
      .prepare("UPDATE store_meta SET value = ? WHERE key = 'deletion_epoch'")
      .run(bad);
    raw.close();
    const tampered = Store.open(path);
    // Reads, writes and epoch guards all refuse the corrupt counter.
    assert.throws(() => tampered.deletionEpoch(), StoreError);
    assert.throws(() => tampered.noteDeletion("rec-x"), StoreError);
    tampered.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // Ownership side: malformed ownership_epoch refuses restore and acquire.
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const backupPath = join(dir, "backup.db");
  store.acquireWorkspace("C:\\ws\\seed", "s0"); // creates ownership_epoch row
  store.backup(backupPath);
  store.close();
  const raw = new DatabaseSync(path);
  raw
    .prepare("UPDATE store_meta SET value = '-1' WHERE key = 'ownership_epoch'")
    .run();
  raw.close();
  const tampered = Store.open(path);
  assert.throws(
    () => tampered.restore(backupPath),
    (error: unknown) =>
      error instanceof StoreError && error.code === "STORE_LAYOUT",
  );
  assert.throws(
    () => tampered.acquireWorkspace("C:\\ws\\x", "s"),
    (error: unknown) =>
      error instanceof StoreError && error.code === "STORE_LAYOUT",
  );
  tampered.close();
  rmSync(dir, { recursive: true, force: true });
});

test("first-swap rename failure preserves live bytes and keeps the handle usable", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const live = record("run");
  store.append({ kind: "run", record: live }, caller);
  const backupPath = join(dir, "backup.db");
  store.backup(backupPath);
  store.append({ kind: "run", record: record("run") }, caller);

  // A directory occupies the recovery path: the live->original rename can
  // never succeed, so restore must fail closed BEFORE closing the live
  // handle and must never delete or move the live file.
  mkdirSync(`${path}.restore-original`);
  assert.throws(
    () => store.restore(backupPath),
    (error: unknown) =>
      error instanceof StoreError && error.code === "STORE_RESTORE_COLLISION",
  );
  // The live store is untouched and still fully usable on the same handle.
  assert.equal(store.cursor(), 2);
  assert.ok(store.get(live.recordId as string));
  store.append({ kind: "run", record: record("run") }, caller);
  assert.equal(store.cursor(), 3);
  store.close();

  // From a fresh connection the acknowledged data is all still there.
  const verify = Store.open(path);
  assert.equal(verify.cursor(), 3);
  verify.close();
  rmSync(dir, { recursive: true, force: true });
});

test("v1 stores refuse to open until explicit migrateV1; migration preserves bytes", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  // Build a genuine v1 store: old records columns, stamped layout 1, with a
  // committed record written before session attribution existed.
  const raw = new DatabaseSync(path);
  raw.exec(
    "CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  raw.exec(
    "CREATE TABLE records (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, " +
      "record_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL, scope_id TEXT NOT NULL, " +
      "created_at TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  raw.exec(
    "CREATE TABLE deletions (record_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, deleted_at TEXT NOT NULL)",
  );
  raw.exec(
    "CREATE TABLE workspace_ownership (workspace_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, " +
      "epoch INTEGER NOT NULL, acquired_at TEXT NOT NULL, renewed_at TEXT NOT NULL)",
  );
  raw.prepare("INSERT INTO store_meta VALUES ('layout_version', '1')").run();
  raw.close();

  // open() refuses a v1 store � explicit migration only, never silent.
  assert.throws(
    () => Store.open(path),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "STORE_LAYOUT" &&
      error.message.includes("migrateV1"),
  );

  // migrateV1 adds session attribution and stamps 2 without touching rows.
  Store.migrateV1(path);
  const migrated = Store.open(path);
  assert.equal(migrated.cursor(), 0);
  migrated.close();

  // After migration, appends attribute sessions and replay stays scoped.
  const store = Store.open(path);
  const a = record("run");
  const callerS1 = { ...caller, sessionId: "s1" };
  store.append({ kind: "run", record: a }, callerS1);
  assert.equal(store.cursor(), 1);
  const scoped = store.list("w-demo", 0, "s1");
  assert.equal(scoped.records.length, 1);
  store.close();

  // migrateV1 refuses to run twice (store is now v2).
  assert.throws(
    () => Store.migrateV1(path),
    (error: unknown) => error instanceof StoreError,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("populated v1 migration requires explicit attribution and preserves replay", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  // Build a populated v1 store: a committed run record written before
  // session attribution existed.
  const raw = new DatabaseSync(path);
  raw.exec(
    "CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  raw.exec(
    "CREATE TABLE records (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, " +
      "record_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL, scope_id TEXT NOT NULL, " +
      "created_at TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  raw.exec(
    "CREATE TABLE deletions (record_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, deleted_at TEXT NOT NULL)",
  );
  raw.exec(
    "CREATE TABLE workspace_ownership (workspace_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, " +
      "epoch INTEGER NOT NULL, acquired_at TEXT NOT NULL, renewed_at TEXT NOT NULL)",
  );
  raw.prepare("INSERT INTO store_meta VALUES ('layout_version', '1')").run();
  const legacy = JSON.parse(
    readFileSync(
      new URL("../fixtures/contracts/records.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, Record<string, unknown>>;
  raw
    .prepare(
      "INSERT INTO records (kind, record_id, schema_version, scope_id, created_at, payload) VALUES ('run', ?, 1, 'w-demo', '2026-10-26T00:00:00.000Z', ?)",
    )
    .run(
      "rec-legacy",
      JSON.stringify({
        ...legacy.run,
        recordId: "rec-legacy",
        scopeId: "w-demo",
      }),
    );
  raw.close();

  // Populated v1 + no attribution: refused, never a silent session-less row.
  assert.throws(
    () => Store.migrateV1(path),
    (error: unknown) =>
      error instanceof StoreError && error.message.includes("attribution"),
  );

  // Explicit attribution: the old session's records stay replayable.
  Store.migrateV1(path, { sessionId: "s-legacy" });
  const migrated = Store.open(path);
  const scoped = migrated.list("w-demo", 0, "s-legacy");
  assert.equal(scoped.records.length, 1);
  assert.equal(
    (scoped.records[0]?.record as { recordId: string }).recordId,
    "rec-legacy",
  );
  // Another session still sees nothing of it.
  assert.equal(migrated.list("w-demo", 0, "s-new").records.length, 0);
  migrated.close();
  rmSync(dir, { recursive: true, force: true });
});

test("appendBatch idempotency precondition is atomic: second committer sees the row", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const fixtures = JSON.parse(
    readFileSync(
      new URL("../fixtures/contracts/records.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, Record<string, unknown>>;

  // First commit with the absent-key precondition succeeds.
  const first = {
    ...structuredClone(fixtures.action),
    recordId: "rec-a1",
    idempotencyKey: "idem-1",
  } as Record<string, unknown>;
  const r1 = store.appendBatch([{ kind: "action", record: first }], caller, {
    scopeId: "w-demo",
    idempotencyKey: "idem-1",
    actionId: "a-new-1",
  });
  assert.equal(r1.seqs.length, 1);
  const cursorAfterFirst = store.cursor();

  // A second committer that observed the key absent BEFORE the first commit
  // loses the race atomically: the check runs under the same BEGIN IMMEDIATE
  // as the inserts, so it sees the committed row and appends nothing.
  const second = {
    ...structuredClone(fixtures.action),
    recordId: "rec-a2",
    actionId: "a2",
    idempotencyKey: "idem-1",
  } as Record<string, unknown>;
  assert.throws(
    () =>
      store.appendBatch([{ kind: "action", record: second }], caller, {
        scopeId: "w-demo",
        idempotencyKey: "idem-1",
        actionId: "a2",
      }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "ACTION_ALREADY_EXISTS",
  );
  assert.equal(store.cursor(), cursorAfterFirst); // nothing appended

  // A different key commits normally under the same precondition.
  const third = {
    ...structuredClone(fixtures.action),
    recordId: "rec-a3",
    actionId: "a3",
    idempotencyKey: "idem-2",
  } as Record<string, unknown>;
  const r3 = store.appendBatch([{ kind: "action", record: third }], caller, {
    scopeId: "w-demo",
    idempotencyKey: "idem-2",
    actionId: "a-new-2",
  });
  assert.equal(r3.seqs.length, 1);
  store.close();

  // Cross-connection contention: a second store handle on the same file also
  // loses the race against the committed row.
  const store2 = Store.open(path, { busyTimeoutMs: 2000 });
  const fourth = {
    ...structuredClone(fixtures.action),
    recordId: "rec-a4",
    actionId: "a4",
    idempotencyKey: "idem-1",
  } as Record<string, unknown>;
  assert.throws(
    () =>
      store2.appendBatch([{ kind: "action", record: fourth }], caller, {
        scopeId: "w-demo",
        idempotencyKey: "idem-1",
        actionId: "a4",
      }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "ACTION_ALREADY_EXISTS",
  );
  store2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("appendBatch can require a same-commit ownership epoch", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const ws = "C:\\ws\\idem";
  const acquired = store.acquireWorkspace(ws, "session-a"); // epoch 1
  const fixtures = JSON.parse(
    readFileSync(
      new URL("../fixtures/contracts/records.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, Record<string, unknown>>;

  // Matching epoch: decision+intent append and ownership check in one txn.
  const record = {
    ...structuredClone(fixtures.action),
    recordId: "rec-owned",
  } as Record<string, unknown>;
  const ok = store.appendBatch(
    [{ kind: "action", record }],
    caller,
    undefined,
    { workspaceId: ws, epoch: acquired.epoch },
  );
  assert.equal(ok.seqs.length, 1);

  // Stale epoch (owner released, fence advanced): refused, nothing appended.
  store.releaseWorkspace(ws, "session-a", acquired.epoch);
  const cursorBefore = store.cursor();
  assert.throws(
    () =>
      store.appendBatch(
        [{ kind: "action", record: { ...record, recordId: "rec-owned2" } }],
        caller,
        undefined,
        { workspaceId: ws, epoch: acquired.epoch },
      ),
    (error: unknown) =>
      error instanceof StoreError && error.code === "OWNERSHIP_STALE_EPOCH",
  );
  assert.equal(store.cursor(), cursorBefore);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("appendBatch precondition rejects an existing actionId with a new key", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const fixtures = JSON.parse(
    readFileSync(
      new URL("../fixtures/contracts/records.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, Record<string, unknown>>;
  const first = {
    ...structuredClone(fixtures.action),
    recordId: "rec-pa1",
  } as Record<string, unknown>; // actionId a1, idempotencyKey key1 (fixture)
  store.appendBatch([{ kind: "action", record: first }], caller, {
    scopeId: "w-demo",
    idempotencyKey: "key1",
    actionId: "a1",
  });
  const cursor = store.cursor();

  // A second host permit ID: new actionId check target but SAME logical
  // action attempted under a NEW key with the OLD actionId -> refused.
  const second = {
    ...structuredClone(fixtures.action),
    recordId: "rec-pa2",
    idempotencyKey: "brand-new-key",
  } as Record<string, unknown>;
  assert.throws(
    () =>
      store.appendBatch([{ kind: "action", record: second }], caller, {
        scopeId: "w-demo",
        idempotencyKey: "brand-new-key",
        actionId: "a1", // existing logical action, new key
      }),
    (error: unknown) =>
      error instanceof StoreError && error.code === "ACTION_ALREADY_EXISTS",
  );
  assert.equal(store.cursor(), cursor); // nothing appended
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migrateV1 decides attribution inside its write transaction (no check-then-act race)", async () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const raw = new DatabaseSync(path);
  raw.exec(
    "CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  raw.exec(
    "CREATE TABLE records (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, " +
      "record_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL, scope_id TEXT NOT NULL, " +
      "created_at TEXT NOT NULL, payload TEXT NOT NULL)",
  );
  raw.exec(
    "CREATE TABLE deletions (record_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, deleted_at TEXT NOT NULL)",
  );
  raw.exec(
    "CREATE TABLE workspace_ownership (workspace_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, " +
      "epoch INTEGER NOT NULL, acquired_at TEXT NOT NULL, renewed_at TEXT NOT NULL)",
  );
  raw.prepare("INSERT INTO store_meta VALUES ('layout_version', '1')").run();
  raw.close();

  // A concurrent v1 writer holds the write lock with an uncommitted row and
  // commits shortly after migrateV1 starts. The empty-looking store must not
  // be migrated without attribution once that row is committed.
  const signal = join(dir, "locked");
  const writer = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const fs = require("node:fs");
       const db = new DatabaseSync(process.argv[1], { timeout: 10000 });
       db.exec("BEGIN IMMEDIATE;");
       db.prepare("INSERT INTO records (kind, record_id, schema_version, scope_id, created_at, payload) VALUES ('run', 'rec-race', 1, 'w-demo', '2026-10-26T00:00:00.000Z', '{}')").run();
       fs.writeFileSync(process.argv[2], "1");
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
       db.exec("COMMIT;");
       db.close();`,
      path,
      signal,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise<number | null>((resolve) =>
    writer.once("exit", resolve),
  );
  let writerExit: number | null | undefined;
  void exited.then((code) => (writerExit = code));
  // Bounded wait: a writer that crashes or never locks fails the test
  // instead of hanging it.
  const deadline = Date.now() + 10_000;
  while (!existsSync(signal)) {
    assert.equal(writerExit, undefined, "writer exited before taking the lock");
    assert.ok(Date.now() < deadline, "writer never took the lock");
    await new Promise((r) => setTimeout(r, 10));
  }

  let migrateError: unknown;
  try {
    Store.migrateV1(path);
  } catch (error) {
    migrateError = error;
  }
  // Check the writer first: if its commit failed, the store really was empty
  // and a clean migration would be correct, so the harness is what broke.
  assert.equal(await exited, 0, "writer must commit cleanly");
  assert.ok(
    migrateError instanceof StoreError &&
      migrateError.message.includes("attribution"),
    `expected an attribution refusal, got ${String(migrateError)}`,
  );
  const check = new DatabaseSync(path);
  const layout = check
    .prepare("SELECT value FROM store_meta WHERE key = 'layout_version'")
    .get() as { value: string };
  assert.equal(layout.value, "1");
  check.close();
  rmSync(dir, { recursive: true, force: true });
});
