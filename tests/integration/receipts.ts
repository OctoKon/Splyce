// TD-15 / C1_reconnect_cursor groundwork — receipt ordering, exclusive
// afterSeq replay and exactly-one resync, all against the TD-09 store.
// Frozen contract types only (no unfrozen schema shims, per itachi).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Receipts,
  ReceiptsError,
} from "../../packages/splyce-pi/dist/receipts.js";
import { Store } from "../../packages/splyce-pi/dist/store.js";
import { CONTRACT_VERSION } from "@splyce/pi/contracts";

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
const record = (recordId: string) => {
  counter += 1;
  const base = structuredClone(fixtures.run) as Record<string, unknown>;
  base.recordId = recordId;
  base.scopeId = "w-demo";
  return base;
};

const tmpRoot = mkdtempSync(join(tmpdir(), "td15-receipts-"));
let tmpCounter = 0;
const freshDir = () => {
  tmpCounter += 1;
  const dir = join(tmpRoot, `t${String(tmpCounter)}`);
  mkdirSync(dir);
  return dir;
};

const openReceipts = (dir: string): { store: Store; receipts: Receipts } => {
  const store = Store.open(join(dir, "store.db"));
  return { store, receipts: new Receipts(store) };
};

test("receipt ordering: one atomic chain, failed pre-effect write prevents dispatch", () => {
  const dir = freshDir();
  const { store, receipts } = openReceipts(dir);
  const one = record("rec-r1");
  const two = record("rec-r2");
  const acks = receipts.commitStages(
    [
      { kind: "run", record: one },
      { kind: "run", record: two },
    ],
    caller,
  );
  // Ordered, ascending, and each ack is durable on reopen.
  assert.ok(acks.seqs[0]! < acks.seqs[1]!);
  const reopeStore = Store.open(join(dir, "store.db"));
  assert.equal(reopeStore.get("rec-r1").seq, acks.seqs[0]);
  assert.equal(reopeStore.get("rec-r2").seq, acks.seqs[1]);
  reopeStore.close();

  // A member that passes validation but fails at insert (duplicate recordId)
  // rolls back the already-inserted rec-r3 and acknowledges nothing.
  const before = receipts.durableCursor("w-demo");
  assert.throws(() =>
    receipts.commitStages(
      [
        { kind: "run", record: record("rec-r3") },
        { kind: "run", record: record("rec-r1") },
      ],
      caller,
    ),
  );
  assert.equal(receipts.durableCursor("w-demo"), before);
  assert.throws(() => store.get("rec-r3"));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("afterSeq replay is exclusive and cursor-bounded", () => {
  const dir = freshDir();
  const { store, receipts } = openReceipts(dir);
  const one = record("rec-p1");
  const two = record("rec-p2");
  receipts.commitStages(
    [
      { kind: "run", record: one },
      { kind: "run", record: two },
    ],
    caller,
  );
  const cursor = receipts.durableCursor("w-demo");

  // Exclusive: replay at 0 delivers everything; at the cursor delivers nothing.
  const all = receipts.replay("w-demo", 0, caller);
  assert.deepEqual(
    all.records.map((r) => r.record.recordId),
    [one.recordId, two.recordId],
  );
  const none = receipts.replay("w-demo", cursor, caller);
  assert.equal(none.records.length, 0);

  // A cursor beyond the durable cursor is rejected.
  assert.throws(
    () => receipts.replay("w-demo", cursor + 1, caller),
    (error: unknown) =>
      error instanceof ReceiptsError &&
      error.code === "CONTRACT_INVALID_CURSOR",
  );

  // Delivered records carry the frozen contract version.
  assert.equal(
    (all.records[0]?.record as Record<string, unknown>).schemaVersion,
    CONTRACT_VERSION,
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("exactly one resync per session-cursor advance", () => {
  const dir = freshDir();
  const { store, receipts } = openReceipts(dir);
  receipts.commitStages([{ kind: "run", record: record("rec-s1") }], caller);
  const cursor = receipts.durableCursor("w-demo");
  // Another session's record must NOT advance s1's resync cursor.
  const other = { ...caller, sessionId: "s-other" };
  receipts.commitStages([{ kind: "run", record: record("rec-o1") }], other);

  const resync = receipts.requestResync("w-demo", caller.sessionId);
  assert.equal(resync.kind, "stream.resync");
  assert.equal(resync.fromSeq, cursor);

  // No new session-attributed durable data: a second resync is refused even
  // though another session committed (cursor stays session-exact).
  assert.throws(
    () => receipts.requestResync("w-demo", caller.sessionId),
    (error: unknown) =>
      error instanceof ReceiptsError && error.code === "RESYNC_NOT_PENDING",
  );

  // Durable progress re-arms the resync with the advanced session cursor
  // (the interleaved other-session record occupies its own global seq, so
  // the expected value is s1's session cursor, not global cursor + 1).
  receipts.commitStages([{ kind: "run", record: record("rec-s2") }], caller);
  const resync2 = receipts.requestResync("w-demo", caller.sessionId);
  assert.equal(
    resync2.fromSeq,
    store.sessionCursor("w-demo", caller.sessionId),
  );
  assert.ok(resync2.fromSeq > cursor);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("replay is session-scoped: s1 never receives s2 records in one scope", () => {
  const dir = freshDir();
  const { store, receipts } = openReceipts(dir);
  const callerS1 = { ...caller, sessionId: "s1" };
  const callerS2 = { ...caller, sessionId: "s2" };
  const one = record("rec-m1");
  const two = record("rec-m2");
  receipts.commitStages([{ kind: "run", record: one }], callerS1);
  receipts.commitStages([{ kind: "run", record: two }], callerS2);

  // s1 replay returns only s1's records, and vice versa.
  const forS1 = receipts.replay("w-demo", 0, callerS1);
  assert.deepEqual(
    forS1.records.map((r) => (r.record as { recordId: string }).recordId),
    [one.recordId],
  );
  const forS2 = receipts.replay("w-demo", 0, callerS2);
  assert.deepEqual(
    forS2.records.map((r) => (r.record as { recordId: string }).recordId),
    [two.recordId],
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("resync cursors are keyed by scope and session, not scope alone", () => {
  const dir = freshDir();
  const { store, receipts } = openReceipts(dir);
  const s2 = { ...caller, sessionId: "s2" };
  receipts.commitStages([{ kind: "run", record: record("rec-k1") }], caller);
  receipts.commitStages([{ kind: "run", record: record("rec-k2") }], s2);
  // s2 resyncs first at the higher seq; s1's first resync must still be
  // pending, at its own (lower) session cursor.
  const r2 = receipts.requestResync("w-demo", "s2");
  const r1 = receipts.requestResync("w-demo", caller.sessionId);
  assert.ok(r1.fromSeq < r2.fromSeq);
  assert.equal(r1.fromSeq, store.sessionCursor("w-demo", caller.sessionId));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
