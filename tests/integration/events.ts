import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store, StoreError } from "../../packages/splyce-pi/dist/store.js";
import type { SplyceEventDraft } from "../../packages/splyce-pi/dist/contracts.js";

const caller = {
  sessionId: "s1",
  configRevision: "cfg-0",
  profileRevision: "profile1",
  policyRevision: "policy1",
  resolveReference: () => true,
};
const records = JSON.parse(
  readFileSync(
    new URL("../fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const receipt = (id: string, scopeId = "w-demo") => ({
  kind: "run" as const,
  record: { ...records.run, recordId: id, scopeId },
});
const draft = (
  eventId: string,
  sessionId = "s1",
  scopeId = "w-demo",
  recordId = "source",
): SplyceEventDraft => ({
  schemaVersion: 1,
  protocolVersion: 2,
  eventId,
  recordId,
  createdAt: "2026-10-26T00:00:00.000Z",
  sourceIds: [recordId],
  sessionId,
  scopeId,
  durable: true,
  kind: "engine.status",
  payload: { state: "ready", activeWorkers: 0 },
});
const transient = (id: string): SplyceEventDraft => ({
  ...draft(id),
  durable: false,
  kind: "turn.stream_delta",
  payload: { runId: "source", delta: "part" },
});
const code = (expected: string) => (error: unknown) =>
  error instanceof StoreError && error.code === expected;
const key = (sessionId = "s1") =>
  `event_seq:${JSON.stringify(["w-demo", sessionId])}`;
function setup(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "splyce-events-"));
  const path = join(dir, "store.db");
  let store = Store.open(path);
  const others: Store[] = [];
  t.after(() => {
    for (const extra of others) extra.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    path,
    track(extra: Store) {
      others.push(extra);
      return extra;
    },
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = Store.open(path);
      return store;
    },
  };
}

test("C6: event sequences belong to each session, independently of interleaved receipt rows", (t) => {
  const { store } = setup(t);
  const first = store.commitEvents([receipt("source")], [draft("one")], caller);
  store.append(receipt("ordinary"), caller);
  const second = store.commitEvents([], [draft("other", "s2")], {
    ...caller,
    sessionId: "s2",
  });
  const third = store.commitEvents(
    [receipt("another")],
    [draft("two"), draft("three")],
    caller,
  );
  assert.deepEqual(
    [
      first.events[0]?.seq,
      second.events[0]?.seq,
      ...third.events.map((event) => event.seq),
    ],
    [1, 1, 2, 3],
  );
  assert.deepEqual(first.seqs, [1]);
  assert.ok(store.cursor() > store.eventCursor("w-demo", "s1"));
  assert.deepEqual(store.replayEvents("w-demo", "s1", 1), third.events);
  assert.deepEqual(store.replayEvents("w-demo", "s2"), second.events);
});

test("C6: transient highwater survives reopen and replay preserves exact durable envelopes with explicit gaps", (t) => {
  const fixture = setup(t);
  const first = fixture.store.commitEvents(
    [receipt("source")],
    [draft("one"), transient("delta")],
    caller,
  );
  assert.deepEqual(
    first.events.map((event) => event.seq),
    [1, 2],
  );
  assert.equal(fixture.store.eventCursor("w-demo", "s1"), 1);
  assert.equal(fixture.store.eventHighwater("w-demo", "s1"), 2);
  assert.equal(fixture.reopen().eventHighwater("w-demo", "s1"), 2);
  assert.equal(fixture.store.eventHighwater("w-demo", "s2"), 0);
  const next = fixture.reopen().commitEvents([], [draft("three")], caller);
  assert.equal(next.events[0]?.seq, 3);
  assert.equal(
    JSON.stringify(fixture.store.replayEvents("w-demo", "s1")),
    JSON.stringify([first.events[0], next.events[0]]),
  );
  assert.equal(
    fixture.store
      .list("w-demo")
      .records.some((entry) =>
        JSON.stringify(entry.record).includes('"delta"'),
      ),
    false,
  );
  assert.throws(
    () => fixture.store.replayEvents("w-demo", "s2", 1),
    code("INVALID_CURSOR"),
  );
});

