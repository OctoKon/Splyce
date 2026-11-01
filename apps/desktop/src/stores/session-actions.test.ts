// TD-33 / D4_session_resume_fork: pure lifecycle reducer cases.
// The Svelte view renders this state; nothing here performs a request.
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  REWIND_LIMITS,
  actionAvailability,
  createSessionActionState,
  forkPointLabel,
  newlyAdmittedRequest,
  reduceSessionAction,
  rewindChoiceAvailability,
  type RewindChoice,
  type SessionAction,
  type SessionActionsContext,
  type SessionActionState,
} from "./session-actions";

const selected = {
  sessionId: "ses_1",
  branchAnchorId: "anchor_1",
  leaves: ["e1", "e2"],
};

const ready = (): SessionActionsContext => ({
  engine: { status: "ready", reason: null },
  rewind: { status: "ready", reason: null },
  codeRestore: { status: "ready", reason: null },
  selected: { ...selected, leaves: [...selected.leaves] },
  draft: "half-typed instruction",
});

const apply = (
  context: SessionActionsContext,
  ...actions: SessionAction[]
): SessionActionState =>
  actions.reduce(
    (state, action) => reduceSessionAction(state, action, context),
    createSessionActionState(),
  );

test("starts idle with no request", () => {
  const s = createSessionActionState();
  assert.equal(s.phase, "idle");
  assert.equal(s.request, null);
  assert.equal(s.target, null);
  assert.equal(s.preservedDraft, null);
});

test("an unavailable engine blocks every action with its own reason", () => {
  const context: SessionActionsContext = {
    ...ready(),
    engine: { status: "unavailable", reason: "Session revisions are missing." },
  };
  for (const kind of ["resume", "fork", "rewind"] as const) {
    const s = apply(context, { type: "begin", kind });
    assert.equal(s.phase, "idle", kind);
    assert.equal(s.request, null, kind);
    assert.equal(s.blocked, "Session revisions are missing.", kind);
    assert.equal(actionAvailability(context, s, kind).enabled, false);
  }
});

test("no selected branch blocks every action and names the missing step", () => {
  const context: SessionActionsContext = { ...ready(), selected: null };
  for (const kind of ["resume", "fork", "rewind"] as const) {
    const s = apply(context, { type: "begin", kind });
    assert.equal(s.phase, "idle", kind);
    assert.equal(s.request, null, kind);
    assert.equal(s.blocked, "Select a session branch first.", kind);
  }
});

test("fork captures the engine ancestry and the editor text in one request", () => {
  const context = ready();
  const s = apply(context, { type: "begin", kind: "fork" });
  assert.equal(s.phase, "requesting");
  assert.equal(s.request?.kind, "fork");
  assert.equal(s.request?.sourceSessionId, "ses_1");
  assert.equal(s.request?.entryId, "anchor_1");
  assert.equal(s.preservedDraft, "half-typed instruction");
  assert.equal(forkPointLabel(s.target), "ses_1 / anchor_1");
});

test("the fork request cannot name ancestry the tree did not deliver", () => {
  const context = ready();
  const s = apply(context, { type: "begin", kind: "fork" });
  // A hardcoded or stale position would no longer match the selected node.
  assert.deepEqual(
    s.target && {
      sessionId: s.target.sessionId,
      branchAnchorId: s.target.branchAnchorId,
    },
    { sessionId: "ses_1", branchAnchorId: "anchor_1" },
  );
  assert.notEqual(s.request?.entryId, "e1");
});

test("resume reopens the session without inventing an entry position", () => {
  const s = apply(ready(), { type: "begin", kind: "resume" });
  assert.equal(s.request?.kind, "resume");
  assert.equal(s.request?.entryId, null);
  assert.equal(s.request?.choice, null);
});

test("rewind is destructive: beginning it confirms first and requests nothing", () => {
  const s = apply(ready(), { type: "begin", kind: "rewind" });
  assert.equal(s.phase, "confirming");
  assert.equal(s.request, null);
  assert.equal(s.choice, "conversation");
});

test("confirming a conversation rewind produces the typed request and its scope", () => {
  const s = apply(
    ready(),
    { type: "begin", kind: "rewind" },
    { type: "confirm" },
  );
  assert.equal(s.phase, "requesting");
  assert.equal(s.request?.kind, "rewind");
  assert.equal(s.request?.sourceSessionId, "ses_1");
  assert.equal(s.request?.entryId, "anchor_1");
  assert.equal(s.request?.choice, "conversation");
});

test("code restore is refused until TD-25 admits it, with the visible reason", () => {
  const context: SessionActionsContext = {
    ...ready(),
    codeRestore: {
      status: "unavailable",
      reason: "Code restore is not wired.",
    },
  };
  assert.deepEqual(rewindChoiceAvailability(context, "code"), {
    enabled: false,
    reason: "Code restore is not wired.",
  });
  for (const choice of ["code", "both"] as const) {
    const s = apply(
      context,
      { type: "begin", kind: "rewind" },
      { type: "choose", choice },
      { type: "confirm" },
    );
    assert.equal(s.phase, "confirming", choice);
    assert.equal(s.request, null, choice);
    assert.equal(s.blocked, "Code restore is not wired.", choice);
  }
});

