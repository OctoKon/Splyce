// TD-10 / C1_session_catalog — Pi session ↔ native (scopeId, sessionId) map,
// Pi-derived ancestry across fork/branch/resume with durable branch anchors,
// one channel per session and native-owned event identity, on a real Store
// and real Pi SessionManagers.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionMap } from "@splyce/pi/session-map";
import { Store } from "../../packages/splyce-pi/dist/store.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/contracts/session-map-events.json", import.meta.url),
    "utf8",
  ),
);
const root = mkdtempSync(join(tmpdir(), "td10-session-map-"));
after(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const fresh = () => {
  dirs += 1;
  const dir = join(root, `t${String(dirs)}`);
  mkdirSync(dir);
  return dir;
};

const context = {
  configRevision: "cfg1",
  profileRevision: "profile1",
  policyRevision: "policy1",
  resolveReference: () => true,
};
const k1 = { scopeId: "w-demo", sessionId: "s1" };
const k2 = { scopeId: "w-demo", sessionId: "s2" };
const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

// Pi only writes a session file once it holds a conversation.
const converse = (pi: SessionManager, text: string): [string, string] => {
  const user = pi.appendMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
  const reply = pi.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `re ${text}` }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never);
  return [user, reply];
};

const run = (runId: string) => ({
  schemaVersion: 1,
  recordId: `rec-${runId}`,
  createdAt: "2026-10-26T00:00:00.000Z",
  scopeId: "w-demo",
  sourceIds: [],
  runId,
  workspaceId: "ws-1",
  baseRevision: "rev-1",
  baseSnapshotId: "snap-1",
  taskArtifactId: "task-1",
  grantIds: [],
  profileId: "profile-1",
  profileRevision: "profile1",
  roleBindingRefs: [],
  state: "pending" as const,
});

type Stored = { seq: number; kind: string; record: Record<string, unknown> };
const records = (store: Store, sessionId: string, kind: string) =>
  (store.list("w-demo", 0, sessionId).records as Stored[]).filter(
    (r) => r.kind === kind,
  );
const anchorIds = (map: SessionMap, piSessionId: string) =>
  map
    .ancestry(piSessionId)
    .chain.map(
      (n: { anchor: { branchAnchorId: string } }) => n.anchor.branchAnchorId,
    );

const setup = () => {
  const dir = fresh();
  const store = Store.open(join(dir, "store.db"));
  const pi = SessionManager.create(dir, join(dir, "pi"));
  converse(pi, "hello");
  return { dir, store, pi, map: new SessionMap(store, context) };
};

test("preview derives an empty real Pi anchor without Store, binding or channel publication", () => {
  const { dir, store, pi: existing, map } = setup();
  try {
    map.bind(k1, existing);
    const channel = map.follow(k1, 0).channel;
    const channelState = channel.bridge.status();
    const pi = SessionManager.inMemory(dir);
    const key = { scopeId: "w-demo", sessionId: pi.getSessionId() };
    const before = store.cursor();
    const preview = map.preview(key, pi);
    assert.deepEqual(preview, {
      ...key,
      piSessionId: pi.getSessionId(),
      anchor: {
        branchAnchorId: `anchor-${pi.getSessionId()}`,
        piSessionId: pi.getSessionId(),
        parentAnchorId: null,
        forkPointEntryId: null,
        firstChildEntryId: null,
        activeLeafEntryId: null,
      },
    });
    assert.deepEqual(map.preview(key, pi), preview);
    assert.equal(Object.isFrozen(preview), true);
    assert.equal(Object.isFrozen(preview.anchor), true);
    assert.equal(
      Reflect.set(preview.anchor, "activeLeafEntryId", "changed"),
      false,
    );
    assert.equal(store.cursor(), before);
    assert.equal(records(store, key.sessionId, "branchAnchor").length, 0);
    assert.throws(
      () => map.resolve(pi.getSessionId()),
      code("SESSION_UNKNOWN"),
    );
    assert.throws(
      () => map.ancestry(pi.getSessionId()),
      code("SESSION_UNKNOWN"),
    );
    assert.throws(() => map.follow(key, 0), code("SESSION_UNKNOWN"));
    assert.equal(map.follow(k1, 0).channel, channel);
    assert.deepEqual(channel.bridge.status(), channelState);
    assert.deepEqual(map.resolve(existing.getSessionId()), k1);
    assert.deepEqual(pi.getEntries(), []);
    assert.equal(pi.getSessionFile(), undefined);
  } finally {
    store.close();
  }
});