test("C6: invalid event, failed SQL and missing source roll back receipts and sequence reservations", (t) => {
  const { store } = setup(t);
  store.commitEvents([receipt("source")], [draft("one")], caller);
  const before = store.cursor();
  assert.throws(() =>
    store.commitEvents(
      [receipt("invalid-event")],
      [
        draft("ok"),
        { ...draft("bad"), payload: { state: "ready", activeWorkers: -1 } },
      ],
      caller,
    ),
  );
  assert.throws(() =>
    store.commitEvents(
      [receipt("temporary"), receipt("source")],
      [draft("sql")],
      caller,
    ),
  );
  assert.throws(
    () =>
      store.commitEvents(
        [receipt("missing-source")],
        [draft("missing", "s1", "w-demo", "absent")],
        caller,
      ),
    code("EVENT_SOURCE"),
  );
  assert.equal(store.cursor(), before);
  assert.equal(store.eventCursor("w-demo", "s1"), 1);
  assert.equal(
    store.commitEvents([], [draft("next")], caller).events[0]?.seq,
    2,
  );
});

test("C6: a failed durable event insert rolls back prior receipt, envelope and transient allocations", (t) => {
  const { store } = setup(t);
  store.append(receipt("source"), caller);
  store.append(receipt("event:collision"), caller);
  const before = store.cursor();
  assert.throws(() =>
    store.commitEvents(
      [receipt("temporary")],
      [draft("first"), transient("delta"), draft("collision")],
      caller,
    ),
  );
  assert.equal(store.cursor(), before);
  assert.deepEqual(store.replayEvents("w-demo", "s1"), []);
  assert.equal(
    store.commitEvents([], [draft("after")], caller).events[0]?.seq,
    1,
  );
});

test("C6: replay rejects corrupt envelopes and unknown event schemas", (t) => {
  const { store } = setup(t);
  store.commitEvents([receipt("source")], [draft("one")], caller);
  store.db
    .prepare("UPDATE records SET schema_version = 2 WHERE kind = 'event'")
    .run();
  assert.throws(
    () => store.replayEvents("w-demo", "s1"),
    code("UNKNOWN_SCHEMA"),
  );
  store.db
    .prepare(
      "UPDATE records SET schema_version = 1, payload = json_set(payload, '$.envelope.sessionId', 'other') WHERE kind = 'event'",
    )
    .run();
  assert.throws(() => store.replayEvents("w-demo", "s1"));
  assert.throws(() => store.get("event:one"));
  assert.throws(() => store.list("w-demo"));
});

test("C6: duplicate durable event IDs reject identical retries and collisions without any state change", (t) => {
  const { store } = setup(t);
  store.commitEvents([receipt("source")], [draft("same")], caller);
  const cursor = store.cursor();
  assert.throws(
    () => store.commitEvents([], [draft("same")], caller),
    code("EVENT_ALREADY_EXISTS"),
  );
  assert.throws(
    () =>
      store.commitEvents([receipt("collision")], [draft("same", "s2")], {
        ...caller,
        sessionId: "s2",
      }),
    code("EVENT_ALREADY_EXISTS"),
  );
  assert.equal(store.cursor(), cursor);
  assert.equal(store.eventCursor("w-demo", "s2"), 0);
  assert.equal(
    store.commitEvents([], [draft("next")], caller).events[0]?.seq,
    2,
  );
});

test("C6: a caller grant veto cannot be bypassed by a stored or staged reference", (t) => {
  const { store } = setup(t);
  store.append(receipt("source"), caller);
  const before = store.cursor();
  const denied: string[] = [];
  const restricted = {
    ...caller,
    resolveReference: (id: string) => {
      denied.push(id);
      return id !== "source";
    },
  };
  assert.throws(() => store.commitEvents([], [draft("denied")], restricted));
  assert.ok(
    denied.includes("source"),
    "the caller resolver must decide even when the record exists",
  );
  assert.equal(store.cursor(), before);
  assert.equal(store.eventCursor("w-demo", "s1"), 0);
  assert.throws(() =>
    store.commitEvents(
      [receipt("new-source")],
      [draft("staged-denied", "s1", "w-demo", "new-source")],
      { ...caller, resolveReference: (id: string) => id !== "new-source" },
    ),
  );
  assert.equal(store.cursor(), before);
  const { resolveReference: _resolver, ...nativeCaller } = caller;
  assert.equal(
    store.commitEvents([], [draft("native-default")], nativeCaller).events[0]
      ?.seq,
    1,
  );
});