test("a rewind confirmed after the selection changed is refused, not retargeted", () => {
  const context = ready();
  const confirming = apply(context, { type: "begin", kind: "rewind" });
  const moved: SessionActionsContext = {
    ...context,
    selected: {
      sessionId: "ses_1",
      branchAnchorId: "anchor_2",
      leaves: ["e3"],
    },
  };
  const s = reduceSessionAction(confirming, { type: "confirm" }, moved);
  assert.equal(s.phase, "confirming");
  assert.equal(s.request, null);
  assert.match(s.blocked ?? "", /selected branch changed/);
});

test("unavailable conversation rewind is disabled and cannot be confirmed", () => {
  const context: SessionActionsContext = {
    ...ready(),
    rewind: { status: "unavailable", reason: "Rewind is not admitted." },
  };
  const blockedStart = apply(context, { type: "begin", kind: "rewind" });
  assert.equal(blockedStart.phase, "idle");
  assert.equal(blockedStart.blocked, "Rewind is not admitted.");
  assert.equal(
    rewindChoiceAvailability(context, "conversation").enabled,
    false,
  );
});

test("cancellation differs from success and keeps the editor text", () => {
  const fromConfirm = apply(
    ready(),
    { type: "begin", kind: "rewind" },
    { type: "cancel" },
  );
  const fromRequest = apply(
    ready(),
    { type: "begin", kind: "fork" },
    { type: "cancel" },
  );
  // A confirmation was never dispatched: the source really is untouched.
  assert.equal(fromConfirm.phase, "canceled");
  assert.equal(fromConfirm.request, null);
  assert.equal(fromConfirm.canceledWhileRequesting, false);
  // A dispatched request cannot be recalled by the renderer: stay pending.
  assert.equal(fromRequest.phase, "canceling");
  assert.equal(fromRequest.request, null);
  assert.equal(fromRequest.canceledWhileRequesting, true);
  for (const s of [fromConfirm, fromRequest]) {
    assert.equal(s.preservedDraft, "half-typed instruction");
    assert.equal(s.error, null);
  }
});

test("a rewind confirmed after the engine went away is refused", () => {
  const confirming = apply(ready(), { type: "begin", kind: "rewind" });
  const s = reduceSessionAction(
    confirming,
    { type: "confirm" },
    {
      ...ready(),
      engine: { status: "unavailable", reason: "The engine was lost." },
    },
  );
  assert.equal(s.phase, "confirming");
  assert.equal(s.request, null);
  assert.equal(s.blocked, "The engine was lost.");
});

test("another action cannot start on top of a rewind confirmation", () => {
  const context = ready();
  const confirming = apply(context, { type: "begin", kind: "rewind" });
  assert.deepEqual(actionAvailability(context, confirming, "fork"), {
    enabled: false,
    reason: "Finish or cancel the rewind confirmation first.",
  });
  const s = reduceSessionAction(
    confirming,
    { type: "begin", kind: "fork" },
    context,
  );
  assert.equal(s.phase, "confirming");
  assert.equal(s.request, null);
});

test("a late result is the engine's answer, not a local claim", () => {
  const canceling = apply(
    ready(),
    { type: "begin", kind: "fork" },
    { type: "cancel" },
  );
  // The executor completed despite the cancel request: say so honestly.
  const completed = reduceSessionAction(
    canceling,
    { type: "succeeded" },
    ready(),
  );
  assert.equal(completed.phase, "succeeded");
  assert.equal(completed.request, null);
  assert.equal(completed.canceledWhileRequesting, true);

  const refused = reduceSessionAction(
    canceling,
    { type: "failed", message: "The engine stopped the request." },
    ready(),
  );
  assert.equal(refused.phase, "failed");
  assert.equal(refused.request, null);
  assert.equal(refused.canceledWhileRequesting, true);
  assert.equal(refused.error, "The engine stopped the request.");
});

test("a stop the engine confirms is its own outcome, not an untouched source", () => {
  const context = ready();
  const canceling = apply(
    context,
    { type: "begin", kind: "fork" },
    { type: "cancel" },
  );
  const stopped = reduceSessionAction(canceling, { type: "stopped" }, context);
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.request, null);
  assert.equal(stopped.canceledWhileRequesting, true);
  assert.equal(stopped.preservedDraft, "half-typed instruction");
  assert.equal(stopped.error, null);
  // A request was sent: the engine-confirmed stop must never be presented as
  // the "nothing was requested" cancel, which claims the source is unchanged.
  assert.notEqual(stopped.phase, "canceled");
  // The engine has answered, so the actions are usable again.
  assert.deepEqual(actionAvailability(context, stopped, "fork"), {
    enabled: true,
    reason: null,
  });
});

test("a stop cannot settle a request that never left the UI", () => {
  for (const settled of [
    apply(ready()),
    apply(ready(), { type: "begin", kind: "rewind" }),
  ]) {
    assert.equal(
      reduceSessionAction(settled, { type: "stopped" }, ready()),
      settled,
    );
  }
});