test("a real fork preview can be committed before bind without duplicate anchors", () => {
  const { dir, store, pi: parent, map } = setup();
  try {
    const parentAnchor = map.bind(k1, parent);
    const child = SessionManager.forkFrom(
      parent.getSessionFile()!,
      dir,
      join(dir, "pi"),
    );
    const key = { scopeId: "w-demo", sessionId: child.getSessionId() };
    const before = store.cursor();
    const preview = map.preview(key, child);
    assert.equal(preview.piSessionId, child.getSessionId());
    assert.equal(preview.anchor.forkPointEntryId, parent.getLeafId());
    assert.equal(
      preview.anchor.parentAnchorId,
      parentAnchor.anchor.branchAnchorId,
    );
    assert.equal(preview.anchor.firstChildEntryId, null);
    assert.equal(preview.anchor.activeLeafEntryId, child.getLeafId());
    assert.equal(store.cursor(), before);
    assert.throws(
      () => map.resolve(child.getSessionId()),
      code("SESSION_UNKNOWN"),
    );
    const committed = store.append(
      {
        kind: "branchAnchor",
        record: {
          schemaVersion: 1,
          recordId: `${preview.anchor.branchAnchorId}.1`,
          createdAt: "2026-10-28T00:00:00.000Z",
          scopeId: key.scopeId,
          sourceIds: [],
          ...preview.anchor,
        },
      },
      { ...context, sessionId: key.sessionId },
    );
    assert.equal(store.cursor(), committed.seq);
    assert.deepEqual(map.bind(key, child), preview);
    assert.equal(
      store.cursor(),
      committed.seq,
      "bind must reuse the exact precommitted anchor",
    );
    assert.equal(records(store, key.sessionId, "branchAnchor").length, 1);
    assert.deepEqual(map.bind(key, child), preview);
    assert.deepEqual(map.preview(key, child), preview);
    assert.equal(store.cursor(), committed.seq);
    assert.deepEqual(map.resolve(child.getSessionId()), key);
  } finally {
    store.close();
  }
});

test("preview rejects malformed or foreign keys without changing existing bindings", () => {
  const { dir, store, pi, map } = setup();
  try {
    for (const key of [
      null,
      {},
      { ...k1, extra: "field" },
      { ...k1, scopeId: "" },
      { ...k1, sessionId: "bad/id" },
      { ...k1, sessionId: "bad\u200b" },
      { ...k1, sessionId: "\ud800" },
    ])
      assert.throws(
        () => map.preview(key as never, pi),
        code("SESSION_FOREIGN"),
      );
    let reads = 0;
    const accessor = { ...k1 };
    Object.defineProperty(accessor, "sessionId", {
      enumerable: true,
      get() {
        reads++;
        return k1.sessionId;
      },
    });
    assert.throws(() => map.preview(accessor, pi), code("SESSION_FOREIGN"));
    assert.equal(reads, 0);
    assert.equal(store.cursor(), 0);
    assert.throws(
      () => map.resolve(pi.getSessionId()),
      code("SESSION_UNKNOWN"),
    );
    const bound = map.bind(k1, pi);
    const channel = map.follow(k1, 0).channel;
    const before = store.cursor();
    const other = SessionManager.inMemory(dir);
    assert.throws(() => map.preview(k2, pi), code("SESSION_FOREIGN"));
    assert.throws(
      () => map.preview({ ...k1, scopeId: "w-other" }, pi),
      code("SESSION_FOREIGN"),
    );
    assert.throws(() => map.preview(k1, other), code("SESSION_FOREIGN"));
    assert.deepEqual(map.preview(k1, pi), bound);
    assert.equal(store.cursor(), before);
    assert.deepEqual(map.resolve(pi.getSessionId()), k1);
    assert.equal(map.follow(k1, 0).channel, channel);
    assert.throws(
      () => map.resolve(other.getSessionId()),
      code("SESSION_UNKNOWN"),
    );
  } finally {
    store.close();
  }
});

test("a failed first bind rolls back its maps and a later retry recovers", () => {
  const { store, pi, map } = setup();
  try {
    store.db.exec(
      "CREATE TRIGGER fail_anchor BEFORE INSERT ON records WHEN NEW.kind = 'branchAnchor' BEGIN SELECT RAISE(ABORT, 'anchor fixture refusal'); END;",
    );
    assert.throws(() => map.bind(k1, pi), /anchor fixture refusal/);
    assert.equal(store.cursor(), 0);
    assert.throws(
      () => map.resolve(pi.getSessionId()),
      code("SESSION_UNKNOWN"),
    );
    assert.throws(
      () => map.ancestry(pi.getSessionId()),
      code("SESSION_UNKNOWN"),
    );
    assert.throws(() => map.follow(k1, 0), code("SESSION_UNKNOWN"));
    store.db.exec("DROP TRIGGER fail_anchor;");
    const bound = map.bind(k1, pi);
    assert.deepEqual(map.resolve(pi.getSessionId()), k1);
    assert.equal(store.cursor(), 1);
    assert.deepEqual(map.bind(k1, pi), bound);
    assert.equal(store.cursor(), 1);
    assert.equal(map.follow(k1, 0).channel.sessionId, k1.sessionId);
  } finally {
    store.close();
  }
});