test("C6: tombstones veto publication and replay without reviving deleted evidence", (t) => {
  const fixture = setup(t);
  const { store } = fixture;
  store.commitEvents([receipt("source")], [draft("one")], caller);
  const before = store.cursor();
  store.noteDeletion("source");
  assert.throws(() =>
    store.commitEvents([receipt("late")], [draft("late")], caller),
  );
  assert.equal(store.cursor(), before);
  assert.throws(() => store.replayEvents("w-demo", "s1"));
  assert.throws(() => store.get("event:one"));
  assert.throws(() => store.list("w-demo"));
  assert.throws(() => store.exportJSONL(join(fixture.dir, "deleted.jsonl")));
  assert.throws(() => fixture.reopen().replayEvents("w-demo", "s1"));
  fixture.store.append(receipt("live"), caller);
  assert.equal(
    fixture.store.commitEvents([], [draft("two", "s2", "w-demo", "live")], {
      ...caller,
      sessionId: "s2",
    }).events[0]?.seq,
    1,
  );
  fixture.store.noteDeletion("event:two");
  assert.throws(
    () => fixture.store.replayEvents("w-demo", "s2"),
    code("EVENT_DELETED"),
  );
  assert.throws(
    () =>
      fixture.store.commitEvents([], [draft("two", "s2", "w-demo", "live")], {
        ...caller,
        sessionId: "s2",
      }),
    code("EVENT_DELETED"),
  );
});

test("C6: late publication checks the producer's deletion epoch atomically", (t) => {
  const { store } = setup(t);
  store.append(receipt("source"), caller);
  const epoch = store.deletionEpoch();
  const before = store.cursor();
  store.noteDeletion("other-evidence");
  assert.throws(
    () =>
      store.commitEvents([receipt("late")], [draft("late")], caller, {
        expectedDeletionEpoch: epoch,
      }),
    code("STALE_DELETION_EPOCH"),
  );
  assert.equal(store.cursor(), before);
  assert.equal(
    store.commitEvents([], [draft("current")], caller, {
      expectedDeletionEpoch: store.deletionEpoch(),
    }).events[0]?.seq,
    1,
  );
});

test("C6: caller session, nested JSON, durable-only records and receipt guards remain authoritative", (t) => {
  const { store } = setup(t);
  store.append(receipt("source"), caller);
  assert.throws(() => store.commitEvents([], [draft("wrong", "s2")], caller));
  assert.throws(() =>
    store.commitEvents(
      [],
      [{ ...draft("json"), payload: { state: "ready", activeWorkers: NaN } }],
      caller,
    ),
  );
  assert.throws(
    () =>
      store.commitEvents([receipt("guarded")], [draft("blocked")], caller, {
        expectedOwnershipEpoch: { workspaceId: "workspace", epoch: 1 },
      }),
    code("OWNERSHIP_STALE_EPOCH"),
  );
  assert.throws(
    () =>
      store.commitEvents([], [draft("blocked-config")], caller, {
        expectedConfigRevision: { scopeId: "w-demo", revision: "stale" },
      }),
    code("CONFIG_STALE_REVISION"),
  );
  assert.equal(store.eventCursor("w-demo", "s1"), 0);
  assert.equal(
    store.commitEvents([], [draft("allowed")], caller).events[0]?.seq,
    1,
  );
  const eventRecord = store.get("event:allowed");
  assert.throws(
    () => store.append({ kind: "event", record: eventRecord.record }, caller),
    code("EVENT_COMMIT_REQUIRED"),
  );
  assert.throws(
    () =>
      store.appendBatch(
        [{ kind: "event", record: eventRecord.record }],
        caller,
      ),
    code("EVENT_COMMIT_REQUIRED"),
  );
});