test("a canceling state blocks every new action until the engine answers", () => {
  const context = ready();
  const canceling = apply(
    context,
    { type: "begin", kind: "fork" },
    { type: "cancel" },
  );
  for (const kind of ["resume", "fork", "rewind"] as const) {
    assert.deepEqual(actionAvailability(context, canceling, kind), {
      enabled: false,
      reason:
        "Cancel requested: waiting for the engine to confirm the request stopped.",
    });
    const again = reduceSessionAction(
      canceling,
      { type: "begin", kind },
      context,
    );
    assert.equal(again.phase, "canceling", kind);
    assert.equal(again.request, null, kind);
  }
});

test("only a newly admitted transition hands over a request", () => {
  const context = ready();
  const idle = createSessionActionState();
  const forked = reduceSessionAction(
    idle,
    { type: "begin", kind: "fork" },
    context,
  );
  assert.equal(newlyAdmittedRequest(idle, forked), forked.request);

  // A second activation in the same tick is refused and reuses the in-flight
  // request; it must not be dispatched again.
  const again = reduceSessionAction(
    forked,
    { type: "begin", kind: "fork" },
    context,
  );
  assert.equal(again.request, forked.request);
  assert.equal(newlyAdmittedRequest(forked, again), null);

  // The same holds for a second confirm after a rewind request left the dialog.
  const confirming = apply(context, { type: "begin", kind: "rewind" });
  const requested = reduceSessionAction(
    confirming,
    { type: "confirm" },
    context,
  );
  assert.ok(requested.request);
  assert.equal(newlyAdmittedRequest(confirming, requested), requested.request);
  const confirmedAgain = reduceSessionAction(
    requested,
    { type: "confirm" },
    context,
  );
  assert.equal(newlyAdmittedRequest(requested, confirmedAgain), null);
});

test("success and failure settle only an in-flight request", () => {
  const idle = apply(ready());
  assert.equal(
    reduceSessionAction(idle, { type: "succeeded" }, ready()).phase,
    "idle",
  );

  const requesting = apply(ready(), { type: "begin", kind: "fork" });
  const failed = reduceSessionAction(
    requesting,
    { type: "failed", message: "Engine refused the fork." },
    ready(),
  );
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error, "Engine refused the fork.");
  assert.equal(failed.request, null);
  assert.equal(failed.preservedDraft, "half-typed instruction");

  const succeeded = reduceSessionAction(
    requesting,
    { type: "succeeded" },
    ready(),
  );
  assert.equal(succeeded.phase, "succeeded");
  assert.equal(succeeded.request, null);
  assert.equal(succeeded.preservedDraft, "half-typed instruction");
});

test("a second action cannot start while one is in flight", () => {
  const context = ready();
  const busy = apply(context, { type: "begin", kind: "fork" });
  assert.deepEqual(actionAvailability(context, busy, "resume"), {
    enabled: false,
    reason: "A resume request is already in flight.",
  });
  const again = reduceSessionAction(
    busy,
    { type: "begin", kind: "resume" },
    context,
  );
  assert.equal(again.phase, "requesting");
  assert.equal(again.request?.kind, "fork");
  assert.match(again.blocked ?? "", /already in flight/);
});

test("the draft captured at the start survives a newer context draft", () => {
  const context = ready();
  const started = apply(context, { type: "begin", kind: "fork" });
  const retyped = reduceSessionAction(
    started,
    { type: "failed", message: "refused" },
    { ...context, draft: "a different draft" },
  );
  assert.equal(retyped.preservedDraft, "half-typed instruction");
});

test("a new action captures the current draft, not the previous action's", () => {
  const context = ready();
  // Cancel a confirmation (nothing was dispatched), which returns to a state
  // where a new action may start.
  const canceled = apply(
    context,
    { type: "begin", kind: "rewind" },
    { type: "cancel" },
  );
  assert.equal(canceled.phase, "canceled");
  assert.equal(canceled.preservedDraft, "half-typed instruction");

  const next = reduceSessionAction(
    canceled,
    { type: "begin", kind: "fork" },
    { ...context, draft: "a newer draft" },
  );
  assert.equal(next.preservedDraft, "a newer draft");
});

test("confirmation is inert outside a rewind confirmation", () => {
  const idle = apply(ready(), { type: "confirm" });
  assert.equal(idle.phase, "idle");
  const forked = apply(
    ready(),
    { type: "begin", kind: "fork" },
    { type: "confirm" },
  );
  assert.equal(forked.request?.kind, "fork");
});

test("rewind presents the C3 choices and limits before any write", () => {
  assert.deepEqual(["conversation", "code", "both"] as RewindChoice[], [
    "conversation",
    "code",
    "both",
  ]);
  assert.deepEqual(REWIND_LIMITS, [
    "Shell commands and external edits are not restored.",
    "Prior external effects are not undoable.",
    "The source conversation is kept: rewind forks its ancestry and never deletes it.",
  ]);
});