test("a failed matching rebind preserves its existing binding and channel", () => {
  const { store, pi, map } = setup();
  try {
    map.bind(k1, pi);
    const channel = map.follow(k1, 0).channel;
    const before = store.cursor();
    converse(pi, "later conversation");
    store.db.exec(
      "CREATE TRIGGER fail_anchor BEFORE INSERT ON records WHEN NEW.kind = 'branchAnchor' BEGIN SELECT RAISE(ABORT, 'anchor fixture refusal'); END;",
    );
    assert.throws(() => map.bind(k1, pi), /anchor fixture refusal/);
    assert.equal(store.cursor(), before);
    assert.deepEqual(map.resolve(pi.getSessionId()), k1);
    assert.equal(map.follow(k1, 0).channel, channel);
    store.db.exec("DROP TRIGGER fail_anchor;");
    assert.equal(map.bind(k1, pi).anchor.activeLeafEntryId, pi.getLeafId());
    assert.equal(store.cursor(), before + 1);
    assert.equal(map.follow(k1, 0).channel, channel);
  } finally {
    store.close();
  }
});

test("unknown and foreign sessions are rejected; same-pair rebind is idempotent", () => {
  const { dir, store, pi, map } = setup();
  const other = SessionManager.create(dir, join(dir, "pi"));
  const id = pi.getSessionId();
  assert.throws(() => map.resolve(id), code("SESSION_UNKNOWN"));
  assert.throws(() => map.ancestry(id), code("SESSION_UNKNOWN"));
  assert.throws(() => map.follow(k1, 0), code("SESSION_UNKNOWN"));
  assert.throws(
    () => map.publish(id, fixture.engineEvents[0]),
    code("SESSION_UNKNOWN"),
  );
  assert.throws(() => map.anchorRun(id, run("r0")), code("SESSION_UNKNOWN"));

  const first = map.bind(k1, pi);
  assert.deepEqual(map.bind(k1, pi), first);
  assert.deepEqual(map.resolve(id), k1);
  // Same Pi session under another native key, and another Pi session under
  // an occupied key, are both foreign.
  assert.throws(() => map.bind(k2, pi), code("SESSION_FOREIGN"));
  assert.throws(() => map.bind(k1, other), code("SESSION_FOREIGN"));
  assert.deepEqual(map.resolve(id), k1);
  // A run anchor cannot claim another scope than the bound one.
  assert.throws(
    () => map.anchorRun(id, { ...run("r1"), scopeId: "w-other" }),
    code("SESSION_FOREIGN"),
  );
  assert.equal(store.list("w-other").records.length, 0);
  store.close();
});

test("an unbound parent stays unresolved: complete is false and nothing is guessed", () => {
  const { dir, store, pi: parent, map } = setup();
  const child = SessionManager.forkFrom(
    parent.getSessionFile()!,
    dir,
    join(dir, "pi"),
  );
  map.bind(k2, child);
  const orphan = map.ancestry(child.getSessionId());
  assert.equal(orphan.complete, false);
  assert.equal(orphan.chain.length, 1);
  assert.deepEqual(orphan.chain[0]!.anchor, {
    branchAnchorId: orphan.chain[0]!.anchor.branchAnchorId,
    piSessionId: child.getSessionId(),
    parentAnchorId: null,
    forkPointEntryId: null,
    firstChildEntryId: null,
    activeLeafEntryId: child.getLeafId(),
  });
  map.bind(k1, parent);
  assert.equal(map.ancestry(child.getSessionId()).complete, true);
  store.close();
});

