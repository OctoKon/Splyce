// #137 / TD-25: actual SQLite durability and negative recovery-applier cases.
// These fixtures do not qualify native Restart wiring or the installed desktop application.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyRecovery } from "@splyce/pi/recovery-applier";
import { admissionOpen } from "@splyce/pi/recovery";
import { Store } from "../packages/splyce-pi/dist/store.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("./fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const tempRoot = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
const childScript = fileURLToPath(
  new URL("./fixtures/recovery-applier-child.mjs", import.meta.url),
);
const scopeId = "w-demo";
const targetSession = "s1";

function nativeCaller(store, sessionId = targetSession, scope = scopeId) {
  return {
    sessionId,
    configRevision: "cfg-0",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference(id, requestedScope) {
      if (requestedScope !== scope) return false;
      // Session, branch, profile and capability are native fixture bindings;
      // operational references must resolve through the actual scoped journal.
      if ([sessionId, scope, "b1", "p1", "cap1"].includes(id)) return true;
      try {
        return store.get(id).record.scopeId === scope;
      } catch {
        return store
          .list(scope, 0, sessionId)
          .records.some(
            ({ kind, record }) =>
              (kind === "run" && record.runId === id) ||
              (kind === "action" && record.actionId === id),
          );
      }
    },
  };
}

function row(kind, recordId, overrides = {}) {
  return {
    ...structuredClone(fixtures[kind]),
    recordId,
    scopeId,
    ...overrides,
  };
}

function seed(store, options = {}) {
  const scope = options.scopeId ?? scopeId;
  const sessionId = options.sessionId ?? targetSession;
  const prefix = options.prefix ?? "source-";
  const refPrefix = options.refPrefix ?? "";
  const caller = nativeCaller(store, sessionId, scope);
  for (const id of [
    "e1",
    "snapshot1",
    "args1",
    "grant1",
    "binding1",
    "result1",
  ]) {
    const recordId = refPrefix + id;
    try {
      store.get(recordId);
    } catch {
      store.append(
        {
          kind: "artifact",
          record: row("artifact", recordId, {
            scopeId: scope,
            sourceIds: [],
            artifactId: recordId,
          }),
        },
        caller,
      );
    }
  }
  const run = row("run", `${prefix}run`, {
    scopeId: scope,
    sourceIds: [refPrefix + "e1"],
    runId: options.runId ?? "r1",
    piSessionId: sessionId,
    workspaceId: scope,
    baseSnapshotId: refPrefix + "snapshot1",
    taskArtifactId: refPrefix + "e1",
    grantIds: [refPrefix + "grant1"],
    roleBindingRefs: [refPrefix + "binding1"],
    state: options.runState ?? "running",
  });
  const action = row("action", `${prefix}action`, {
    scopeId: scope,
    sourceIds: [refPrefix + "e1"],
    runId: run.runId,
    actionId: options.actionId ?? "a1",
    argumentsArtifactId: refPrefix + "args1",
    targetScopeId: scope,
    idempotencyKey: `${prefix}key`,
    state: options.actionState ?? "running",
  });
  store.append({ kind: "run", record: run }, caller);
  store.append({ kind: "action", record: action }, caller);
  let outcome;
  if (options.effectState) {
    outcome = row("outcome", `${prefix}outcome`, {
      scopeId: scope,
      sourceIds: [action.recordId],
      actionId: action.actionId,
      resultArtifactId: refPrefix + "result1",
      effectState: options.effectState,
    });
    store.append({ kind: "outcome", record: outcome }, caller);
  }
  return { run, action, outcome, caller };
}

function fixture(t, { seeded = true } = {}) {
  mkdirSync(tempRoot, { recursive: true });
  const dir = mkdtempSync(join(tempRoot, "td25-applier-"));
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const handles = new Set([store]);
  t.after(() => {
    for (const handle of handles) handle.close();
    const actualRoot = realpathSync(tempRoot);
    const actualDir = realpathSync(dir);
    assert.ok(
      actualDir.startsWith(actualRoot + sep),
      "cleanup stays in owned fixtures",
    );
    rmSync(actualDir, { recursive: true, force: true });
  });
  const original = seeded ? seed(store) : undefined;
  return {
    dir,
    path,
    store,
    original,
    caller: nativeCaller(store),
    open(options) {
      const handle = Store.open(path, options);
      handles.add(handle);
      return handle;
    },
  };
}

