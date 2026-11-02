// Splyce TD-26: real Store entity CAS and additive profile contracts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ContractError,
  validateRecord,
} from "../../packages/splyce-pi/dist/contracts.js";
import { Store, StoreError } from "../../packages/splyce-pi/dist/store.js";

const caller = {
  sessionId: "s1",
  configRevision: "cfg-0",
  profileRevision: "p1",
  policyRevision: "policy1",
  resolveReference: () => true,
};
const context = {
  ...caller,
  scopeId: "w1",
  lastDurableSeq: 0,
  maxInlineBytes: 65536,
};
const metadata = (recordId: string, scopeId = "w1") => ({
  schemaVersion: 1,
  recordId,
  createdAt: "2026-10-27T00:00:00.000Z",
  scopeId,
  sourceIds: [],
});
const connection = (recordId: string, revision = "c1", scopeId = "w1") => ({
  ...metadata(recordId, scopeId),
  providerConnectionId: "conn1",
  revision,
  apiFamily: "openai-completions",
  apiVersion: "v1",
  endpointRef: "endpoint1",
  credentialRef: "credential1",
  adapterRevision: "adapter1",
  accountScopeRef: "account1",
  locality: "hosted",
});
const profile = (recordId: string, profileRevision = "p1", scopeId = "w1") => ({
  ...metadata(recordId, scopeId),
  profileId: "profile1",
  profileRevision,
  configRevision: "cfg-0",
  roleBindingRefs: [],
  installedModuleRefs: [],
  egressPolicyRefs: [],
  limitsArtifactId: "limits1",
});
const binding = {
  role: "chat",
  providerConnectionId: "conn1",
  connectionRevision: "c1",
  modelId: "anthropic/claude-sonnet-4-5",
};
const transition = () => ({
  ...metadata("transition1.applied"),
  transitionId: "transition1",
  expectedConfigRevision: "cfg-0",
  acceptedConfigRevision: "cfg-1",
  intentRef: "intent1",
  changedValuesArtifactId: "changes1",
  state: "applied",
  outcomeRef: null,
});
const guard = (expectedRevision: string | null, kind = "profileSnapshot") => ({
  kind,
  scopeId: "w1",
  entityId: kind === "profileSnapshot" ? "profile1" : "conn1",
  expectedRevision,
});
const code = (expected: string) => (error: unknown) =>
  error instanceof StoreError && error.code === expected;
const invalidContract = (error: unknown) => error instanceof ContractError;
function fixture(t: { after(callback: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "td26-cas-"));
  const path = join(dir, "store.db");
  const a = Store.open(path);
  const b = Store.open(path);
  t.after(() => {
    a.close();
    b.close();
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("td26-cas-"));
    rmSync(target, { recursive: true, force: true });
  });
  return { path, a, b };
}