test("fork ancestry is Pi-derived and durable: resolution persists, resume never duplicates", () => {
  const { dir, store, pi: parent, map } = setup();
  const parentLast = parent.getLeafId();
  const child = SessionManager.forkFrom(
    parent.getSessionFile()!,
    dir,
    join(dir, "pi"),
  );
  map.bind(k1, parent);
  map.bind(k2, child);
  const forked = map.ancestry(child.getSessionId());
  assert.equal(forked.complete, true);
  assert.deepEqual(
    forked.chain.map((n) => [n.piSessionId, n.scopeId, n.sessionId]),
    [
      [child.getSessionId(), "w-demo", "s2"],
      [parent.getSessionId(), "w-demo", "s1"],
    ],
  );
  const childAnchor = forked.chain[0]!.anchor;
  assert.equal(childAnchor.forkPointEntryId, parentLast);
  assert.equal(childAnchor.firstChildEntryId, null);
  assert.equal(
    childAnchor.parentAnchorId,
    forked.chain[1]!.anchor.branchAnchorId,
  );
  assert.equal(forked.chain[1]!.anchor.forkPointEntryId, null);
  assert.equal(forked.chain[1]!.anchor.parentAnchorId, null);

  // The first child entry resolves only once Pi actually has one, and the
  // resolution is appended next to (not over) the pending record.
  const [firstChild] = converse(child, "child turn");
  const resolved = map.ancestry(child.getSessionId());
  assert.equal(resolved.chain[0]!.anchor.firstChildEntryId, firstChild);
  assert.equal(
    resolved.chain[0]!.anchor.branchAnchorId,
    childAnchor.branchAnchorId,
  );
  const anchored = map.anchorRun(child.getSessionId(), run("r-fork"));
  assert.deepEqual(
    map.anchorRun(child.getSessionId(), run("r-fork")),
    anchored,
  );
  const persisted = records(store, "s2", "branchAnchor").filter(
    (r) => r.record.branchAnchorId === childAnchor.branchAnchorId,
  );
  assert.deepEqual(
    persisted.map((r) => r.record.firstChildEntryId),
    [null, firstChild],
  );
  assert.deepEqual(
    persisted.map((r) => r.record.forkPointEntryId),
    [parentLast, parentLast],
  );

  // Resume: a new process reopens the store and Pi files.
  const childFile = child.getSessionFile()!;
  const parentFile = parent.getSessionFile()!;
  store.close();
  const reopened = Store.open(join(dir, "store.db"));
  const resumed = new SessionMap(reopened, context);
  const child2 = SessionManager.open(childFile, join(dir, "pi"));
  resumed.bind(k1, SessionManager.open(parentFile, join(dir, "pi")));
  resumed.bind(k2, child2);
  assert.deepEqual(resumed.ancestry(child2.getSessionId()), resolved);
  assert.deepEqual(
    resumed.anchorRun(child2.getSessionId(), run("r-fork")),
    anchored,
  );
  assert.equal(
    records(reopened, "s2", "branchAnchor").length,
    persisted.length,
  );
  const runs = records(reopened, "s2", "run");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.record.piSessionId, child.getSessionId());
  assert.equal(runs[0]!.record.branchAnchorId, childAnchor.branchAnchorId);
  reopened.close();
});

test("intra-session branch switches get distinct anchors; switching back restores the original", () => {
  const { store, pi, map } = setup();
  const id = pi.getSessionId();
  const [trunkUser] = converse(pi, "trunk");
  map.bind(k1, pi);
  const trunk = anchorIds(map, id);
  assert.equal(trunk.length, 1);
  const trunkLeaf = pi.getLeafId();

  // Branch B off the trunk turn, then abandon it for branch C.
  pi.branch(trunkUser);
  converse(pi, "branch b");
  const b = anchorIds(map, id);
  assert.deepEqual(b.slice(1), trunk);
  assert.notEqual(b[0], trunk[0]);
  const bLeaf = pi.getLeafId()!;
  map.anchorRun(id, run("r-b"));

  pi.branch(trunkUser);
  converse(pi, "branch c");
  const c = anchorIds(map, id);
  assert.deepEqual(c.slice(1), trunk);
  assert.notEqual(c[0], b[0]);
  assert.ok(!c.includes(b[0]!), "abandoned branch is not active ancestry");
  const cAnchor = map.ancestry(id).chain[0]!.anchor;
  assert.equal(cAnchor.forkPointEntryId, trunkUser);
  assert.equal(cAnchor.parentAnchorId, trunk[0]);
  map.anchorRun(id, run("r-c"));

  // Switching back resolves the original anchors, not new ones.
  pi.branch(bLeaf);
  assert.deepEqual(anchorIds(map, id), b);
  pi.branch(trunkLeaf!);
  assert.deepEqual(anchorIds(map, id), trunk);

  // Each run is anchored to the branch that was active when it started.
  const runs = records(store, "s1", "run");
  assert.deepEqual(
    runs.map((r) => [r.record.runId, r.record.branchAnchorId]),
    [
      ["r-b", b[0]],
      ["r-c", c[0]],
    ],
  );
  store.close();
});