function input(f, overrides = {}) {
  return {
    scopeId,
    caller: f.caller,
    explicitRestart: true,
    writers: [
      {
        lease: {
          piSessionId: targetSession,
          writerId: "writer1",
          leaseEpoch: "epoch1",
        },
        alive: false,
      },
    ],
    ...overrides,
  };
}

function latest(store, kind, id, session = targetSession, scope = scopeId) {
  const key = kind === "run" ? "runId" : "actionId";
  return store
    .list(scope, 0, session)
    .records.filter((item) => item.kind === kind && item.record[key] === id)
    .at(-1)?.record;
}

function changedRows(store, originalIds, session = targetSession) {
  return store
    .list(scopeId, 0, session)
    .records.filter(
      (item) =>
        ["action", "run"].includes(item.kind) &&
        !originalIds.has(item.record.recordId),
    );
}

function originalIds(store) {
  return new Set(
    store.list(scopeId).records.map((item) => item.record.recordId),
  );
}

function unchangedFields(record) {
  const { recordId, createdAt, sourceIds, state, ...rest } = record;
  return rest;
}

test("#137: corrections commit as new versions with immutable identity and source lineage", (t) => {
  const f = fixture(t);
  const old = f.original;
  const ids = originalIds(f.store);
  const cursor = f.store.cursor();
  const result = applyRecovery(f.store, input(f));
  assert.deepEqual(result.applied.actionIds, ["a1"]);
  assert.deepEqual(result.applied.runIds, ["r1"]);
  assert.equal(
    admissionOpen(result.report, { actionIds: [], runIds: [] }),
    false,
  );
  assert.equal(
    admissionOpen(result.report, { ...result.applied, actionIds: [] }),
    false,
  );
  assert.equal(
    admissionOpen(result.report, { ...result.applied, runIds: [] }),
    false,
  );
  assert.equal(admissionOpen(result.report, result.applied), true);
  assert.ok(
    result.report.takeoverBlocked.some(
      ({ piSessionId }) => piSessionId === targetSession,
    ),
    "committed corrections do not clear uncertain workspace effects",
  );
  assert.deepEqual(result.report.redispatch, []);
  assert.equal(result.report.admissionOpen, false);
  assert.deepEqual(result.report.uncertain, ["a1"]);
  const changed = changedRows(f.store, ids);
  assert.equal(changed.length, 2);
  assert.deepEqual(
    result.seqs,
    changed.map((item) => item.seq),
  );
  assert.ok(result.seqs.every((seq) => seq > cursor));
  for (const [kind, original] of [
    ["run", old.run],
    ["action", old.action],
  ]) {
    const updated = latest(f.store, kind, kind === "run" ? "r1" : "a1");
    assert.equal(updated.state, "uncertain");
    assert.notEqual(updated.recordId, original.recordId);
    assert.deepEqual(unchangedFields(updated), unchangedFields(original));
    assert.ok(updated.sourceIds.includes(original.recordId));
    for (const sourceId of original.sourceIds)
      assert.ok(updated.sourceIds.includes(sourceId));
    assert.deepEqual(f.store.get(original.recordId).record, original);
  }
  f.store.close();
  const reopened = f.open();
  assert.equal(latest(reopened, "action", "a1").state, "uncertain");
  assert.equal(latest(reopened, "run", "r1").state, "uncertain");
  assert.ok(result.seqs.every((seq) => seq <= reopened.cursor()));
});

test("#137: latest durable outcome by seq settles the action and supplies its source proof", (t) => {
  const f = fixture(t);
  const first = row("outcome", "earlier-failure", {
    sourceIds: [f.original.action.recordId],
    effectState: "observed-failure",
    errorClass: "execution",
  });
  const later = row("outcome", "latest-success", {
    sourceIds: [f.original.action.recordId],
    effectState: "observed-success",
    observedAt: "2026-10-25T00:00:00.000Z",
  });
  f.store.append({ kind: "outcome", record: first }, f.caller);
  f.store.append({ kind: "outcome", record: later }, f.caller);
  const result = applyRecovery(f.store, input(f));
  assert.ok(result.applied.actionIds.includes("a1"));
  const corrected = latest(f.store, "action", "a1");
  assert.equal(corrected.state, "completed");
  assert.ok(corrected.sourceIds.includes(later.recordId));
  assert.deepEqual(result.report.uncertain, []);
});