if (process.argv[2] === "cas-child") {
  const store = Store.open(process.argv[3]!);
  let result;
  try {
    const appended = store.compareAndAppend(
      { kind: "profileSnapshot", record: profile(process.argv[4]!) },
      caller,
      guard(null),
    );
    result = { committed: true, seq: appended.seq, pid: process.pid };
  } catch (error) {
    result = {
      committed: false,
      code: error instanceof StoreError ? error.code : String(error),
      pid: process.pid,
    };
  } finally {
    store.close();
  }
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

test("CAS commits one absent profile and returns the actual durable sequence", (t) => {
  const { a, b } = fixture(t);
  const result = a.compareAndAppend(
    { kind: "profileSnapshot", record: profile("profile-first") },
    caller,
    guard(null),
  );
  assert.equal(result.recordId, "profile-first");
  assert.equal(b.get(result.recordId).seq, result.seq);
  assert.equal(b.list("w1").records.length, 1);
});

test("CAS rejects a competing absent writer on another handle without appending", (t) => {
  const { a, b } = fixture(t);
  a.compareAndAppend(
    { kind: "profileSnapshot", record: profile("profile-winner") },
    caller,
    guard(null),
  );
  const before = b.cursor();
  assert.throws(
    () =>
      b.compareAndAppend(
        { kind: "profileSnapshot", record: profile("profile-loser") },
        caller,
        guard(null),
      ),
    code("ENTITY_STALE_REVISION"),
  );
  assert.equal(a.cursor(), before);
  assert.throws(() => a.get("profile-loser"), code("STORE_NOT_FOUND"));
});

test("CAS checks the latest profile revision and leaves a stale write absent", (t) => {
  const { a, b } = fixture(t);
  a.compareAndAppend(
    { kind: "profileSnapshot", record: profile("profile-v1") },
    caller,
    guard(null),
  );
  b.compareAndAppend(
    { kind: "profileSnapshot", record: profile("profile-v2", "p2") },
    caller,
    guard("p1"),
  );
  const before = a.cursor();
  assert.throws(
    () =>
      a.compareAndAppend(
        { kind: "profileSnapshot", record: profile("profile-stale", "p3") },
        caller,
        guard("p1"),
      ),
    code("ENTITY_STALE_REVISION"),
  );
  assert.equal(a.cursor(), before);
  assert.equal(b.get("profile-v2").record.profileRevision, "p2");
});

test("CAS supports connection revisions without changing effective configuration", (t) => {
  const { a, b } = fixture(t);
  a.compareAndAppend(
    { kind: "providerConnection", record: connection("connection-v1") },
    caller,
    guard(null, "providerConnection"),
  );
  b.compareAndAppend(
    { kind: "providerConnection", record: connection("connection-v2", "c2") },
    caller,
    guard("c1", "providerConnection"),
  );
  assert.equal(a.get("connection-v2").record.revision, "c2");
  assert.equal(a.configRevision("w1"), "cfg-0");
  assert.throws(
    () =>
      a.compareAndAppend(
        {
          kind: "providerConnection",
          record: connection("connection-stale", "c3"),
        },
        caller,
        guard("c1", "providerConnection"),
      ),
    code("ENTITY_STALE_REVISION"),
  );
});

test("CAS refuses an already used revision even after an intervening revision", (t) => {
  const { a } = fixture(t);
  a.compareAndAppend(
    { kind: "profileSnapshot", record: profile("revision-one") },
    caller,
    guard(null),
  );
  a.compareAndAppend(
    { kind: "profileSnapshot", record: profile("revision-two", "p2") },
    caller,
    guard("p1"),
  );
  const before = a.cursor();
  assert.throws(
    () =>
      a.compareAndAppend(
        { kind: "profileSnapshot", record: profile("revision-reused", "p1") },
        caller,
        guard("p2"),
      ),
    code("ENTITY_REVISION_REUSED"),
  );
  assert.equal(a.cursor(), before);
});

test("CAS pins the inserted identity before reference validation", (t) => {
  const { a } = fixture(t);
  const record = profile("changed-during-validation");
  a.compareAndAppend(
    { kind: "profileSnapshot", record },
    {
      ...caller,
      resolveReference: () => {
        record.profileId = "different-profile";
        return true;
      },
    },
    guard(null),
  );
  assert.equal(a.get(record.recordId).record.profileId, "profile1");
});

test("CAS callback cannot replace serialized identity or bypass the next absent comparison", (t) => {
  const { a } = fixture(t);
  const append = (recordId: string) => {
    const record = profile(recordId);
    return a.compareAndAppend(
      { kind: "profileSnapshot", record },
      {
        ...caller,
        resolveReference: () => {
          Object.assign(record, {
            toJSON() {
              return {
                ...record,
                profileId: "profile2",
                profileRevision: "p99",
              };
            },
          });
          return true;
        },
      },
      guard(null),
    );
  };
  append("serialization-first");
  let secondError: unknown;
  try {
    append("serialization-second");
  } catch (error) {
    secondError = error;
  }
  assert.deepEqual(
    a.list("w1").records.map(({ record }) => ({
      recordId: record.recordId,
      profileId: record.profileId,
      profileRevision: record.profileRevision,
    })),
    [
      {
        recordId: "serialization-first",
        profileId: "profile1",
        profileRevision: "p1",
      },
    ],
  );
  assert.ok(code("ENTITY_STALE_REVISION")(secondError));
});

for (const variant of [
  "prototype",
  "accessor",
  "non-enumerable",
  "symbol",
] as const) {
  test(`CAS preserves strict original JSON rejection for ${variant}`, (t) => {
    const { a } = fixture(t);
    const record = profile(`invalid-original-${variant}`);
    let getterCalls = 0;
    if (variant === "prototype")
      Object.setPrototypeOf(record, { custom: true });
    if (variant === "accessor")
      Object.defineProperty(record, "profileId", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "profile1";
        },
      });
    if (variant === "non-enumerable")
      Object.defineProperty(record, "hidden", { value: "hidden" });
    if (variant === "symbol")
      Object.assign(record, { [Symbol("hidden")]: "hidden" });
    assert.throws(() =>
      a.compareAndAppend(
        { kind: "profileSnapshot", record },
        caller,
        guard(null),
      ),
    );
    assert.equal(getterCalls, 0);
    assert.equal(a.cursor(), 0);
  });
}

