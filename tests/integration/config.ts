// TD-26 / C4 config transitions — one compare-and-set over requested/effective
// configuration, against the TD-09 store. A failed or stale write can never
// change the effective revision.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ConfigAuthority,
  type ConfigChange,
} from "../../packages/splyce-pi/dist/config.js";
import {
  INITIAL_CONFIG_REVISION,
  Store,
  StoreError,
} from "../../packages/splyce-pi/dist/store.js";

const caller = {
  sessionId: "s1",
  configRevision: "cfg-0",
  profileRevision: "profile1",
  policyRevision: "policy1",
  resolveReference: () => true,
};

const tmpRoot = mkdtempSync(join(tmpdir(), "td26-config-"));
let tmpCounter = 0;
const freshDir = () => {
  tmpCounter += 1;
  const dir = join(tmpRoot, `t${String(tmpCounter)}`);
  mkdirSync(dir);
  return dir;
};

const change = (
  transitionId: string,
  expected: string,
  accepted: string,
  scopeId = "w-demo",
): ConfigChange => ({
  scopeId,
  transitionId,
  expectedConfigRevision: expected,
  acceptedConfigRevision: accepted,
  intentRef: "intent1",
  changedValuesArtifactId: "changes1",
});

const open = (dir: string) => {
  const store = Store.open(join(dir, "store.db"));
  return { store, config: new ConfigAuthority(store) };
};

const staleError = (error: unknown) =>
  error instanceof StoreError && error.code === "CONFIG_STALE_REVISION";