test("#137: another session and scope remain unchanged even with matching logical ids", (t) => {
  const f = fixture(t);
  seed(f.store, { sessionId: "other-session", prefix: "other-" });
  seed(f.store, {
    scopeId: "other-scope",
    sessionId: "other-session",
    prefix: "foreign-",
    refPrefix: "foreign-",
  });
  const otherSession = f.store.list(scopeId, 0, "other-session");
  const otherScope = f.store.list("other-scope");
  const ids = originalIds(f.store);
  applyRecovery(f.store, input(f));
  assert.deepEqual(f.store.list(scopeId, 0, "other-session"), otherSession);
  assert.deepEqual(f.store.list("other-scope"), otherScope);
  assert.equal(changedRows(f.store, ids).length, 2);
});

test("#137: inconsistent persisted session attribution cannot look like empty recovery", (t) => {
  const f = fixture(t);
  f.store.append(
    {
      kind: "run",
      record: {
        ...f.original.run,
        recordId: "misattributed-run",
        state: "running",
      },
    },
    { ...f.caller, sessionId: "wrong-writer-session" },
  );
  const before = f.store.list(scopeId);
  assert.throws(
    () => applyRecovery(f.store, input(f)),
    (error) => error.code === "RECOVERY_SCOPE",
  );
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#137: no explicit Restart means no journal correction", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  assert.throws(
    () => applyRecovery(f.store, input(f, { explicitRestart: false })),
    (error) => error.code === "RECOVERY_RESTART_REQUIRED",
  );
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#137: stale configuration cannot acknowledge even an empty recovery", (t) => {
  const f = fixture(t, { seeded: false });
  assert.throws(
    () =>
      applyRecovery(
        f.store,
        input(f, {
          writers: [],
          caller: { ...f.caller, configRevision: "stale-config" },
        }),
      ),
    (error) => error.code === "RECOVERY_SCOPE",
  );
  assert.equal(f.store.cursor(), 0);
});

test("#137: recovery preserves the stored profile rather than rebinding it", (t) => {
  const f = fixture(t);
  const result = applyRecovery(
    f.store,
    input(f, {
      caller: { ...f.caller, profileRevision: "another-profile" },
    }),
  );
  assert.deepEqual(result.applied.runIds, ["r1"]);
  const recovered = latest(f.store, "run", "r1");
  assert.equal(recovered.profileRevision, f.original.run.profileRevision);
  assert.equal(recovered.profileId, f.original.run.profileId);
  assert.deepEqual(recovered.grantIds, f.original.run.grantIds);
  assert.equal(recovered.state, "uncertain");
});

test("#137: current authority must still allow the historical profile reference", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  const resolve = f.caller.resolveReference;
  let checkedHistoricalProfile = false;
  const caller = {
    ...f.caller,
    profileRevision: "another-profile",
    resolveReference(id, requestedScope) {
      if (id === f.original.run.profileId) checkedHistoricalProfile = true;
      return id !== f.original.run.profileId && resolve(id, requestedScope);
    },
  };
  assert.throws(() => applyRecovery(f.store, input(f, { caller })));
  assert.equal(checkedHistoricalProfile, true);
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#137: never-started approved work is durably canceled and never reapplied", (t) => {
  const f = fixture(t, { seeded: false });
  seed(f.store, { actionState: "approved" });
  const result = applyRecovery(f.store, input(f));
  assert.deepEqual(result.applied.actionIds, ["a1"]);
  assert.equal(latest(f.store, "action", "a1").state, "canceled");
  assert.equal(latest(f.store, "run", "r1").state, "failed");
  f.store.close();
  const reopened = f.open();
  const durable = reopened.list(scopeId);
  const repeat = applyRecovery(
    reopened,
    input(f, { caller: nativeCaller(reopened) }),
  );
  assert.deepEqual(repeat.seqs, []);
  assert.deepEqual(reopened.list(scopeId), durable);
});

