// TD-12 / C1 session navigation: pure reducer cases. The Svelte view renders this state only.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createSessionNav,
  reduceSessionNav,
  visibleNodes,
  type SessionNavAction,
  type SessionNavState,
  type TreeEventLike,
} from "./sessions";

const tree = (
  sessionId: string,
  branchAnchorId: string,
  leaves: string[] = ["e1"],
  seq = 1,
): TreeEventLike => ({
  kind: "session.tree_updated",
  sessionId,
  seq,
  payload: { sessionId, branchAnchorId, leaves },
});
const apply = (state: SessionNavState, ...actions: SessionNavAction[]) =>
  actions.reduce(reduceSessionNav, state);
const keys = (state: SessionNavState) => visibleNodes(state).map((n) => n.key);

test("page snapshots load native anchors, preserve current leaves and remove absent selections", () => {
  let state = apply(
    createSessionNav(),
    { type: "event", event: tree("s1", "b1", ["leaf"], 8) },
    { type: "select", key: "s1/b1" },
  );
  state = reduceSessionNav(state, {
    type: "snapshot",
    sessions: [
      {
        sessionId: "s1",
        branchAnchorId: "b1",
        state: "idle",
        createdAt: "",
        updatedAt: "",
      },
      {
        sessionId: "s2",
        branchAnchorId: null,
        state: "idle",
        createdAt: "",
        updatedAt: "",
      },
    ],
  });
  assert.equal(state.load, "ready");
  assert.equal(state.selectedKey, "s1/b1");
  assert.deepEqual(visibleNodes(state)[0].leaves, ["leaf"]);
  assert.deepEqual(keys(state), ["s1/b1"]);
  state = reduceSessionNav(state, { type: "snapshot", sessions: [] });
  assert.equal(state.load, "empty");
  assert.equal(state.selectedKey, null);
  assert.equal(state.lostSelection, "s1/b1");
});

test("starts in a distinct loading state with nothing selected", () => {
  const s = createSessionNav();
  assert.equal(s.load, "loading");
  assert.deepEqual(keys(s), []);
  assert.equal(s.selectedKey, null);
});

test("an empty result is empty, not loading and not an error", () => {
  const s = apply(createSessionNav(), { type: "loaded" });
  assert.equal(s.load, "empty");
});

test("a load failure keeps its own state and message and never looks empty", () => {
  const s = apply(createSessionNav(), {
    type: "failed",
    message: "engine gone",
  });
  assert.equal(s.load, "error");
  assert.equal(s.error, "engine gone");
});

test("tree events build nodes keyed by engine identity, not by label", () => {
  const s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
    { type: "event", event: tree("s1", "b2") },
    { type: "event", event: tree("s2", "b1") },
  );
  assert.equal(s.load, "ready");
  assert.deepEqual(keys(s), ["s1/b1", "s1/b2", "s2/b1"]);
});

test("a replayed tree event is idempotent", () => {
  const e: SessionNavAction = { type: "event", event: tree("s1", "b1") };
  const once = apply(createSessionNav(), { type: "loaded" }, e);
  const twice = apply(once, e);
  assert.deepEqual(keys(twice), keys(once));
  assert.equal(visibleNodes(twice)[0].leaves.length, 1);
});

test("a newer event for the same branch replaces its leaves", () => {
  const s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1", ["e1"]) },
    { type: "event", event: tree("s1", "b1", ["e1", "e2"], 2) },
  );
  assert.deepEqual(visibleNodes(s)[0].leaves, ["e1", "e2"]);
});

test("selection and focus survive a refresh that keeps the branch", () => {
  let s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
    { type: "event", event: tree("s1", "b2") },
    { type: "select", key: "s1/b2" },
  );
  s = apply(
    s,
    { type: "refresh" },
    { type: "event", event: tree("s1", "b1") },
    { type: "event", event: tree("s1", "b2", ["e1", "e2"]) },
    { type: "loaded" },
  );
  assert.equal(s.selectedKey, "s1/b2");
  assert.equal(s.focusKey, "s1/b2");
  assert.equal(s.load, "ready");
});

test("refresh shows loading but keeps the previous nodes and selection until replaced", () => {
  const s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
    { type: "select", key: "s1/b1" },
    { type: "refresh" },
  );
  assert.equal(s.load, "loading");
  assert.deepEqual(keys(s), ["s1/b1"]);
  assert.equal(s.selectedKey, "s1/b1");
});