test("a scope with no applied transition is at the initial revision", () => {
  const dir = freshDir();
  const { store, config } = open(dir);
  assert.equal(config.effectiveRevision("w-demo"), INITIAL_CONFIG_REVISION);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("request records the change durably without making it effective", () => {
  const dir = freshDir();
  const { store, config } = open(dir);
  const before = store.cursor("w-demo");
  const result = config.request(change("c1", "cfg-0", "cfg-1"), caller);
  assert.ok(result.seq > before, "the requested change is durable");
  assert.equal(result.effectiveRevision, "cfg-0");
  assert.equal(config.effectiveRevision("w-demo"), "cfg-0");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("apply activates the accepted revision and survives reopen", () => {
  const dir = freshDir();
  const first = open(dir);
  const applied = first.config.apply(change("c1", "cfg-0", "cfg-1"), caller);
  assert.equal(applied.effectiveRevision, "cfg-1");
  first.store.close();
  const second = open(dir);
  assert.equal(second.config.effectiveRevision("w-demo"), "cfg-1");
  second.store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a stale expected revision is rejected and appends nothing", () => {
  const dir = freshDir();
  const { store, config } = open(dir);
  config.apply(change("c1", "cfg-0", "cfg-1"), caller);
  const cursor = store.cursor("w-demo");
  assert.throws(
    () => config.apply(change("c2", "cfg-0", "cfg-2"), caller),
    staleError,
  );
  assert.equal(store.cursor("w-demo"), cursor, "nothing acknowledged");
  assert.equal(config.effectiveRevision("w-demo"), "cfg-1");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("competing clients on separate handles: exactly one apply commits", () => {
  const dir = freshDir();
  const a = open(dir);
  const b = open(dir);
  // Both clients observed cfg-0 and race to move it.
  assert.equal(a.config.effectiveRevision("w-demo"), "cfg-0");
  assert.equal(b.config.effectiveRevision("w-demo"), "cfg-0");
  a.config.apply(change("ca", "cfg-0", "cfg-a"), caller);
  assert.throws(
    () => b.config.apply(change("cb", "cfg-0", "cfg-b"), caller),
    staleError,
  );
  // The loser sees the committed revision and can retry from it.
  assert.equal(b.config.effectiveRevision("w-demo"), "cfg-a");
  b.config.apply(change("cb2", "cfg-a", "cfg-b"), caller);
  assert.equal(a.config.effectiveRevision("w-demo"), "cfg-b");
  a.store.close();
  b.store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a failed or invalid write never changes the effective revision", () => {
  const dir = freshDir();
  const { store, config } = open(dir);
  config.apply(change("c1", "cfg-0", "cfg-1"), caller);
  // Marking a later request failed does not move the effective revision.
  config.request(change("c2", "cfg-1", "cfg-2"), caller);
  config.fail(change("c2", "cfg-1", "cfg-2"), caller);
  assert.equal(config.effectiveRevision("w-demo"), "cfg-1");
  // A write that fails contract validation acknowledges nothing and changes nothing.
  const cursor = store.cursor("w-demo");
  const invalid = { ...change("c3", "cfg-1", "cfg-3"), intentRef: "" };
  assert.throws(() => config.apply(invalid, caller));
  assert.equal(store.cursor("w-demo"), cursor);
  assert.equal(config.effectiveRevision("w-demo"), "cfg-1");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a no-op transition is rejected", () => {
  const dir = freshDir();
  const { store, config } = open(dir);
  assert.throws(
    () => config.apply(change("c1", "cfg-0", "cfg-0"), caller),
    (error: unknown) =>
      error instanceof Error &&
      (error as { code?: string }).code === "CONFIG_NO_CHANGE",
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("revisions are per scope", () => {
  const dir = freshDir();
  const { store, config } = open(dir);
  config.apply(change("c1", "cfg-0", "cfg-1", "w-one"), caller);
  assert.equal(config.effectiveRevision("w-one"), "cfg-1");
  assert.equal(config.effectiveRevision("w-two"), INITIAL_CONFIG_REVISION);
  // w-two's CAS is independent of w-one's revision.
  config.apply(change("c2", "cfg-0", "cfg-9", "w-two"), caller);
  assert.equal(config.effectiveRevision("w-two"), "cfg-9");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("an unreadable (future-schema) configuration row fails closed, never adopted", () => {
  const dir = freshDir();
  const path = join(dir, "store.db");
  const { store, config } = open(dir);
  config.apply(change("c1", "cfg-0", "cfg-1"), caller);
  store.close();
  // A newer writer committed an applied transition this build cannot read.
  const raw = new DatabaseSync(path);
  raw
    .prepare(
      "INSERT INTO records (kind, record_id, schema_version, scope_id, session_id, created_at, payload) VALUES ('configurationTransition', 'future.applied', 99, 'w-demo', 's1', '2026-10-26T00:00:00.000Z', ?)",
    )
    .run(
      JSON.stringify({
        recordId: "future.applied",
        scopeId: "w-demo",
        state: "applied",
        acceptedConfigRevision: "cfg-future",
      }),
    );
  raw.close();
  const reopened = open(dir);
  const unknown = (error: unknown) =>
    error instanceof StoreError && error.code === "UNKNOWN_SCHEMA";
  assert.throws(() => reopened.config.effectiveRevision("w-demo"), unknown);
  // The CAS cannot trust state it cannot read: nothing is appended.
  const cursor = reopened.store.cursor("w-demo");
  assert.throws(
    () => reopened.config.apply(change("c2", "cfg-1", "cfg-2"), caller),
    unknown,
  );
  assert.equal(reopened.store.cursor("w-demo"), cursor);
  reopened.store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a reused revision is rejected, so a stale writer cannot ABA past the CAS", () => {
  const dir = freshDir();
  const { store, config } = open(dir);
  config.apply(change("c1", "cfg-0", "cfg-1"), caller);
  // Returning to the initial revision would recreate the state a stale writer expects.
  const reused = (error: unknown) =>
    error instanceof StoreError && error.code === "CONFIG_REVISION_REUSED";
  assert.throws(
    () => config.apply(change("c2", "cfg-1", INITIAL_CONFIG_REVISION), caller),
    reused,
  );
  config.apply(change("c3", "cfg-1", "cfg-2"), caller);
  // Going back to a previously accepted revision is rejected too.
  assert.throws(
    () => config.apply(change("c4", "cfg-2", "cfg-1"), caller),
    reused,
  );
  assert.equal(config.effectiveRevision("w-demo"), "cfg-2");
  // A writer that still holds cfg-0 stays stale.
  assert.throws(
    () => config.apply(change("c5", "cfg-0", "cfg-9"), caller),
    staleError,
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