test("#137: a revision committed between precheck and snapshot rejects the stale caller", (t) => {
  const f = fixture(t, { seeded: false });
  const original = seed(f.store, {
    runState: "completed",
    actionState: "completed",
    effectState: "observed-success",
  });
  const writer = f.open();
  const ids = originalIds(f.store);
  const request = input(f);
  let advanced = false;
  // A second real connection commits at the precheck/snapshot boundary.
  Object.defineProperty(request.writers[0].lease, "writerId", {
    get() {
      if (!advanced) {
        advanced = true;
        writer.appendBatch(
          [
            {
              kind: "configurationTransition",
              record: row("configurationTransition", "cfg-between-read", {
                expectedConfigRevision: "cfg-0",
                acceptedConfigRevision: "cfg-1",
                state: "applied",
                intentRef: original.action.recordId,
                changedValuesArtifactId: "e1",
                outcomeRef: original.outcome.recordId,
              }),
            },
          ],
          nativeCaller(writer),
          undefined,
          undefined,
          { scopeId, revision: "cfg-0" },
        );
      }
      return "writer1";
    },
  });
  assert.throws(() => applyRecovery(f.store, request));
  assert.equal(advanced, true);
  assert.equal(f.store.configRevision(scopeId), "cfg-1");
  assert.deepEqual(changedRows(f.store, ids), []);
  assert.equal(f.store.db.isTransaction, false);
});

test("#137: native denial of a body reference is checked before the write transaction", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  const resolve = f.caller.resolveReference;
  const requested = [];
  const caller = {
    ...f.caller,
    resolveReference(id, requestedScope) {
      requested.push(id);
      assert.equal(f.store.db.isTransaction, false);
      return id !== "args1" && resolve(id, requestedScope);
    },
  };
  assert.throws(
    () => applyRecovery(f.store, input(f, { caller })),
    (error) => error.code === "RECOVERY_REFERENCE_DENIED",
  );
  assert.ok(requested.includes("args1"));
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#137: a caller-owned transaction is rejected without rollback or loss of its writes", (t) => {
  const f = fixture(t);
  const ids = originalIds(f.store);
  let referenceCalls = 0;
  const caller = {
    ...f.caller,
    resolveReference(id, requestedScope) {
      referenceCalls++;
      return f.caller.resolveReference(id, requestedScope);
    },
  };
  f.store.db.exec("BEGIN IMMEDIATE;");
  try {
    f.store.append(
      {
        kind: "artifact",
        record: row("artifact", "outer-transaction", { sourceIds: [] }),
      },
      f.caller,
    );
    assert.throws(() => applyRecovery(f.store, input(f, { caller })));
    assert.equal(referenceCalls, 0);
    assert.equal(f.store.db.isTransaction, true);
    assert.equal(
      f.store.get("outer-transaction").record.recordId,
      "outer-transaction",
    );
    assert.deepEqual(changedRows(f.store, ids), []);
  } finally {
    f.store.db.exec("ROLLBACK;");
  }
  assert.throws(() => f.store.get("outer-transaction"));
});

test("#137: read-only and closed stores reject even an empty correction plan", (t) => {
  const f = fixture(t, { seeded: false });
  f.store.close();
  const readOnly = f.open({ readOnly: true });
  assert.throws(
    () =>
      applyRecovery(
        readOnly,
        input(f, { caller: nativeCaller(readOnly), writers: [] }),
      ),
    (error) => error.code === "STORE_READ_ONLY",
  );
  assert.throws(() => applyRecovery(f.store, input(f, { writers: [] })));
  assert.equal(f.open().cursor(), 0);
});

test("#137: unknown schema cannot become a silently partial reconciliation", (t) => {
  const f = fixture(t);
  const ids = originalIds(f.store);
  f.store.db
    .prepare("UPDATE records SET schema_version = 999 WHERE record_id = ?")
    .run(f.original.action.recordId);
  const cursor = f.store.cursor();
  assert.throws(
    () => applyRecovery(f.store, input(f)),
    (error) => error.code === "RECOVERY_UNKNOWN_SCHEMA",
  );
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(changedRows(f.store, ids), []);
  assert.equal(f.store.list(scopeId).skippedUnknownSchema, 1);
});

test("#137: native reference denial is preserved without any acknowledged correction", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  const calls = [];
  let acknowledgement;
  assert.throws(() => {
    acknowledgement = applyRecovery(
      f.store,
      input(f, {
        caller: {
          ...f.caller,
          resolveReference: () => {
            calls.push(f.store.db.isTransaction);
            return false;
          },
        },
      }),
    );
  });
  assert.equal(acknowledgement, undefined);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((inTransaction) => inTransaction === false));
  assert.deepEqual(f.store.list(scopeId), before);
});