test("one channel per (scope, session); unfollow releases the channel, dispose ends the session", () => {
  const { dir, store, pi, map } = setup();
  const pi2 = SessionManager.create(dir, join(dir, "pi"));
  map.bind(k1, pi);
  map.bind(k2, pi2);
  const a = map.follow(k1, 0).channel;
  assert.equal(map.follow(k1, 0).channel, a);
  assert.equal(map.follow(k1, 0).channel.bridge, a.bridge);
  const b = map.follow(k2, 0).channel;
  assert.notEqual(b, a);
  assert.deepEqual([a.scopeId, a.sessionId], ["w-demo", "s1"]);

  // Unfollow: the renderer leaves, the session (binding) stays.
  map.unfollow(k1);
  map.unfollow(k1);
  assert.deepEqual(map.resolve(pi.getSessionId()), k1);
  const a2 = map.follow(k1, 0).channel;
  assert.notEqual(a2, a);

  // Dispose: the session ends; binding and channel go together.
  map.dispose(k1);
  map.dispose(k1);
  assert.throws(() => map.follow(k1, 0), code("SESSION_UNKNOWN"));
  assert.throws(() => map.resolve(pi.getSessionId()), code("SESSION_UNKNOWN"));
  assert.equal(map.follow(k2, 0).channel, b);
  map.bind(k1, pi);
  assert.notEqual(map.follow(k1, 0).channel, a2);
  store.close();
});

test("published events carry the native scope/session; engine identity is rejected", () => {
  const { store, pi, map } = setup();
  map.bind(k1, pi);
  const id = pi.getSessionId();
  map.anchorRun(id, run("run-1"));
  const { channel } = map.follow(k1, 0);
  for (const event of fixture.engineEvents) map.publish(id, event);
  assert.throws(
    () => map.publish(id, fixture.foreignEvent),
    code("SESSION_FOREIGN"),
  );
  const { sessionId, scopeId, seq, ...unscoped } = fixture.foreignEvent;
  assert.throws(
    () => map.publish(id, { ...unscoped, sessionId }),
    code("SESSION_FOREIGN"),
  );
  assert.throws(
    () => map.publish(id, { ...unscoped, scopeId: "w-demo" }),
    code("SESSION_FOREIGN"),
  );
  // seq is the ledger's, never the engine's.
  assert.throws(
    () => map.publish(id, { ...unscoped, seq }),
    code("SESSION_FOREIGN"),
  );
  const frames = channel.bridge.drain().frames;
  assert.deepEqual(
    frames.map((f: { event: Record<string, unknown> }) => [
      f.event.eventId,
      f.event.scopeId,
      f.event.sessionId,
      f.event.seq,
    ]),
    [
      ["evt-1", "w-demo", "s1", 1],
      ["evt-2", "w-demo", "s1", 2],
    ],
  );
  store.close();
});

const contractError = (e: unknown) => /contract/i.test((e as Error).message);
const durableEvent = (eventId: string, turnId = eventId) => ({
  ...fixture.engineEvents[0],
  eventId,
  payload: { runId: "run-1", turnId },
});

test("without a follower publish commits durable events through the ledger and a later follow replays them", () => {
  const { dir, store, pi, map } = setup();
  map.bind(k1, pi);
  const id = pi.getSessionId();
  map.anchorRun(id, run("run-1"));
  const published = map.publish(id, fixture.engineEvents[0]);
  assert.equal(published.frame, undefined);
  assert.equal(published.event.seq, 1);
  assert.equal(store.eventCursor("w-demo", "s1"), 1);
  // Validation still runs first: an invalid event commits nothing.
  const [durable] = fixture.engineEvents;
  assert.throws(
    () => map.publish(id, { ...durable, eventId: "x", kind: "unknown.kind" }),
    contractError,
  );
  assert.throws(
    () => map.publish(id, { ...durable, eventId: "y", durable: false }),
    contractError,
  );
  assert.equal(store.eventCursor("w-demo", "s1"), 1);
  // A later follower — even in a new process — replays the committed envelope.
  const { channel, replay } = map.follow(k1, 0);
  assert.deepEqual(replay, [published.event]);
  assert.equal(channel.bridge.status().pendingFrames, 0);
  const file = pi.getSessionFile()!;
  store.close();
  const reopened = Store.open(join(dir, "store.db"));
  const resumed = new SessionMap(reopened, context);
  resumed.bind(k1, SessionManager.open(file, join(dir, "pi")));
  assert.deepEqual(resumed.follow(k1, 0).replay, [published.event]);
  reopened.close();
});

test("follow replays real SplyceEvents for this session only, never stored records", () => {
  const { dir, store, pi, map } = setup();
  const pi2 = SessionManager.create(dir, join(dir, "pi"));
  map.bind(k1, pi);
  map.bind(k2, pi2);
  map.anchorRun(pi.getSessionId(), run("run-1"));
  map.anchorRun(pi2.getSessionId(), run("run-2"));
  const a = map.publish(pi.getSessionId(), durableEvent("e-a")).event;
  map.publish(pi2.getSessionId(), {
    ...durableEvent("e-other"),
    recordId: "rec-run-2",
    payload: { runId: "run-2", turnId: "t-o" },
  });
  const b = map.publish(pi.getSessionId(), durableEvent("e-b")).event;
  const { replay } = map.follow(k1, 0);
  assert.deepEqual(replay, [a, b]);
  for (const event of replay) {
    assert.equal(Object.hasOwn(event, "record"), false);
    assert.deepEqual(
      [event.scopeId, event.sessionId, event.kind, event.durable],
      ["w-demo", "s1", "turn.started", true],
    );
  }
  assert.deepEqual(
    replay.map((e) => e.seq),
    [1, 2],
  );
  store.close();
});

