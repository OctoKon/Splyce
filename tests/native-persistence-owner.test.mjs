import assert from "node:assert/strict";
import test from "node:test";
import * as core from "../vendor/pi/packages/agent/src/splyce-readiness.ts";

const unavailable = (error) =>
  error?.code === "PERSIST_REDACTION_UNAVAILABLE" &&
  error.message === "PERSIST_REDACTION_UNAVAILABLE";

test("the native oversized-entry code propagates with fixed public text", async () => {
  const owner = core.createSplyceOwner(() => {});
  const manager = {};
  owner.bindPersistence(manager, async () => {
    throw Object.assign(new Error("fixture-private-detail"), {
      code: "PERSIST_ENTRY_TOO_LARGE",
    });
  });
  await assert.rejects(
    core.sanitizeSplycePersistence(manager, "entry"),
    (error) =>
      error?.code === "PERSIST_ENTRY_TOO_LARGE" &&
      error.message === "PERSIST_ENTRY_TOO_LARGE",
  );
});

test("persistence requires a sealed same-owner sanitizer, not a readiness binding alone", async () => {
  const owner = core.createSplyceOwner(() => {});
  const manager = {};
  owner.bind(manager, "session-manager");
  assert.equal(core.isSplyceOwned(manager), true);
  assert.throws(() => core.assertSplycePersistence(manager), unavailable);
  await assert.rejects(
    core.sanitizeSplycePersistence(manager, "{}"),
    unavailable,
  );
  owner.bindPersistence(manager, async (text) =>
    text.replaceAll("fixture-private-value", "[redacted]"),
  );
  core.assertSplycePersistence(manager);
  assert.equal(
    await core.sanitizeSplycePersistence(manager, '"fixture-private-value"'),
    '"[redacted]"',
  );
});

test("persistence callback cannot be replaced or rebound to another owner or role", async () => {
  const owner = core.createSplyceOwner(() => {});
  const other = core.createSplyceOwner(() => {});
  const manager = {};
  owner.bindPersistence(manager, async () => "safe");
  assert.throws(
    () => owner.bindPersistence(manager, async () => "unsafe"),
    unavailable,
  );
  assert.throws(
    () => other.bindPersistence(manager, async () => "unsafe"),
    unavailable,
  );
  const model = {};
  owner.bind(model, "model");
  assert.throws(
    () => owner.bindPersistence(model, async (text) => text),
    unavailable,
  );
  assert.equal(await core.sanitizeSplycePersistence(manager, "input"), "safe");
});

test("owner disposal during awaited sanitation rejects with no raw fallback", async () => {
  let finish;
  const owner = core.createSplyceOwner(() => {});
  const manager = {};
  owner.bindPersistence(
    manager,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = core.sanitizeSplycePersistence(manager, "private");
  owner.dispose();
  finish("safe");
  await assert.rejects(pending, unavailable);
  assert.equal(core.isSplyceOwned(manager), true);
  assert.throws(() => core.assertSplycePersistence(manager), unavailable);
});

test("stale owner, sanitizer rejection and invalid output expose only the typed persistence failure", async () => {
  let current = true;
  const owner = core.createSplyceOwner(() => {
    if (!current) throw new Error("fixture-private-detail");
  });
  const manager = {};
  owner.bindPersistence(manager, async () => {
    throw new Error("fixture-private-detail");
  });
  await assert.rejects(
    core.sanitizeSplycePersistence(manager, "input"),
    unavailable,
  );
  current = false;
  await assert.rejects(
    core.sanitizeSplycePersistence(manager, "input"),
    unavailable,
  );
  const wrong = {};
  core
    .createSplyceOwner(() => {})
    .bindPersistence(wrong, async () => ({ text: "not the sealed contract" }));
  await assert.rejects(
    core.sanitizeSplycePersistence(wrong, "input"),
    unavailable,
  );
});

test("aborted sanitation never invokes the lane and abort while awaiting cannot return data", async () => {
  let calls = 0;
  let finish;
  const owner = core.createSplyceOwner(() => {});
  const manager = {};
  owner.bindPersistence(manager, (_text, signal) => {
    calls++;
    assert.equal(signal instanceof AbortSignal, true);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const stopped = AbortSignal.abort();
  await assert.rejects(
    core.sanitizeSplycePersistence(manager, "input", stopped),
    unavailable,
  );
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = core.sanitizeSplycePersistence(
    manager,
    "input",
    controller.signal,
  );
  controller.abort();
  finish("safe");
  await assert.rejects(pending, unavailable);
  assert.equal(calls, 1);
});