for (const [name, mutate] of [
  [
    "a newer durable record",
    (f) =>
      f.store.append(
        {
          kind: "artifact",
          record: row("artifact", "newer-record", { sourceIds: [] }),
        },
        f.caller,
      ),
  ],
  ["a deletion epoch change", (f) => f.store.noteDeletion("e1")],
  [
    "a workspace owner change",
    (f) => f.store.acquireWorkspace(scopeId, targetSession),
  ],
]) {
  test(`#137: authorizer mutation (${name}) invalidates the snapshot before corrections`, (t) => {
    const f = fixture(t);
    const ids = originalIds(f.store);
    const originalResolve = f.caller.resolveReference;
    let mutated = false;
    const caller = {
      ...f.caller,
      resolveReference(id, requestedScope) {
        if (!mutated) {
          mutated = true;
          mutate(f);
        }
        return originalResolve(id, requestedScope);
      },
    };
    const expectedCode =
      name === "a deletion epoch change"
        ? "RECOVERY_DELETED_SOURCE"
        : "RECOVERY_STALE_SNAPSHOT";
    assert.throws(
      () => applyRecovery(f.store, input(f, { caller })),
      (error) => error.code === expectedCode,
    );
    assert.equal(mutated, true);
    assert.deepEqual(changedRows(f.store, ids), []);
    assert.equal(latest(f.store, "action", "a1").state, "running");
    assert.equal(latest(f.store, "run", "r1").state, "running");
    assert.equal(f.store.db.isTransaction, false);
  });
}

test("#137: the native authorizer never executes inside the applier write transaction", (t) => {
  const f = fixture(t);
  const originalResolve = f.caller.resolveReference;
  const transactionStates = [];
  const caller = {
    ...f.caller,
    resolveReference(id, requestedScope) {
      transactionStates.push(f.store.db.isTransaction);
      if (f.store.db.isTransaction) {
        // A nested batch rolls back its caller's transaction on failure. The
        // authorizer must never be able to reach that unsafe insertion phase.
        try {
          f.store.appendBatch(
            [
              {
                kind: "artifact",
                record: row("artifact", "resolver-reentry", { sourceIds: [] }),
              },
            ],
            f.caller,
          );
        } catch {}
      }
      return originalResolve(id, requestedScope);
    },
  };
  const result = applyRecovery(f.store, input(f, { caller }));
  assert.ok(transactionStates.length > 0);
  assert.ok(
    transactionStates.every((inTransaction) => inTransaction === false),
  );
  assert.deepEqual(result.applied.actionIds, ["a1"]);
  assert.equal(latest(f.store, "action", "a1").state, "uncertain");
  assert.equal(latest(f.store, "run", "r1").state, "uncertain");
  assert.throws(() => f.store.get("resolver-reentry"));
});

test("#137: native inputs remain bound to the original target when an authorizer mutates its caller object", (t) => {
  const f = fixture(t);
  const originalResolve = f.caller.resolveReference;
  const request = input(f);
  let mutated = false;
  request.caller = {
    ...f.caller,
    resolveReference(id, requestedScope) {
      if (!mutated) {
        mutated = true;
        request.scopeId = "mutated-scope";
        request.caller.sessionId = "mutated-session";
        request.caller.profileRevision = "mutated-profile";
        request.caller.resolveReference = () => false;
        request.writers[0].lease.piSessionId = "mutated-session";
        request.writers[0].alive = "unknown";
      }
      return originalResolve(id, requestedScope);
    },
  };
  const result = applyRecovery(f.store, request);
  assert.equal(mutated, true);
  assert.deepEqual(result.applied.actionIds, ["a1"]);
  assert.equal(latest(f.store, "action", "a1").state, "uncertain");
  assert.equal(latest(f.store, "run", "r1").state, "uncertain");
  assert.deepEqual(f.store.list(scopeId, 0, "mutated-session").records, []);
  assert.deepEqual(f.store.list("mutated-scope").records, []);
});

test("#137: a real SQL failure after the first correction rolls the entire batch back", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  const count = before.records.length;
  f.store.db.exec(
    `CREATE TRIGGER fail_recovery_insert BEFORE INSERT ON records WHEN (SELECT COUNT(*) FROM records) >= ${count + 1} BEGIN SELECT RAISE(ABORT, 'fixture write failure after first correction'); END;`,
  );
  let acknowledgement;
  assert.throws(() => {
    acknowledgement = applyRecovery(f.store, input(f));
  }, /fixture write failure after first correction/);
  assert.equal(acknowledgement, undefined);
  assert.equal(f.store.db.isTransaction, false);
  assert.deepEqual(f.store.list(scopeId), before);
  f.store.db.exec("DROP TRIGGER fail_recovery_insert;");
  f.store.append(
    {
      kind: "artifact",
      record: row("artifact", "after-failure", { sourceIds: [] }),
    },
    f.caller,
  );
  f.store.close();
  const reopened = f.open();
  assert.equal(latest(reopened, "action", "a1").state, "running");
  assert.equal(latest(reopened, "run", "r1").state, "running");
  assert.equal(reopened.get("after-failure").record.recordId, "after-failure");
});

