// TD-15 / desktop bridge — bounded frames, transient coalescing, renderer
// budget drain and the exactly-one-resync overflow rule, on frozen contract
// types only.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DesktopBridge,
  BridgeError,
  TRANSPORT_LIMIT_OPTIONS,
} from "../../packages/splyce-pi/dist/desktop-bridge.js";
import { Receipts } from "../../packages/splyce-pi/dist/receipts.js";
import { Store } from "../../packages/splyce-pi/dist/store.js";
import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
} from "../../packages/splyce-pi/dist/contracts.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "td15-bridge-"));
let tmpCounter = 0;
let seqCounter = 0;
let eventIdCounter = 0;

const freshDir = () => {
  tmpCounter += 1;
  const dir = join(tmpRoot, `t${String(tmpCounter)}`);
  mkdirSync(dir);
  return dir;
};

const makeBridge = (
  options: Partial<typeof TRANSPORT_LIMIT_OPTIONS> = {},
): { bridge: DesktopBridge; store: Store; dir: string } => {
  const dir = freshDir();
  const store = Store.open(join(dir, "store.db"));
  const receipts = new Receipts(store);
  const bridge = new DesktopBridge(
    {
      scopeId: "w-demo",
      sessionId: "s1",
      configRevision: "cfg1",
      profileRevision: "profile1",
      policyRevision: "policy1",
      lastDurableSeq: 0,
      maxInlineBytes: TRANSPORT_LIMIT_OPTIONS.maxInlineBytes,
      resolveReference: () => true,
    },
    receipts,
    options,
  );
  return { bridge, store, dir };
};