test("a durable event commits atomically with its receipt", () => {
  const { store, pi, map } = setup();
  map.bind(k1, pi);
  const id = pi.getSessionId();
  const receipt = { kind: "run" as const, record: { ...run("run-1") } };
  receipt.record = {
    ...receipt.record,
    piSessionId: id,
    branchAnchorId: map.ancestry(id).chain[0]!.anchor.branchAnchorId,
  } as never;
  const first = map.publish(id, fixture.engineEvents[0], [receipt]).event;
  assert.equal(records(store, "s1", "run").length, 1);
  // A rejected event (reused eventId) leaves its receipt uncommitted too.
  assert.throws(() =>
    map.publish(id, fixture.engineEvents[0], [
      {
        kind: "run",
        record: { ...receipt.record, recordId: "rec-run-x", runId: "run-x" },
      },
    ]),
  );
  assert.equal(records(store, "s1", "run").length, 1);
  assert.deepEqual(map.follow(k1, 0).replay, [first]);
  store.close();
});

test("a replay range crossing a lost transient seq leads with a committed run.reconnect_snapshot", () => {
  const { store, pi, map } = setup();
  map.bind(k1, pi);
  const id = pi.getSessionId();
  map.anchorRun(id, run("run-1"));
  const [d1, delta] = fixture.engineEvents;
  const one = map.publish(id, d1).event;
  assert.equal(map.publish(id, delta).event.seq, 2);
  const three = map.publish(id, durableEvent("evt-3")).event;
  // The transient payload is not retained anywhere in the store.
  assert.equal(
    JSON.stringify(store.list("w-demo").records).includes('"hi"'),
    false,
  );

  const crossed = map.follow(k1, 0).replay;
  const [snapshot, ...rest] = crossed;
  assert.deepEqual(rest, [one, three]);
  assert.equal(snapshot!.kind, "run.reconnect_snapshot");
  assert.equal(snapshot!.seq, 4);
  assert.equal(snapshot!.durable, true);
  assert.deepEqual([snapshot!.scopeId, snapshot!.sessionId], ["w-demo", "s1"]);
  assert.deepEqual(snapshot!.payload, {
    runId: "run-1",
    lastDurableSeq: 3,
    activeActionIds: [],
    state: "ready",
  });
  // The snapshot is a real ledger event: it replays like any other.
  assert.deepEqual(store.replayEvents("w-demo", "s1", 3), [snapshot]);
  // A cursor past the gap is gapless: no new snapshot.
  assert.deepEqual(map.follow(k1, 2).replay, [three, snapshot]);
  // A trailing lost transient is a gap too.
  map.publish(id, { ...delta, eventId: "evt-5" });
  const trailing = map.follow(k1, 4).replay;
  assert.equal(trailing.length, 1);
  assert.equal(trailing[0]!.kind, "run.reconnect_snapshot");
  assert.equal(trailing[0]!.seq, 6);
  store.close();
});

test("resubscribe continues the session event cursor without gaps or foreign events", () => {
  const { dir, store, pi, map } = setup();
  const pi2 = SessionManager.create(dir, join(dir, "pi"));
  map.bind(k1, pi);
  map.bind(k2, pi2);
  map.anchorRun(pi.getSessionId(), run("run-1"));
  const a = map.publish(pi.getSessionId(), durableEvent("e-a")).event;
  const b = map.publish(pi.getSessionId(), durableEvent("e-b")).event;
  const seqs = (afterSeq: number) =>
    map.follow(k1, afterSeq).replay.map((e) => e.eventId);

  assert.deepEqual(seqs(0), ["e-a", "e-b"]);
  assert.deepEqual(seqs(a.seq), ["e-b"]);
  map.unfollow(k1);
  assert.deepEqual(seqs(a.seq), ["e-b"]);
  map.dispose(k1);
  map.bind(k1, pi);
  assert.deepEqual(seqs(a.seq), ["e-b"]);
  assert.deepEqual(seqs(b.seq), []);
  assert.deepEqual(map.follow(k2, 0).replay, []);
  assert.throws(() => map.follow(k1, b.seq + 100), code("INVALID_CURSOR"));
  store.close();
});