test("#137: a lost acknowledgement after COMMIT is idempotent after reopen", (t) => {
  const f = fixture(t);
  const exec = f.store.db.exec.bind(f.store.db);
  let committed = false;
  let acknowledgement;
  f.store.db.exec = (sql) => {
    const result = exec(sql);
    if (/^\s*COMMIT\b/i.test(sql) && !committed) {
      committed = true;
      throw new Error("fixture acknowledgement lost after commit");
    }
    return result;
  };
  try {
    assert.throws(() => {
      acknowledgement = applyRecovery(f.store, input(f));
    });
  } finally {
    f.store.db.exec = exec;
  }
  assert.equal(committed, true);
  assert.equal(acknowledgement, undefined);
  f.store.close();
  const reopened = f.open();
  const durable = reopened.list(scopeId);
  assert.equal(latest(reopened, "action", "a1").state, "uncertain");
  const result = applyRecovery(
    reopened,
    input(f, { caller: nativeCaller(reopened) }),
  );
  assert.deepEqual(result.seqs, []);
  assert.deepEqual(result.applied, { actionIds: [], runIds: [] });
  assert.deepEqual(reopened.list(scopeId), durable);
});

test("#137: rollback failure preserves both errors and discards the unusable Store", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  const count = before.records.length;
  f.store.db.exec(
    `CREATE TRIGGER fail_recovery_insert BEFORE INSERT ON records WHEN (SELECT COUNT(*) FROM records) >= ${count + 1} BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;`,
  );
  const exec = f.store.db.exec.bind(f.store.db);
  f.store.db.exec = (sql) => {
    if (/^\s*ROLLBACK\b/i.test(sql))
      throw new Error("fixture rollback failure");
    return exec(sql);
  };
  assert.throws(
    () => applyRecovery(f.store, input(f)),
    (error) =>
      error.code === "RECOVERY_ROLLBACK_FAILED" &&
      /fixture write failure/.test(String(error.cause)) &&
      /fixture rollback failure/.test(String(error.cause)),
  );
  assert.equal(f.store.closed, true);
  assert.deepEqual(f.open().list(scopeId), before);
});

// #154 TD-25 recovery corrections, lead review blockers (P1-1, P1-2, P2-4).

