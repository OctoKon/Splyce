import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateEvent } from "@splyce/pi/contracts";

const context = {
  scopeId: "w-demo",
  sessionId: "ses_test_01",
  configRevision: "cfg1",
  profileRevision: "profile1",
  policyRevision: "policy1",
  lastDurableSeq: 12,
  maxInlineBytes: 4096,
  resolveReference: () => true,
};

const fixtures = [
  "fui-w1-base-only.json",
  "fui-w2-ime-composition.json",
  "fui-w3-accessibility.json",
  "fui-w4-stream-backpressure.json",
  "fui-w5-approval-race.json",
  "fui-w6-crash-recovery.json",
];

function load(file) {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/gui/${file}`, import.meta.url), "utf8"),
  );
}

for (const file of fixtures) {
  test(`TD-34: GUI fixture ${file} conforms to frozen contract v1`, () => {
    const content = load(file);
    assert.equal(content.schemaVersion, 1);
    for (const step of content.eventSequence) {
      const ctx = {
        ...context,
        sessionId: step.event.sessionId,
        scopeId: step.event.scopeId,
      };
      const validated = validateEvent(step.event, ctx);
      assert.deepEqual(validated, step.event);
    }
  });
}

for (const file of fixtures) {
  test(`TD-34: GUI fixture ${file} declares executable actions and assertions`, () => {
    const content = load(file);
    assert.ok(Array.isArray(content.userActions));
    for (const [index, action] of content.userActions.entries()) {
      assert.equal(action.step, index + 1);
      assert.ok(
        ["type", "click", "shortcut", "resize", "ime_compose"].includes(
          action.action,
        ),
      );
      assert.equal(typeof action.targetSelector, "string");
      assert.ok(action.targetSelector.length > 0);
      if ("payload" in action) assert.equal(typeof action.payload, "string");
    }
    assert.equal(typeof content.assertions.expectedState, "object");
    assert.ok(Array.isArray(content.assertions.expectedDispatches));
    assert.ok(Array.isArray(content.assertions.accessibilityQueries));
    assert.equal(typeof content.assertions.guardRemovalCheck.action, "string");
    assert.equal(
      typeof content.assertions.guardRemovalCheck.mustFailWith,
      "string",
    );
  });
}

test("TD-34: FUI-W1 stays unconfigured and dispatches nothing", () => {
  const content = load("fui-w1-base-only.json");
  assert.equal(content.assertions.expectedState.generationBlocked, true);
  assert.equal(content.assertions.expectedState.unconfiguredBanner, true);
  assert.deepEqual(content.assertions.expectedDispatches, []);
  assert.ok(
    !content.eventSequence.some((step) => step.event.kind === "turn.completed"),
  );
  assert.equal(
    content.userActions[0].targetSelector,
    "[data-testid='setup-provider-card']",
  );
});

test("TD-34: FUI-W2 candidate confirm never submits and Ctrl+Enter submits once", () => {
  const content = load("fui-w2-ime-composition.json");
  const [compose, candidate, submit] = content.userActions;
  assert.equal(compose.action, "ime_compose");
  assert.equal(candidate.action, "shortcut");
  assert.equal(candidate.payload, "Enter");
  assert.equal(submit.action, "shortcut");
  assert.equal(submit.payload, "Ctrl+Enter");
  assert.equal(content.assertions.expectedState.isComposing, false);
  assert.equal(content.assertions.expectedState.submittedCount, 1);
  assert.deepEqual(content.assertions.expectedDispatches, [
    {
      op: "session.prompt",
      payloadMatch: { text: compose.payload },
    },
  ]);
});

test("TD-34: FUI-W6 exposes engine stopped and invalidates stale approvals", () => {
  const content = load("fui-w6-crash-recovery.json");
  const kinds = content.eventSequence.map((step) => step.event.kind);
  const stopped = content.eventSequence.find(
    (step) =>
      step.event.kind === "engine.status" &&
      step.event.payload.state === "stopped",
  );
  assert.ok(stopped);
  assert.ok(kinds.indexOf("approval.requested") >= 0);
  assert.ok(
    kinds.indexOf("approval.requested") < kinds.indexOf("engine.status"),
  );
  assert.equal(content.assertions.expectedState.draftPreserved, true);
  assert.equal(content.assertions.expectedState.staleApprovalsDisabled, true);
  assert.deepEqual(content.assertions.expectedDispatches, [
    { op: "engine.restart", payloadMatch: {} },
  ]);
  assert.ok(
    content.assertions.accessibilityQueries.some(
      (query) =>
        query.role === "alert" &&
        query.name === "Engine stopped" &&
        query.expectedState === "visible",
    ),
  );
});