test("follow re-resolves grants at replay time: a revoked reference fails closed with no history and no snapshot", () => {
  const { store, pi } = setup();
  let allow = true;
  const map = new SessionMap(store, {
    ...context,
    resolveReference: () => allow,
  });
  map.bind(k1, pi);
  const id = pi.getSessionId();
  map.anchorRun(id, run("run-1"));
  const [d1, delta] = fixture.engineEvents;
  const one = map.publish(id, d1).event;
  map.publish(id, delta);
  allow = false;
  assert.throws(() => map.follow(k1, 0), code("EVENT_SOURCE"));
  assert.throws(() => map.follow(k1, 0), code("EVENT_SOURCE"));
  // Nothing was committed on the denied path: no snapshot seq was consumed.
  assert.equal(store.eventCursor("w-demo", "s1"), 1);
  allow = true;
  const [snapshot, ...rest] = map.follow(k1, 0).replay;
  assert.equal(snapshot!.kind, "run.reconnect_snapshot");
  assert.equal(snapshot!.seq, 3);
  assert.deepEqual(rest, [one]);
  store.close();
});

test("gap replay order drives the real renderer reducer to the complete state", async () => {
  const { createTurnStreamTransport } =
    await import("../../apps/desktop/src/stores/turns.ts");
  const { store, pi, map } = setup();
  map.bind(k1, pi);
  const id = pi.getSessionId();
  map.anchorRun(id, run("run-1"));
  const [d1, delta] = fixture.engineEvents;
  map.publish(id, d1);
  map.publish(id, delta);
  map.publish(id, {
    ...durableEvent("evt-3"),
    payload: { runId: "run-3", turnId: "turn-3" },
  });
  const { replay } = map.follow(k1, 0);
  const transport = createTurnStreamTransport({
    sessionId: "s1",
    scopeId: "w-demo",
    schedule: () => {},
  });
  for (const event of replay) transport.enqueue(event);
  const state = transport.flush();
  assert.equal(state.needsResync, false);
  assert.equal(state.duplicateCount, 0);
  assert.equal(state.protocolErrors, 0);
  assert.equal(state.lastDurableSeq, 3);
  assert.deepEqual(Object.keys(state.runs).sort(), ["run-1", "run-3"]);
  assert.equal(state.runs["run-1"]!.turnId, "turn-1");
  assert.equal(state.runs["run-3"]!.turnId, "turn-3");
  store.close();
});

test("a trailing lost transient is detected after reopen by a fresh SessionMap", () => {
  const { dir, store, pi, map } = setup();
  map.bind(k1, pi);
  const id = pi.getSessionId();
  map.anchorRun(id, run("run-1"));
  const [d1, delta] = fixture.engineEvents;
  const one = map.publish(id, d1).event;
  assert.equal(map.publish(id, delta).event.seq, 2);
  const file = pi.getSessionFile()!;
  store.close();

  const reopened = Store.open(join(dir, "store.db"));
  const fresh = new SessionMap(reopened, context);
  fresh.bind(k1, SessionManager.open(file, join(dir, "pi")));
  const replay = fresh.follow(k1, one.seq).replay;
  assert.equal(replay.length, 1);
  const [snapshot] = replay;
  assert.equal(snapshot!.kind, "run.reconnect_snapshot");
  assert.equal(snapshot!.seq, 3);
  assert.deepEqual(snapshot!.payload, {
    runId: "run-1",
    lastDurableSeq: 1,
    activeActionIds: [],
    state: "ready",
  });
  // Committed, not synthesized: it replays from the Store.
  assert.deepEqual(reopened.replayEvents("w-demo", "s1", 2), [snapshot]);
  reopened.close();
});

test("follow re-resolves payload references from the event schema: a revoked payload ref fails closed", () => {
  const { store, pi } = setup();
  const denied = new Set<string>();
  const map = new SessionMap(store, {
    ...context,
    resolveReference: (id: string) => !denied.has(id),
  });
  map.bind(k1, pi);
  const id = pi.getSessionId();
  map.anchorRun(id, run("run-1"));
  const started = map.publish(id, fixture.engineEvents[0]).event;
  const intent = map.publish(id, {
    ...fixture.engineEvents[0],
    eventId: "evt-intent",
    kind: "turn.tool_intent",
    payload: {
      runId: "run-2",
      actionId: "act-1",
      capabilityId: "cap-1",
      target: "target-1",
      argsSummary: "args",
    },
  }).event;
  const before = store.eventCursor("w-demo", "s1");

  // The source record stays granted; only a payload ref is revoked.
  for (const revoked of ["run-1", "act-1", "cap-1"]) {
    denied.add(revoked);
    assert.ok(!denied.has("rec-run-1"));
    assert.throws(() => map.follow(k1, 0), code("EVENT_SOURCE"), revoked);
    denied.delete(revoked);
  }
  assert.equal(store.eventCursor("w-demo", "s1"), before);
  assert.deepEqual(map.follow(k1, 0).replay, [started, intent]);
  store.close();
});