test("#154 P1-1: a deleted journal source fails recovery closed", (t) => {
  const f = fixture(t);
  f.store.noteDeletion(f.original.action.recordId);
  const before = f.store.list(scopeId);
  const cursor = f.store.cursor();
  assert.throws(
    () => applyRecovery(f.store, input(f)),
    (error) => error.code === "RECOVERY_DELETED_SOURCE",
  );
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#154 P1-1: a deleted referenced source is rejected by reference authorization", (t) => {
  const f = fixture(t);
  f.store.noteDeletion("e1"); // cited by the run and action sourceIds
  const before = f.store.list(scopeId);
  const cursor = f.store.cursor();
  assert.throws(
    () => applyRecovery(f.store, input(f)),
    (error) => error.code === "RECOVERY_DELETED_SOURCE",
  );
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#154 P1-2: corrections never commit while a writer witness is alive", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  const cursor = f.store.cursor();
  assert.throws(
    () =>
      applyRecovery(
        f.store,
        input(f, {
          writers: [
            {
              lease: {
                piSessionId: targetSession,
                writerId: "writer1",
                leaseEpoch: "epoch1",
              },
              alive: true,
            },
          ],
        }),
      ),
    (error) => error.code === "RECOVERY_WRITER_ALIVE",
  );
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#154 P1-2: an unknown writer witness blocks corrections", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  const cursor = f.store.cursor();
  assert.throws(
    () =>
      applyRecovery(
        f.store,
        input(f, {
          writers: [
            {
              lease: {
                piSessionId: targetSession,
                writerId: "writer1",
                leaseEpoch: "epoch1",
              },
              alive: "unknown",
            },
          ],
        }),
      ),
    (error) => error.code === "RECOVERY_WRITER_ALIVE",
  );
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#154 P1-2: recovery with no writer witness fails closed", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  const cursor = f.store.cursor();
  assert.throws(
    () => applyRecovery(f.store, input(f, { writers: [] })),
    (error) => error.code === "RECOVERY_WRITER_ALIVE",
  );
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#154 P2-4: a writer lease bound to another session is rejected", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  const cursor = f.store.cursor();
  assert.throws(
    () =>
      applyRecovery(
        f.store,
        input(f, {
          writers: [
            {
              lease: {
                piSessionId: "other-session",
                writerId: "writer1",
                leaseEpoch: "epoch1",
              },
              alive: false,
            },
          ],
        }),
      ),
    (error) => error.code === "RECOVERY_SCOPE",
  );
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#154 P2-4: a malformed writer lease is rejected", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  assert.throws(
    () =>
      applyRecovery(
        f.store,
        input(f, {
          writers: [
            {
              lease: {
                piSessionId: targetSession,
                writerId: "",
                leaseEpoch: "epoch1",
              },
              alive: false,
            },
          ],
        }),
      ),
    (error) => error.code === "RECOVERY_SCOPE",
  );
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#154 P2-4: a non-witness liveness value is rejected", (t) => {
  const f = fixture(t);
  const before = f.store.list(scopeId);
  assert.throws(
    () =>
      applyRecovery(
        f.store,
        input(f, {
          writers: [
            {
              lease: {
                piSessionId: targetSession,
                writerId: "writer1",
                leaseEpoch: "epoch1",
              },
              alive: "yes",
            },
          ],
        }),
      ),
    (error) => error.code === "RECOVERY_SCOPE",
  );
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#157 P1-A: a newer durable outcome committed inside the snapshot window fails the fence closed", (t) => {
  const f = fixture(t);
  const ids = originalIds(f.store);
  const writer = f.open();
  const writerCaller = nativeCaller(writer);
  const originalPrepare = f.store.db.prepare.bind(f.store.db);
  let fired = false;
  f.store.db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    // The tombstone scan is the first applier step AFTER snapshot() ends: a
    // real competitor commits a newer observed-failure outcome exactly there.
    // (The epoch counter's own history probe also reads FROM deletions, so
    // match the scan statement - firing inside the stamp window would only
    // test the stamp, not the fence.)
    if (!fired && /FROM deletions WHERE/.test(String(sql))) {
      fired = true;
      writer.append(
        {
          kind: "outcome",
          record: row("outcome", "newer-failure", {
            sourceIds: [f.original.action.recordId],
            actionId: f.original.action.actionId,
            resultArtifactId: "result1",
            effectState: "observed-failure",
            errorClass: "execution",
          }),
        },
        writerCaller,
      );
    }
    return statement;
  };
  try {
    assert.throws(
      () => applyRecovery(f.store, input(f)),
      (error) => error.code === "RECOVERY_STALE_SNAPSHOT",
    );
  } finally {
    f.store.db.prepare = originalPrepare;
  }
  assert.equal(fired, true);
  assert.deepEqual(changedRows(f.store, ids), []);
  assert.equal(latest(f.store, "action", "a1").state, "running");
});

test("#157 P1-B: another workspace's ownership never blocks the target's recovery", (t) => {
  const f = fixture(t);
  // A different workspace acquires (bumping the store-global ownership
  // counter); the target run's workspace row has its own epoch.
  f.store.acquireWorkspace("w-other", "other-session");
  const result = applyRecovery(f.store, input(f));
  assert.deepEqual(result.applied.actionIds, ["a1"]);
  assert.equal(latest(f.store, "action", "a1").state, "uncertain");
});

test("#157 P1-B: a released target workspace still admits recovery at its own epoch", (t) => {
  const f = fixture(t);
  const acquired = f.store.acquireWorkspace(scopeId, targetSession);
  f.store.releaseWorkspace(scopeId, targetSession, acquired.epoch);
  const result = applyRecovery(f.store, input(f));
  assert.deepEqual(result.applied.actionIds, ["a1"]);
  assert.equal(latest(f.store, "action", "a1").state, "uncertain");
});