for (const [name, changed] of [
  ["scope", { scopeId: "w2" }],
  ["kind", { kind: "providerConnection" }],
  ["entity", { entityId: "another-profile" }],
] as const) {
  test(`CAS rejects a mismatched ${name} guard before any write`, (t) => {
    const { a } = fixture(t);
    assert.throws(
      () =>
        a.compareAndAppend(
          { kind: "profileSnapshot", record: profile("wrong-guard") },
          caller,
          { ...guard(null), ...changed },
        ),
      code("ENTITY_GUARD_MISMATCH"),
    );
    assert.equal(a.cursor(), 0);
  });
}

test("CAS refuses malformed expected or incoming revisions", (t) => {
  const { a } = fixture(t);
  for (const revision of ["", "p 1", "p/1"]) {
    assert.throws(() =>
      a.compareAndAppend(
        {
          kind: "profileSnapshot",
          record: profile(`invalid-${a.cursor()}`, revision),
        },
        caller,
        guard(null),
      ),
    );
    assert.throws(() =>
      a.compareAndAppend(
        {
          kind: "profileSnapshot",
          record: profile(`invalid-expected-${a.cursor()}`),
        },
        caller,
        guard(revision),
      ),
    );
    assert.equal(a.cursor(), 0);
  }
});

test("CAS is isolated by scope and entity identity", (t) => {
  const { a } = fixture(t);
  a.compareAndAppend(
    { kind: "profileSnapshot", record: profile("other-scope", "p1", "w2") },
    caller,
    { ...guard(null), scopeId: "w2" },
  );
  a.compareAndAppend(
    {
      kind: "profileSnapshot",
      record: { ...profile("other-profile"), profileId: "profile2" },
    },
    caller,
    { ...guard(null), entityId: "profile2" },
  );
  a.compareAndAppend(
    { kind: "profileSnapshot", record: profile("selected-profile") },
    caller,
    guard(null),
  );
  assert.equal(a.list("w1").records.length, 2);
  assert.equal(a.list("w2").records.length, 1);
});

test("CAS fails closed when a future-schema row makes the entity revision unknowable", (t) => {
  const { a, path } = fixture(t);
  a.append(
    { kind: "profileSnapshot", record: profile("future-profile") },
    caller,
  );
  // Deliberate future-writer fixture, confined to this test's new database.
  const future = new DatabaseSync(path);
  future
    .prepare("UPDATE records SET schema_version = 2 WHERE record_id = ?")
    .run("future-profile");
  future.close();
  const before = a.cursor();
  assert.throws(
    () =>
      a.compareAndAppend(
        { kind: "profileSnapshot", record: profile("after-future", "p2") },
        caller,
        guard("p1"),
      ),
    code("UNKNOWN_SCHEMA"),
  );
  assert.equal(a.cursor(), before);
});

