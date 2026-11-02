// TD-25 cases for packages/splyce-pi/src/recovery.ts (C3_session_crash, C3_user_rewind limits, D5_child_crash_reconnect).
// Written failing-first against the published interface; names are proposals pending TD-14/TD-24 contracts.
import assert from "node:assert/strict";
import test from "node:test";
import { admissionOpen, reconcile } from "@splyce/pi/recovery";

const lease = (piSessionId, writerId = "w1") => ({
  piSessionId,
  writerId,
  leaseEpoch: "1",
});
const base = (over = {}) => ({
  runs: [{ runId: "r1", piSessionId: "s1", state: "running" }],
  actions: [],
  outcomes: [],
  writers: [{ lease: lease("s1"), alive: false }],
  explicitRestart: true,
  ...over,
});
const action = (actionId, state, runId = "r1") => ({ actionId, runId, state });

test("recovery needs an explicit Restart, never runs silently", () => {
  assert.throws(() => reconcile(base({ explicitRestart: false })), /explicit/);
});

test("a running action with no observed result becomes uncertain and is never redispatched", () => {
  const report = reconcile(base({ actions: [action("a1", "running")] }));
  assert.deepEqual(
    report.actionCorrections.map((c) => [c.actionId, c.to]),
    [["a1", "uncertain"]],
  );
  assert.deepEqual(report.uncertain, ["a1"]);
  assert.deepEqual(report.redispatch, []);
});

test("a durably observed outcome settles the action instead of leaving it uncertain", () => {
  const report = reconcile(
    base({
      actions: [action("ok", "running"), action("bad", "running")],
      outcomes: [
        { actionId: "ok", effectState: "observed-success" },
        { actionId: "bad", effectState: "observed-failure" },
      ],
    }),
  );
  const to = Object.fromEntries(
    report.actionCorrections.map((c) => [c.actionId, c.to]),
  );
  assert.deepEqual(to, { ok: "completed", bad: "failed" });
  assert.deepEqual(report.uncertain, []);
});

test("an uncertain outcome keeps the action uncertain", () => {
  const report = reconcile(
    base({
      actions: [action("a1", "running")],
      outcomes: [{ actionId: "a1", effectState: "uncertain" }],
    }),
  );
  assert.deepEqual(report.uncertain, ["a1"]);
});

test("completed without an observed-success outcome is corrected: a completed effect is never invented", () => {
  for (const outcomes of [
    [],
    [{ actionId: "a1", effectState: "uncertain" }],
    [{ actionId: "a1", effectState: "observed-failure" }],
  ]) {
    const report = reconcile(
      base({
        runs: [{ runId: "r1", piSessionId: "s1", state: "completed" }],
        actions: [action("a1", "completed")],
        outcomes,
      }),
    );
    assert.deepEqual(report.uncertain, ["a1"]);
  }
});

test("a properly completed action is left alone", () => {
  const report = reconcile(
    base({
      runs: [{ runId: "r1", piSessionId: "s1", state: "completed" }],
      actions: [action("a1", "completed")],
      outcomes: [{ actionId: "a1", effectState: "observed-success" }],
    }),
  );
  assert.deepEqual(report.actionCorrections, []);
  assert.deepEqual(report.runCorrections, []);
});

test("an action that never reached its effect is canceled, not left dispatchable, not uncertain, not replayed", () => {
  for (const state of ["pending", "approved"]) {
    const report = reconcile(base({ actions: [action("a1", state)] }));
    assert.deepEqual(
      report.actionCorrections.map((c) => [c.actionId, c.from, c.to]),
      [["a1", state, "canceled"]],
    );
    assert.deepEqual(report.uncertain, []);
    assert.deepEqual(report.redispatch, []);
  }
});

test("an interrupted run with an uncertain action is uncertain; without one it failed", () => {
  const withEffect = reconcile(base({ actions: [action("a1", "running")] }));
  assert.equal(withEffect.runCorrections[0].to, "uncertain");
  const without = reconcile(base());
  assert.equal(without.runCorrections[0].to, "failed");
});

test("surviving or unknown writers block takeover even when their lease expired", () => {
  for (const alive of [true, "unknown"]) {
    const report = reconcile(
      base({ writers: [{ lease: lease("s1"), alive }] }),
    );
    assert.equal(report.takeoverBlocked.length, 1);
    assert.equal(report.takeoverBlocked[0].piSessionId, "s1");
  }
  const free = reconcile(
    base({ writers: [{ lease: lease("s1"), alive: false }] }),
  );
  assert.deepEqual(free.takeoverBlocked, []);
});

test("uncertain owned effects block takeover even when every writer is gone", () => {
  const report = reconcile(
    base({
      actions: [action("a1", "running")],
      writers: [{ lease: lease("s1"), alive: false }],
    }),
  );
  assert.match(report.takeoverBlocked[0].reason, /uncertain/);
});

test("admission stays closed until every correction has been applied", () => {
  const report = reconcile(
    base({ actions: [action("a1", "running"), action("a2", "running")] }),
  );
  assert.equal(report.admissionOpen, false);
  assert.equal(
    admissionOpen(report, { actionIds: ["a1"], runIds: ["r1"] }),
    false,
  );
  assert.equal(
    admissionOpen(report, { actionIds: ["a1", "a2"], runIds: [] }),
    false,
  );
  assert.equal(
    admissionOpen(report, { actionIds: ["a1", "a2"], runIds: ["r1"] }),
    true,
  );
});

test("takeover stays blocked by an uncertain action whatever state its run is in", () => {
  for (const runState of ["completed", "failed", "canceled", "uncertain"]) {
    const report = reconcile(
      base({
        runs: [{ runId: "r1", piSessionId: "s1", state: runState }],
        actions: [action("a1", "uncertain")],
        writers: [{ lease: lease("s1"), alive: false }],
      }),
    );
    assert.equal(report.takeoverBlocked.length, 1, runState);
    assert.match(report.takeoverBlocked[0].reason, /uncertain/);
  }
});

test("a completed run whose completed action lacks an observed-success outcome blocks takeover", () => {
  const report = reconcile(
    base({
      runs: [{ runId: "r1", piSessionId: "s1", state: "completed" }],
      actions: [action("a1", "completed")],
      writers: [{ lease: lease("s1"), alive: false }],
    }),
  );
  assert.deepEqual(report.uncertain, ["a1"]);
  assert.equal(report.takeoverBlocked[0].piSessionId, "s1");
});

test("an uncertain action whose run is missing from the journal blocks as unattributed", () => {
  const report = reconcile(
    base({
      runs: [],
      actions: [action("a1", "uncertain", "ghost")],
      writers: [],
    }),
  );
  assert.equal(report.takeoverBlocked[0].piSessionId, "unattributed:ghost");
});