test("#157 P2-1: an ownership change inside the snapshot window fails the fence closed", (t) => {
  const f = fixture(t);
  const ids = originalIds(f.store);
  const writer = f.open();
  const originalPrepare = f.store.db.prepare.bind(f.store.db);
  let fired = false;
  f.store.db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    // The tombstone scan is the first applier step after the snapshot: a real
    // competitor takes over the target workspace exactly there. An ownership
    // change advances no cursor and no deletion epoch - only the row-epoch
    // fence inside the snapshot window can catch it. (The epoch counter's own
    // history probe also reads FROM deletions, so match the scan statement.)
    if (!fired && /FROM deletions WHERE/.test(String(sql))) {
      fired = true;
      writer.acquireWorkspace(scopeId, "s-intruder");
    }
    return statement;
  };
  try {
    assert.throws(
      () => applyRecovery(f.store, input(f)),
      (error) => error.code === "RECOVERY_STALE_SNAPSHOT",
    );
  } finally {
    f.store.db.prepare = originalPrepare;
  }
  assert.equal(fired, true);
  assert.deepEqual(changedRows(f.store, ids), []);
  assert.equal(latest(f.store, "action", "a1").state, "running");
});

test("#157 P3: a tombstoned superseded outcome fails recovery at the snapshot check", (t) => {
  const f = fixture(t, { seeded: false });
  // a1 stays running (it is what recovery would correct); a2 is completed and
  // its observed-success outcome is cited by no correction - the completed a2
  // needs no correction, so reference authorization never resolves the a2
  // outcome and only the snapshot-level tombstone check can reject recovery.
  seed(f.store, {});
  seed(f.store, {
    prefix: "done-",
    runId: "r2",
    actionId: "a2",
    runState: "completed",
    actionState: "completed",
    effectState: "observed-success",
  });
  f.store.noteDeletion("done-outcome");
  const before = f.store.list(scopeId);
  const cursor = f.store.cursor();
  assert.throws(
    () => applyRecovery(f.store, input(f)),
    (error) => error.code === "RECOVERY_DELETED_SOURCE",
  );
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#157 P3: target runs attributing different workspaces are rejected", (t) => {
  const f = fixture(t);
  // The native authority also binds workspaces: w-other resolves for the
  // seeded run, so only the applier's single-workspace rule can reject it.
  const caller = {
    ...f.caller,
    resolveReference(id, requestedScope) {
      if (id === "w-other") return requestedScope === scopeId;
      return f.caller.resolveReference(id, requestedScope);
    },
  };
  f.store.append(
    {
      kind: "run",
      record: {
        ...f.original.run,
        recordId: "run-other-workspace",
        runId: "r2",
        workspaceId: "w-other",
      },
    },
    caller,
  );
  const before = f.store.list(scopeId);
  assert.throws(
    () => applyRecovery(f.store, input(f)),
    (error) => error.code === "RECOVERY_SCOPE",
  );
  assert.deepEqual(f.store.list(scopeId), before);
});

test("#157 P3: a tombstoned uncited outcome still fails recovery closed", (t) => {
  const f = fixture(t, { seeded: false });
  const seededRow = seed(f.store, {
    effectState: "observed-failure",
    errorClass: "execution",
  });
  f.store.noteDeletion(seededRow.outcome.recordId);
  const before = f.store.list(scopeId);
  const cursor = f.store.cursor();
  assert.throws(
    () => applyRecovery(f.store, input(f)),
    (error) => error.code === "RECOVERY_DELETED_SOURCE",
  );
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.list(scopeId), before);
});

test(
  "#137: killing the applier after its first uncommitted write leaves no partial correction",
  { timeout: 20000 },
  async (t) => {
    const f = fixture(t);
    const before = f.store.list(scopeId);
    const marker = join(f.dir, "mid-transaction.json");
    f.store.close();
    const child = spawn(process.execPath, [childScript, f.path, marker], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "exit");
    try {
      const deadline = Date.now() + 12000;
      while (!existsSync(marker)) {
        if (child.exitCode !== null)
          throw new Error(`fixture child exited before marker: ${stderr}`);
        if (Date.now() >= deadline)
          throw new Error(
            `fixture child did not reach write boundary: ${stderr}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const state = JSON.parse(readFileSync(marker, "utf8"));
      assert.equal(state.phase, "after-first-write", stderr);
      assert.equal(
        state.inTransaction,
        true,
        "first correction must still be uncommitted",
      );
      assert.equal(child.kill("SIGKILL"), true);
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
    const reopened = f.open();
    assert.deepEqual(reopened.list(scopeId), before);
    const result = applyRecovery(
      reopened,
      input(f, { caller: nativeCaller(reopened) }),
    );
    assert.equal(result.seqs.length, 2);
    assert.equal(latest(reopened, "action", "a1").state, "uncertain");
  },
);