test("C6: corrupt or exhausted event metadata fails closed without allocating", (t) => {
  const { store } = setup(t);
  store.append(receipt("source"), caller);
  const cursor = store.cursor();
  for (const value of ["NaN", "-1", "1.5", "", "01", "9007199254740992"]) {
    store.db
      .prepare("INSERT OR REPLACE INTO store_meta(key, value) VALUES (?, ?)")
      .run(key(), value);
    assert.throws(
      () => store.commitEvents([], [draft("bad")], caller),
      code("STORE_LAYOUT"),
    );
    assert.equal(store.cursor(), cursor);
  }
  store.db
    .prepare("UPDATE store_meta SET value = ? WHERE key = ?")
    .run(String(Number.MAX_SAFE_INTEGER), key());
  assert.throws(
    () => store.commitEvents([], [draft("overflow")], caller),
    code("EVENT_SEQUENCE_OVERFLOW"),
  );
  assert.equal(store.cursor(), cursor);
});

test("C6: missing or regressed event counter cannot silently restart after durable history", (t) => {
  const { store } = setup(t);
  store.commitEvents([receipt("source")], [draft("one")], caller);
  store.db.prepare("DELETE FROM store_meta WHERE key = ?").run(key());
  assert.throws(() => store.eventCursor("w-demo", "s1"), code("STORE_LAYOUT"));
  assert.throws(
    () => store.commitEvents([], [draft("again")], caller),
    code("STORE_LAYOUT"),
  );
});

test("C6: backup rejects counter rollback before touching live state and allows safe recovery", (t) => {
  const fixture = setup(t);
  fixture.store.commitEvents([receipt("source")], [draft("one")], caller);
  const old = join(fixture.dir, "old.db");
  fixture.store.backup(old);
  fixture.store.commitEvents([], [transient("delta")], caller);
  assert.throws(() => fixture.store.restore(old), code("STALE_EVENT_SEQUENCE"));
  const safe = join(fixture.dir, "safe.db");
  fixture.store.backup(safe);
  fixture.store.restore(safe);
  assert.equal(
    fixture.store.commitEvents([], [draft("next")], caller).events[0]?.seq,
    3,
  );
});

test("C6: old records-only JSONL keeps its shape/count; event JSONL roundtrips envelopes and transient counters", (t) => {
  const fixture = setup(t);
  const target = fixture.track(Store.open(join(fixture.dir, "import.db")));
  const file = join(fixture.dir, "export.jsonl");
  fixture.store.append(receipt("source"), caller);
  assert.equal(fixture.store.exportJSONL(file), 1);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8").trim())), [
    "seq",
    "kind",
    "record",
  ]);
  assert.equal(target.importJSONL(file, caller), 1);
  const events = fixture.store.commitEvents(
    [],
    [draft("one"), transient("delta")],
    caller,
  ).events;
  fixture.store.commitEvents([], [draft("other", "s2")], {
    ...caller,
    sessionId: "s2",
  });
  assert.equal(fixture.store.exportJSONL(file), 3);
  const text = readFileSync(file, "utf8");
  assert.throws(() => target.importJSONL(file, caller));
  assert.equal(
    target.commitEvents([], [draft("after-failed-import")], caller).events[0]
      ?.seq,
    1,
    "a duplicate imported receipt rolls the new watermark back too",
  );
  const fresh = fixture.track(Store.open(join(fixture.dir, "fresh.db")));
  assert.equal(fresh.importJSONL(file, caller), 3);
  assert.deepEqual(fresh.replayEvents("w-demo", "s1"), [events[0]]);
  assert.equal(
    fresh.commitEvents([], [draft("three")], caller).events[0]?.seq,
    3,
  );
  assert.equal(
    fresh.commitEvents([], [draft("other-two", "s2")], {
      ...caller,
      sessionId: "s2",
    }).events[0]?.seq,
    2,
  );
  const malformed = text.replace('"seq":2', '"seq":-1');
  writeFileSync(file, malformed);
  const before = target.cursor();
  assert.throws(() => target.importJSONL(file, caller));
  assert.equal(target.cursor(), before);
});