test("CAS serializes two actual processes that both expect the entity absent", async (t) => {
  const { a, path } = fixture(t);
  const run = (id: string) =>
    new Promise<{ committed: boolean; code?: string; pid: number }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), "cas-child", path, id],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => {
          stdout += String(data);
        });
        child.stderr.on("data", (data) => {
          stderr += String(data);
        });
        child.on("error", reject);
        child.on("close", (exit) => {
          if (exit !== 0)
            return reject(new Error(`child exit ${exit}: ${stderr}`));
          try {
            resolve(JSON.parse(stdout));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
  const results = await Promise.all([run("process-a"), run("process-b")]);
  assert.notEqual(results[0]!.pid, results[1]!.pid);
  assert.equal(results.filter((result) => result.committed).length, 1);
  assert.equal(
    results.filter((result) => result.code === "ENTITY_STALE_REVISION").length,
    1,
  );
  assert.equal(a.list("w1").records.length, 1);
});

test("old profile and configuration records remain valid without additive fields", () => {
  assert.equal(
    validateRecord("profileSnapshot", profile("old-profile"), context)
      .profileId,
    "profile1",
  );
  assert.equal(
    validateRecord("configurationTransition", transition(), context)
      .acceptedConfigRevision,
    "cfg-1",
  );
});

test("profile bindings accept exact role/connection revision triples", () => {
  const record = {
    ...profile("bound-profile"),
    bindings: [binding],
    unrelatedMetadata: "preserved",
  };
  assert.equal(
    validateRecord("profileSnapshot", record, context).bindings?.[0]?.role,
    "chat",
  );
  assert.equal(
    validateRecord("profileSnapshot", record, context).unrelatedMetadata,
    "preserved",
  );
  assert.equal(
    validateRecord("profileSnapshot", record, context).bindings?.[0]?.modelId,
    "anthropic/claude-sonnet-4-5",
  );
});

test("profile bindings accept a historical triple without a model", () => {
  const legacy = {
    role: binding.role,
    providerConnectionId: binding.providerConnectionId,
    connectionRevision: binding.connectionRevision,
  };
  const value = validateRecord(
    "profileSnapshot",
    { ...profile("legacy-profile"), bindings: [legacy] },
    context,
  );
  assert.equal(value.bindings?.[0]?.modelId, undefined);
});

for (const [name, bindings] of [
  ["not an array", {}],
  ["missing chat", [{ ...binding, role: "embedding" }]],
  ["duplicate role", [binding, binding]],
  ["unknown nested field", [{ ...binding, unexpected: "value" }]],
  ["malformed role", [{ ...binding, role: "chat role" }]],
  ["malformed connection", [{ ...binding, providerConnectionId: "a/b" }]],
  ["malformed revision", [{ ...binding, connectionRevision: "c 1" }]],
  ["missing revision", [{ role: "chat", providerConnectionId: "conn1" }]],
  ["malformed model", [{ ...binding, modelId: "a b" }]],
  ["control character model", [{ ...binding, modelId: "a\u0000b" }]],
  ["C1 control character model", [{ ...binding, modelId: "a\u0080b" }]],
  ["C1 next-line model", [{ ...binding, modelId: "a\u0085b" }]],
  [
    "C1 application-program-command model",
    [{ ...binding, modelId: "a\u009fb" }],
  ],
  ["overlong model", [{ ...binding, modelId: "x".repeat(257) }]],
] as const) {
  test(`profile bindings reject ${name}`, () => {
    assert.throws(
      () =>
        validateRecord(
          "profileSnapshot",
          { ...profile("bad-profile"), bindings },
          context,
        ),
      invalidContract,
    );
  });
}

test("configuration selection accepts a paired opaque profile identity", () => {
  const record = {
    ...transition(),
    profileId: "profile1",
    profileRevision: "p1",
  };
  assert.equal(
    validateRecord("configurationTransition", record, context).profileId,
    "profile1",
  );
});

for (const [name, fields] of [
  ["missing revision", { profileId: "profile1" }],
  ["missing id", { profileRevision: "p1" }],
  ["invalid id", { profileId: "profile 1", profileRevision: "p1" }],
  ["invalid revision", { profileId: "profile1", profileRevision: "p/1" }],
] as const) {
  test(`configuration selection rejects ${name}`, () => {
    assert.throws(
      () =>
        validateRecord(
          "configurationTransition",
          { ...transition(), ...fields },
          context,
        ),
      invalidContract,
    );
  });
}