test("a selected branch that vanished is reported lost, not silently reselected", () => {
  let s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
    { type: "select", key: "s1/b1" },
    { type: "refresh" },
    { type: "event", event: tree("s1", "b9") },
    { type: "loaded" },
  );
  assert.equal(s.selectedKey, null);
  assert.equal(s.lostSelection, "s1/b1");
});

test("selecting an unknown key is rejected and changes nothing", () => {
  const s0 = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
  );
  const s1 = apply(s0, { type: "select", key: "nope/x" });
  assert.equal(s1.selectedKey, null);
  assert.equal(s1.focusKey, s0.focusKey);
});

test("arrow movement walks visible nodes without wrapping and Home/End jump", () => {
  let s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
    { type: "event", event: tree("s1", "b2") },
    { type: "event", event: tree("s1", "b3") },
    { type: "focus", key: "s1/b1" },
  );
  s = apply(s, { type: "move", to: "next" });
  assert.equal(s.focusKey, "s1/b2");
  s = apply(s, { type: "move", to: "last" });
  assert.equal(s.focusKey, "s1/b3");
  s = apply(s, { type: "move", to: "next" });
  assert.equal(s.focusKey, "s1/b3");
  s = apply(s, { type: "move", to: "first" });
  assert.equal(s.focusKey, "s1/b1");
  s = apply(s, { type: "move", to: "prev" });
  assert.equal(s.focusKey, "s1/b1");
});

test("moving focus never changes the selection", () => {
  let s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
    { type: "event", event: tree("s1", "b2") },
    { type: "select", key: "s1/b1" },
    { type: "move", to: "next" },
  );
  assert.equal(s.selectedKey, "s1/b1");
  assert.equal(s.focusKey, "s1/b2");
});

test("an event with no branch anchor or a non-tree kind is ignored", () => {
  const s0 = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
  );
  const bad: SessionNavAction = {
    type: "event",
    event: { kind: "turn.started", sessionId: "s1", seq: 2, payload: {} },
  };
  const noAnchor: SessionNavAction = {
    type: "event",
    event: {
      kind: "session.tree_updated",
      sessionId: "s1",
      seq: 3,
      payload: { sessionId: "s1", leaves: [] },
    },
  };
  assert.deepEqual(keys(apply(s0, bad, noAnchor)), ["s1/b1"]);
});

test("each node carries a text status so state is not color-only", () => {
  const s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
    { type: "select", key: "s1/b1" },
  );
  const node = visibleNodes(s)[0];
  assert.equal(node.selected, true);
  assert.match(node.stateLabel, /selected/i);
});

test("a late older event cannot overwrite a newer branch state", () => {
  const s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1", ["e1", "e2"], 5) },
    { type: "event", event: tree("s1", "b1", ["e1"], 3) },
  );
  assert.deepEqual(visibleNodes(s)[0].leaves, ["e1", "e2"]);
});

test("an older event after a refresh cannot replace a newer branch state", () => {
  const s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1", ["newer"], 5) },
    { type: "refresh" },
    { type: "event", event: tree("s1", "b1", ["older"], 3) },
    { type: "loaded" },
  );
  assert.deepEqual(visibleNodes(s)[0]?.leaves, ["newer"]);
});

test("a newer event after a refresh still replaces the previous state", () => {
  const s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1", ["old"], 5) },
    { type: "refresh" },
    { type: "event", event: tree("s1", "b1", ["new"], 6) },
    { type: "loaded" },
  );
  assert.deepEqual(visibleNodes(s)[0]?.leaves, ["new"]);
});

test("losing the selection to an empty snapshot is still reported", () => {
  const s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
    { type: "select", key: "s1/b1" },
    { type: "refresh" },
    { type: "loaded" },
  );
  assert.equal(s.load, "empty");
  assert.equal(s.selectedKey, null);
  assert.equal(s.lostSelection, "s1/b1");
});

test("an event whose payload names a different session than its envelope is ignored", () => {
  const mismatched: TreeEventLike = {
    kind: "session.tree_updated",
    sessionId: "s1",
    seq: 2,
    payload: { sessionId: "s2", branchAnchorId: "b1", leaves: ["e1"] },
  };
  const s = apply(
    createSessionNav(),
    { type: "loaded" },
    { type: "event", event: tree("s1", "b1") },
    { type: "event", event: mismatched },
  );
  assert.deepEqual(keys(s), ["s1/b1"]);
});