// TD-15 resync: the real SessionMap -> DesktopBridge -> renderer transport.
const resyncChain = async () => {
  const { createTurnStreamTransport } =
    await import("../../apps/desktop/src/stores/turns.ts");
  const { store, pi, map } = setup();
  map.bind(k1, pi);
  const id = pi.getSessionId();
  map.anchorRun(id, run("run-1"));
  const requests: number[] = [];
  const transport = createTurnStreamTransport({
    sessionId: "s1",
    scopeId: "w-demo",
    schedule: (task) => task(),
    onResync: (afterSeq) => requests.push(afterSeq),
  });
  let published = 0;
  // Durable publishes until the follower's bridge overflows; returns its control.
  const overflowDurable = () => {
    for (;;) {
      published += 1;
      const { frame } = map.publish(id, durableEvent(`e-${String(published)}`));
      if (frame) return frame.event;
    }
  };
  // Large transients overflow the byte budget quickly; nothing is retained.
  const overflowTransient = () => {
    const [, delta] = fixture.engineEvents;
    for (;;) {
      published += 1;
      const { frame } = map.publish(id, {
        ...delta,
        eventId: `t-${String(published)}`,
        payload: { runId: "run-1", delta: "x".repeat(60000) },
      });
      if (frame) return frame.event;
    }
  };
  return {
    store,
    map,
    id,
    transport,
    requests,
    overflowDurable,
    overflowTransient,
  };
};

test("TD-15 B1: a fresh follower's overflow control (fromSeq 0) replays seq 1 plainly and recovers", async () => {
  const { store, map, transport, requests, overflowDurable } =
    await resyncChain();
  const { channel } = map.follow(k1, 0);
  const control = overflowDurable();
  assert.deepEqual(control, {
    frame: "control",
    kind: "stream.resync",
    sessionId: "s1",
    fromSeq: 0,
  });
  transport.enqueue(control as never);
  assert.deepEqual(requests, [0]);
  assert.equal(transport.current().needsResync, true);
  assert.equal(channel.bridge.drain().frames.length, 0);
  const { replay } = map.follow(k1, requests[0]!);
  assert.equal(replay[0]!.seq, 1);
  assert.equal(replay[0]!.kind, "turn.started");
  for (const event of replay) transport.enqueue(event);
  const state = transport.flush();
  assert.equal(state.needsResync, false);
  assert.equal(state.resyncCount, 1);
  assert.equal(state.duplicateCount, 0);
  assert.equal(state.lastDurableSeq, replay.at(-1)!.seq);
  store.close();
});

test("TD-15 B2: overflow controls carry the follower's current applied seq across resubscribes", async () => {
  const { store, map, id, overflowTransient } = await resyncChain();
  for (const n of [1, 2, 3, 4, 5]) map.publish(id, durableEvent(`d-${n}`));
  const { channel } = map.follow(k1, 5);
  assert.equal((overflowTransient() as { fromSeq: number }).fromSeq, 5);
  channel.bridge.drain();
  const applied = store.eventHighwater("w-demo", "s1") - 3;
  assert.equal(map.follow(k1, applied).channel, channel);
  assert.equal((overflowTransient() as { fromSeq: number }).fromSeq, applied);
  assert.equal(channel.bridge.status().lastResyncFromSeq, applied);
  store.close();
});

test("TD-15 B3: bridge replay is the session's own event ledger in its event seq domain", () => {
  const { dir, store, pi, map } = setup();
  const pi2 = SessionManager.create(dir, join(dir, "pi"));
  map.bind(k1, pi);
  map.bind(k2, pi2);
  map.anchorRun(pi.getSessionId(), run("run-1"));
  map.anchorRun(pi2.getSessionId(), run("run-2"));
  const other = {
    ...durableEvent("b-1"),
    recordId: "rec-run-2",
    payload: { runId: "run-2", turnId: "t-b" },
  };
  const a1 = map.publish(pi.getSessionId(), durableEvent("a-1")).event;
  map.publish(pi2.getSessionId(), other);
  map.anchorRun(pi.getSessionId(), run("run-3"));
  map.publish(pi2.getSessionId(), { ...other, eventId: "b-2" });
  const a2 = map.publish(pi.getSessionId(), durableEvent("a-2")).event;
  const { bridge } = map.follow(k1, 0).channel;
  assert.deepEqual(bridge.replay(0), [a1, a2]);
  assert.deepEqual(
    bridge.replay(0).map((e: { seq: number }) => e.seq),
    [1, 2],
  );
  assert.deepEqual(bridge.replay(a1.seq), [a2]);
  // The receipts' global record cursor is a different domain entirely.
  const recordCursor = store.cursor("w-demo");
  assert.ok(recordCursor > a2.seq);
  assert.throws(() => bridge.replay(recordCursor), code("INVALID_CURSOR"));
  store.close();
});