const event = (
  kind: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => {
  seqCounter += 1;
  eventIdCounter += 1;
  return {
    schemaVersion: CONTRACT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    recordId: `rec-${String(eventIdCounter)}`,
    eventId: `evt-${String(eventIdCounter)}`,
    createdAt: new Date().toISOString(),
    sourceIds: [],
    scopeId: "w-demo",
    sessionId: "s1",
    seq: seqCounter,
    durable: kind !== "turn.stream_delta",
    kind,
    payload,
    ...overrides,
  };
};

test("durable events queue, validate and drain as bounded frames", () => {
  const { bridge, store, dir } = makeBridge();
  const good = event("turn.started", { runId: "r1", turnId: "t1" });
  bridge.submit(good);
  const { frames, morePending } = bridge.drain();
  assert.equal(morePending, false);
  assert.equal(frames.length, 1);
  const frame = frames[0]!;
  // 4-byte BE header + JSON body.
  const bodyLength = new DataView(
    frame.encoded.buffer,
    frame.encoded.byteOffset,
  ).getUint32(0, false);
  assert.equal(bodyLength, frame.encoded.byteLength - 4);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(frame.encoded.slice(4))),
    {
      ...good,
      payload: { runId: "r1", turnId: "t1" },
    },
  );

  // Wrong scope is refused with a contract code.
  assert.throws(
    () =>
      bridge.submit(
        event(
          "turn.started",
          { runId: "r1", turnId: "t1" },
          { scopeId: "w-other" },
        ),
      ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CONTRACT_WRONG_SCOPE",
  );

  // An oversized inline payload is refused with FRAME_TOO_LARGE, not sent.
  const bigPayload = { runId: "r1", turnId: "t1", blob: "x".repeat(70000) };
  assert.throws(
    () => bridge.submit(event("turn.started", bigPayload)),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CONTRACT_FRAME_TOO_LARGE",
  );

  assert.equal(bridge.status().pendingFrames, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("transient deltas are lossless: distinct deltas all drain, exact duplicates skip", () => {
  const { bridge, store, dir } = makeBridge();
  bridge.submit(event("turn.stream_delta", { runId: "r1", delta: "a" }));
  bridge.submit(event("turn.stream_delta", { runId: "r1", delta: "ab" }));
  bridge.submit(event("turn.stream_delta", { runId: "r1", delta: "abc" }));
  // Incremental deltas are never dropped: all three drain, in order.
  assert.equal(bridge.status().pendingFrames, 3);
  const { frames } = bridge.drain();
  assert.equal(frames.length, 3);
  const deltas = frames.map(
    (f) =>
      (
        JSON.parse(new TextDecoder().decode(f.encoded.slice(4))) as {
          payload: { delta: string };
        }
      ).payload.delta,
  );
  assert.deepEqual(deltas, ["a", "ab", "abc"]);

  // An exact duplicate of the pending delta within the window is losslessly
  // skipped (no new data), keeping the queue bounded without losing chunks.
  const dup = event("turn.stream_delta", { runId: "r1", delta: "dup" });
  bridge.submit(dup);
  const before = bridge.status().pendingFrames;
  bridge.submit({ ...dup, eventId: "evt-dup2", recordId: "rec-dup2" });
  assert.equal(bridge.status().pendingFrames, before);

  // Different runId does not coalesce with the previous one.
  bridge.submit(event("turn.stream_delta", { runId: "r1", delta: "x" }));
  bridge.submit(event("turn.stream_delta", { runId: "r2", delta: "y" }));
  assert.equal(bridge.status().pendingFrames, before + 2);
  bridge.drain();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("an oversized encoded frame is rejected against the frozen limit", () => {
  const { bridge, store, dir } = makeBridge();
  // Caller context claims a huge inline budget; the bridge clamps it to the
  // shared constant, so an oversized inline payload is refused either at
  // validation or at the encoded-frame cap.
  const huge = event("turn.started", {
    runId: "r1",
    turnId: "t1",
    blob: "x".repeat(400000),
  });
  assert.throws(
    () => bridge.submit(huge),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CONTRACT_FRAME_TOO_LARGE",
  );
  assert.equal(bridge.status().pendingFrames, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("durable overflow emits exactly one resync and pauses delivery", () => {
  const { bridge, store, dir } = makeBridge({ pendingQueueMaxFrames: 2 });
  // Seed durable progress so the resync cursor is meaningful.
  const caller = {
    sessionId: "s1",
    configRevision: "cfg1",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference: () => true,
  };
  const run = JSON.parse(
    readFileSync(
      new URL("../fixtures/contracts/records.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, Record<string, unknown>>;
  const record = { ...structuredClone(run.run), scopeId: "w-demo" } as Record<
    string,
    unknown
  >;
  receipts_commit(store, caller, record);

  bridge.submit(event("turn.started", { runId: "r1", turnId: "t1" }));
  bridge.submit(
    event("turn.completed", {
      runId: "r1",
      candidateSnapshotId: "s",
      finalRevision: "rev1",
    }),
  );
  assert.equal(bridge.status().pendingFrames, 2);

  // Third durable event overflows: queue resets, exactly one resync emitted.
  const resync = bridge.submit(
    event("turn.failed", {
      runId: "r1",
      error: {
        code: "ENGINE_CRASH",
        message: "m",
        correlationId: "c",
        retryable: false,
      },
    }),
  );
  assert.ok(resync, "resync frame returned");
  assert.equal(resync.event.kind, "stream.resync");
  const payload = resync.event.payload as { fromSeq: number };
  assert.equal(payload.fromSeq, store.sessionCursor("w-demo", "s1"));
  assert.equal(bridge.status().pendingFrames, 0);
  assert.equal(bridge.status().paused, true);
  assert.equal(bridge.status().lastResyncFromSeq, payload.fromSeq);

  // Paused: further submits are refused until drain resumes delivery.
  assert.throws(
    () => bridge.submit(event("turn.started", { runId: "r1", turnId: "t1" })),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "BRIDGE_PAUSED",
  );

  // Delivery resumes via drain (the resync itself went straight to the
  // caller as the submit return value, never through the queue).
  const drained = bridge.drain();
  assert.equal(drained.frames.length, 0);
  assert.equal(bridge.status().paused, false);

  // Every overflow emits its own resync; a second overflow at the same
  // durable cursor produces a new resync (not an error).
  const resync2 = bridge["resyncFrame"]();
  assert.equal(resync2.event.kind, "stream.resync");
  assert.equal(
    (resync2.event.payload as { fromSeq: number }).fromSeq,
    store.sessionCursor("w-demo", "s1"),
  );

  // New durable progress advances the resync cursor.
  receipts_commit(store, caller, record);
  const resync3 = bridge["resyncFrame"]();
  assert.equal(
    (resync3.event.payload as { fromSeq: number }).fromSeq,
    store.sessionCursor("w-demo", "s1"),
  );
  assert.equal(
    (resync3.event.payload as { fromSeq: number }).fromSeq > payload.fromSeq,
    true,
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("drain honors the renderer budget and replays from the durable cursor", () => {
  const { bridge, store, dir } = makeBridge({ rendererMaxFrames: 2 });
  const caller = {
    sessionId: "s1",
    configRevision: "cfg1",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference: () => true,
  };
  for (let i = 0; i < 5; i += 1) {
    bridge.submit(
      event("turn.started", { runId: "r1", turnId: `t${String(i)}` }),
    );
  }
  const first = bridge.drain();
  assert.equal(first.frames.length, 2);
  assert.equal(first.morePending, true);
  const second = bridge.drain();
  assert.equal(second.frames.length, 2);
  const third = bridge.drain();
  assert.equal(third.frames.length, 1);
  assert.equal(third.morePending, false);

  // Replay after the last delivered seq is exclusive and cursor-bounded.
  const receipts = new Receipts(store);
  const run = JSON.parse(
    readFileSync(
      new URL("../fixtures/contracts/records.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, Record<string, unknown>>;
  const record = { ...structuredClone(run.run), scopeId: "w-demo" } as Record<
    string,
    unknown
  >;
  receipts_commit(store, caller, record);
  const cursor = receipts.durableCursor("w-demo");
  const replayed = bridge.replay(cursor, caller);
  assert.equal(replayed.records.length, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Appends one valid durable record (fresh recordId) so the cursor advances. */
function receipts_commit(
  store: Store,
  caller: Parameters<Receipts["commitStages"]>[1],
  record: Record<string, unknown>,
): void {
  commitCounter += 1;
  const fresh = {
    ...structuredClone(record),
    recordId: `rec-commit-${String(commitCounter)}`,
  };
  new Receipts(store).commitStages([{ kind: "run", record: fresh }], caller);
}
let commitCounter = 0;

test("durable delivery order is preserved alongside transient coalescing", () => {
  const { bridge, store, dir } = makeBridge();
  // Interleave durable and transient submits; durable frames must drain in
  // strictly ascending seq order regardless of coalescing in between.
  const seqs: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    bridge.submit(
      event("turn.started", { runId: "r1", turnId: `t${String(i)}` }),
    );
    bridge.submit(event("turn.stream_delta", { runId: "r1", delta: "d" }));
  }
  let result = bridge.drain();
  for (const frame of result.frames) {
    if (frame.event.durable) seqs.push(frame.event.seq);
  }
  while (result.morePending) {
    result = bridge.drain();
    for (const frame of result.frames) {
      if (frame.event.durable) seqs.push(frame.event.seq);
    }
  }
  // Six durable events, each strictly greater than the previous.
  assert.equal(seqs.length, 6);
  for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i]! > seqs[i - 1]!);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("repeated identical chunk text with distinct seqs is never dropped", () => {
  const { bridge, store, dir } = makeBridge();
  // "haha" arrives as two chunks with identical bytes but increasing seqs:
  // both are real data and must drain, in order.
  bridge.submit(event("turn.stream_delta", { runId: "r1", delta: "ha" }));
  bridge.submit(event("turn.stream_delta", { runId: "r1", delta: "ha" }));
  assert.equal(bridge.status().pendingFrames, 2);
  const { frames } = bridge.drain();
  const seqs = frames.map((f) => f.event.seq);
  assert.deepEqual(seqs, [seqs[0], seqs[0]! + 1]);

  // A true retransmission (same seq re-sent within the window) still skips.
  const original = event("turn.stream_delta", { runId: "r1", delta: "rt" });
  bridge.submit(original);
  const pending = bridge.status().pendingFrames;
  bridge.submit({ ...original });
  assert.equal(bridge.status().pendingFrames, pending);
  bridge.drain();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a configured tighter maxInlineBytes is honored", () => {
  const { bridge, store, dir } = makeBridge({ maxInlineBytes: 4096 });
  // 5 KB inline payload is under the shared 65536 limit but over the
  // configured 4096 budget: the tighter configuration must win.
  assert.throws(
    () =>
      bridge.submit(
        event("turn.started", {
          runId: "r1",
          turnId: "t1",
          blob: "x".repeat(5000),
        }),
      ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CONTRACT_FRAME_TOO_LARGE",
  );
  // Within the configured budget still passes.
  bridge.submit(event("turn.started", { runId: "r1", turnId: "t2" }));
  assert.equal(bridge.status().pendingFrames, 1);
  bridge.drain();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the transient coalescing state is bounded and released after drain", () => {
  const { bridge, store, dir } = makeBridge();
  for (let i = 0; i < 100; i += 1) {
    bridge.submit(
      event("turn.stream_delta", { runId: `r${String(i)}`, delta: "d" }),
    );
  }
  // 100 distinct runs are all pending before drain.
  assert.equal(bridge.status().pendingFrames, 100);
  const pending = bridge["transient"].size;
  assert.equal(pending, 100);
  // Draining releases every entry: no run state retained after delivery.
  let result = bridge.drain();
  while (result.morePending) result = bridge.drain();
  assert.equal(bridge.status().pendingFrames, 0);
  assert.equal(bridge["transient"].size, 0);
  assert.equal(bridge["transientByFrame"].size, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the frozen maxInlineBytes ceiling holds even when base and options are larger", () => {
  const dir = freshDir();
  const store = Store.open(join(dir, "store.db"));
  const loose = TRANSPORT_LIMIT_OPTIONS.maxInlineBytes * 3;
  const bridge = new DesktopBridge(
    {
      scopeId: "w-demo",
      sessionId: "s1",
      configRevision: "cfg1",
      profileRevision: "profile1",
      policyRevision: "policy1",
      lastDurableSeq: 0,
      maxInlineBytes: loose,
      resolveReference: () => true,
    },
    new Receipts(store),
    { maxInlineBytes: loose },
  );
  assert.throws(
    () =>
      bridge.submit(
        event("turn.started", {
          runId: "r1",
          turnId: "t1",
          blob: "x".repeat(TRANSPORT_LIMIT_OPTIONS.maxInlineBytes + 1024),
        }),
      ),
    (error: unknown) =>
      error instanceof BridgeError && error.code === "CONTRACT_FRAME_TOO_LARGE",
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("highestQueuedSeq counts durable frames only", () => {
  const { bridge, store, dir } = makeBridge();
  bridge.submit(event("turn.stream_delta", { runId: "r0", delta: "d" }));
  // Transient-only queue: no durable seq is pending.
  assert.equal(bridge.highestQueuedSeq(), 0);
  const durable = event("turn.started", { runId: "r1", turnId: "t1" });
  bridge.submit(durable);
  bridge.submit(event("turn.stream_delta", { runId: "r1", delta: "d" }));
  // A later transient seq must not raise the durable high-water mark.
  assert.equal(bridge.highestQueuedSeq(), durable.seq);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
