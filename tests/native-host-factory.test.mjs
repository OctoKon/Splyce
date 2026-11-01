import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import test from "node:test";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";
import { ConfigAuthority } from "../packages/splyce-pi/dist/config.js";
import { createProviderProfiles } from "../packages/splyce-pi/dist/provider-profiles.js";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { validateEvent } from "../packages/splyce-pi/dist/contracts.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("./fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const caller = {
  sessionId: "s1",
  configRevision: "cfg-0",
  profileRevision: "cfg-0",
  policyRevision: "cfg-0",
  resolveReference: () => true,
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "splyce-native-host-"));
  const host = createNativeHost(directory);
  const path = join(directory, "splyce", "store.db");
  const writer = Store.open(path);
  t.after(() => {
    host.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, path, host, writer };
}
function append(writer, kind, changes = {}) {
  writer.append({ kind, record: { ...fixtures[kind], ...changes } }, caller);
}
function code(expected) {
  return (error) => {
    assert.equal(error.code, expected);
    return true;
  };
}

test("private native factory opens persistent Store with every runnable port closed", (t) => {
  const { host, directory, writer } = fixture(t);
  assert.deepEqual(host.handshakeReadiness, {
    state: "ready",
    policy: true,
    store: true,
    receipts: true,
    ports: {
      generation: false,
      provider: false,
      workspace: false,
      modules: false,
    },
  });
  assert.deepEqual(host.current("w-demo"), {
    configRevision: "cfg-0",
    profileRevision: "cfg-0",
    policyRevision: "cfg-0",
    grantIds: [],
    planMode: true,
  });
  assert.deepEqual(host.listWorkspaces(), []);
  assert.equal(host.resolveWorkspace("w-demo"), undefined);
  assert.throws(() => host.resolveWorkspace("a/b"), code("NATIVE_INVALID_ID"));
  append(writer, "run");
  assert.deepEqual(host.current("w-demo").grantIds, []);
  assert.deepEqual(readdirSync(join(directory, "splyce", "snapshots")), []);
  host.close();
  const reopened = createNativeHost(toNamespacedPath(directory));
  try {
    assert.equal(writer.cursor(), 1);
    assert.deepEqual(reopened.current("w-demo").grantIds, []);
    assert.deepEqual(reopened.listWorkspaces(), []);
    assert.deepEqual(writer.audit().scopeIds, ["w-demo"]);
  } finally {
    reopened.close();
  }
});

function selectedProfile(writer) {
  const config = new ConfigAuthority(writer);
  const profiles = createProviderProfiles({ store: writer, config });
  const scopeId = "w-demo";
  profiles.writeConnection(
    {
      ...Object.fromEntries(
        Object.entries(fixtures.providerConnection).filter(([key]) =>
          [
            "providerConnectionId",
            "apiFamily",
            "apiVersion",
            "endpointRef",
            "credentialRef",
            "adapterRevision",
            "accountScopeRef",
            "locality",
          ].includes(key),
        ),
      ),
      scopeId,
    },
    caller,
  );
  profiles.writeProfile(
    {
      scopeId,
      profileId: "p1",
      bindings: [
        {
          role: "chat",
          providerConnectionId:
            fixtures.providerConnection.providerConnectionId,
          connectionRevision: "c1",
          modelId: "fixture-model",
        },
      ],
      egressPolicyRefs: [],
      limitsArtifactId: "limits",
      expectedProfileRevision: null,
    },
    caller,
  );
  const selection = {
    scopeId,
    profileId: "p1",
    profileRevision: "p1",
    expectedConfigRevision: "cfg-0",
    acceptedConfigRevision: "cfg-1",
    transitionId: "select1",
    intentRef: "intent",
    changedValuesArtifactId: "changes",
  };
  return { profiles, config, selection };
}

test("current uses the exact applied immutable profile with its selected config across reopen", (t) => {
  const { host, writer, directory } = fixture(t);
  const { profiles, config, selection } = selectedProfile(writer);
  assert.throws(
    () => host.current("w-demo", "p1"),
    code("NATIVE_PROFILE_UNAVAILABLE"),
  );
  config.request(selection, caller);
  assert.equal(host.current("w-demo").configRevision, "cfg-0");
  assert.equal(host.current("w-demo").profileRevision, "cfg-0");
  config.apply(selection, caller);
  const queued = host.current("w-demo", "p1");
  assert.deepEqual(queued, {
    configRevision: "cfg-1",
    profileRevision: "p1",
    policyRevision: "cfg-0",
    grantIds: [],
    planMode: true,
  });
  profiles.writeProfile(
    {
      scopeId: "w-demo",
      profileId: "p1",
      bindings: [
        {
          role: "chat",
          providerConnectionId:
            fixtures.providerConnection.providerConnectionId,
          connectionRevision: "c1",
          modelId: "fixture-model",
        },
      ],
      egressPolicyRefs: [],
      limitsArtifactId: "limits",
      expectedProfileRevision: "p1",
    },
    caller,
  );
  assert.deepEqual(host.current("w-demo"), queued);
  assert.throws(
    () => host.current("w-demo", "other"),
    code("NATIVE_PROFILE_STALE"),
  );
  let effects = 0;
  assert.throws(() => {
    host.assertCurrent("w-demo", queued, "p1");
    effects++;
  }, code("STALE_REVISION"));
  assert.equal(effects, 0);
  host.close();
  const reopened = createNativeHost(directory);
  try {
    assert.deepEqual(reopened.current("w-demo", "p1"), queued);
  } finally {
    reopened.close();
  }
});

for (const kind of ["profileSnapshot", "configurationTransition"]) {
  test(`selected ${kind} deletion fails closed without falling back`, (t) => {
    const { host, writer } = fixture(t);
    const { profiles, selection } = selectedProfile(writer);
    profiles.select(selection, caller);
    const row = writer.audit().records.findLast((row) => row.kind === kind);
    writer.noteDeletion(row.record.recordId);
    assert.throws(
      () => host.current("w-demo", "p1"),
      code(
        kind === "profileSnapshot"
          ? "NATIVE_PROFILE_UNAVAILABLE"
          : "NATIVE_CONFIG_UNAVAILABLE",
      ),
    );
  });
}

test("current binds config and profile to one read even when another handle applies immediately after it", (t) => {
  const { host, writer } = fixture(t);
  const { profiles, selection } = selectedProfile(writer);
  profiles.select(selection, caller);
  const original = Store.prototype.readAuthority;
  let interleaved = false;
  Store.prototype.readAuthority = function (scope) {
    const observation = original.call(this, scope);
    if (!interleaved) {
      interleaved = true;
      new ConfigAuthority(writer).apply(
        {
          ...selection,
          transitionId: "select2",
          expectedConfigRevision: "cfg-1",
          acceptedConfigRevision: "cfg-2",
        },
        caller,
      );
    }
    return observation;
  };
  try {
    assert.equal(host.current("w-demo", "p1").configRevision, "cfg-1");
    assert.equal(host.current("w-demo", "p1").configRevision, "cfg-2");
  } finally {
    Store.prototype.readAuthority = original;
  }
});

test("scoped current avoids full audit and ignores unrelated scope and historical event payloads", (t) => {
  const { host, writer } = fixture(t);
  const { profiles, selection } = selectedProfile(writer);
  profiles.select(selection, caller);
  seedEvent(writer);
  writer.noteDeletion("e1");
  append(writer, "run", { recordId: "other", scopeId: "other" });
  writer.db.exec(
    "UPDATE records SET kind = 'futureKind' WHERE scope_id = 'other'",
  );
  const original = Store.prototype.audit;
  Store.prototype.audit = () => {
    throw new Error("full audit on hot path");
  };
  try {
    assert.equal(host.current("w-demo", "p1").profileRevision, "p1");
    assert.deepEqual(host.listWorkspaces(), []);
    assert.equal(host.resolveWorkspace("w-demo"), undefined);
  } finally {
    Store.prototype.audit = original;
  }
  assert.throws(() => host.current("other"), code("CONTRACT_UNKNOWN_KIND"));
});

test("native authority remains bounded with 10000 unrelated historical rows", (t) => {
  const { host, writer } = fixture(t);
  const { profiles, selection } = selectedProfile(writer);
  profiles.select(selection, caller);
  writer.db
    .prepare(
      "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 10000) " +
        "INSERT INTO records (kind, record_id, schema_version, scope_id, session_id, created_at, payload) " +
        "SELECT 'run', 'history-' || x, 1, 'w-demo', 's1', ?, json_set(?, '$.recordId', 'history-' || x) FROM n",
    )
    .run(fixtures.run.createdAt, JSON.stringify(fixtures.run));
  assert.equal(writer.readAuthority("w-demo").records.length, 4);
  const start = performance.now();
  assert.equal(host.current("w-demo", "p1").profileRevision, "p1");
  assert.deepEqual(host.listWorkspaces(), []);
  assert.equal(host.resolveWorkspace("w-demo"), undefined);
  const elapsed = performance.now() - start;
  assert.ok(
    elapsed < 10000,
    `native reads exceeded Rust timeout: ${elapsed}ms`,
  );
  t.diagnostic(
    `10000 historical rows, current/list/resolve: ${elapsed.toFixed(2)}ms`,
  );
});

test("tombstones preserve historical evidence without restoring authority", (t) => {
  const { host, writer, directory } = fixture(t);
  append(writer, "profileSnapshot", { configRevision: "cfg-0" });
  writer.noteDeletion("rec-profile");
  assert.equal(host.handshakeReadiness.store, true);
  assert.throws(
    () => host.current("w-demo", "p1"),
    code("NATIVE_PROFILE_UNAVAILABLE"),
  );
  assert.equal(writer.cursor(), 1);
  host.close();
  const reopened = createNativeHost(directory);
  try {
    assert.throws(
      () => reopened.current("w-demo", "p1"),
      code("NATIVE_PROFILE_UNAVAILABLE"),
    );
    assert.equal(writer.deletionEpoch(), 1);
  } finally {
    reopened.close();
  }
});

test("structural audit retains historical event references after deletion", (t) => {
  const { host, writer } = fixture(t);
  append(writer, "run", { recordId: "e1" });
  const { seq, ...draft } = fixtures.event.envelope;
  writer.commitEvents([], [draft], caller);
  writer.noteDeletion("e1");
  assert.equal(writer.audit().recordCount, 2);
  assert.equal(host.handshakeReadiness.store, true);
  assert.deepEqual(host.current("w-demo").grantIds, []);
  assert.throws(
    () => writer.replayEvents("w-demo", "s1"),
    code("UNRESOLVED_REFERENCE"),
  );
  assert.equal(writer.deletionEpoch(), 1);
});

test("historical migrated attribution remains intact", (t) => {
  const { host, writer } = fixture(t);
  append(writer, "run");
  writer.db.exec("UPDATE records SET session_id = ''");
  assert.equal(host.handshakeReadiness.store, true);
  assert.equal(writer.audit().recordCount, 1);
  assert.equal(writer.list("w-demo").records.length, 1);
  assert.equal(writer.list("w-demo", 0, "s1").records.length, 0);
});

test("deleted effective config is unavailable without changing its history", (t) => {
  const { host, writer } = fixture(t);
  append(writer, "configurationTransition", {
    expectedConfigRevision: "cfg-0",
  });
  writer.noteDeletion("rec-config");
  assert.throws(
    () => host.current("w-demo"),
    code("NATIVE_CONFIG_UNAVAILABLE"),
  );
  assert.equal(writer.configRevision("w-demo"), "cfg2");
  assert.equal(writer.cursor(), 1);
});

for (const [name, sql, expected] of [
  [
    "unknown schema",
    "UPDATE records SET schema_version = 99",
    "UNKNOWN_SCHEMA",
  ],
  [
    "unknown kind",
    "UPDATE records SET kind = 'futureKind'",
    "CONTRACT_UNKNOWN_KIND",
  ],
  ["corrupt payload", "UPDATE records SET payload = '{'", "STORE_CORRUPT"],
  [
    "invalid authority shape",
    "UPDATE records SET payload = json_remove(payload, '$.profileRevision')",
    "CONTRACT_INVALID_SHAPE",
  ],
  [
    "row attribution",
    "UPDATE records SET record_id = 'foreign'",
    "STORE_ATTRIBUTION",
  ],
]) {
  test(`${name} fails bootstrap and dynamic authority without resetting data`, (t) => {
    const { host, writer, directory } = fixture(t);
    append(writer, "profileSnapshot", { configRevision: "cfg-0" });
    writer.db.exec(sql);
    const before = writer.db.prepare("SELECT * FROM records").all();
    assert.throws(() => host.current("w-demo", "p1"), code(expected));
    assert.equal(host.handshakeReadiness.store, true);
    assert.throws(() => createNativeHost(directory), code(expected));
    assert.deepEqual(writer.db.prepare("SELECT * FROM records").all(), before);
  });
}

test("path input must be an absolute native appdata path", () => {
  const invalid = [undefined, {}, "relative", "", "C:\\bad\0path", "\ud800"];
  if (process.platform === "win32")
    invalid.push(
      "\\\\server\\share",
      "\\\\?\\UNC\\server\\share",
      "\\\\.\\device",
      "\\\\?\\GLOBALROOT\\device",
      "C:relative",
      "\\rooted",
      "C:\\bad\ud800path",
    );
  for (const value of invalid)
    assert.throws(
      () => createNativeHost(value),
      code("NATIVE_APP_DATA_INVALID"),
    );
});

test("non-SQLite appdata Store is preserved and rejected", (t) => {
  const { host, writer, path, directory } = fixture(t);
  host.close();
  writer.close();
  writeFileSync(path, "not a SQLite store");
  assert.throws(() => createNativeHost(directory), code("STORE_CORRUPT"));
  assert.equal(readFileSync(path, "utf8"), "not a SQLite store");
});

test("repeated readiness reports bootstrap state without auditing history again", (t) => {
  const { host, writer, directory } = fixture(t);
  seedEvent(writer);
  writer.db.exec(
    "UPDATE records SET payload = json_set(payload, '$.envelope.protocolVersion', 3) WHERE kind = 'event'",
  );
  const original = Store.prototype.audit;
  let audits = 0;
  Store.prototype.audit = () => {
    audits++;
    throw new Error("unexpected repeated audit");
  };
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal(host.handshakeReadiness.store, true);
      assert.deepEqual(host.handshakeReadiness.ports, {
        generation: false,
        provider: false,
        workspace: false,
        modules: false,
      });
    }
    assert.equal(audits, 0);
    host.close();
    assert.throws(() => host.handshakeReadiness, code("STORE_CLOSED"));
  } finally {
    Store.prototype.audit = original;
  }
  assert.throws(
    () => createNativeHost(directory),
    code("CONTRACT_UNSUPPORTED_VERSION"),
  );
});

test("closed host fails readiness and authority", (t) => {
  const { host } = fixture(t);
  host.close();
  assert.throws(() => host.handshakeReadiness, code("STORE_CLOSED"));
  assert.throws(() => host.current("w-demo"), code("STORE_CLOSED"));
});

function seedEvent(writer) {
  append(writer, "run", { recordId: "e1" });
  const { seq, ...draft } = fixtures.event.envelope;
  writer.commitEvents([], [draft], caller);
}

test("reopened protocol-1 SQLite history projects protocol 2 without rewriting payload bytes", (t) => {
  const { host, writer, path, directory } = fixture(t);
  seedEvent(writer);
  writer.db.exec(
    "UPDATE records SET payload = json_set(payload, '$.envelope.protocolVersion', 1) WHERE kind = 'event'",
  );
  const raw = writer.db
    .prepare("SELECT payload FROM records WHERE kind = 'event'")
    .get().payload;
  const expected = JSON.parse(raw);
  expected.envelope.protocolVersion = 2;
  host.close();
  writer.close();
  const reopened = Store.open(path);
  let factory;
  const imported = Store.open(join(directory, "import.db"));
  try {
    factory = createNativeHost(directory);
    assert.equal(factory.handshakeReadiness.store, true);
    assert.deepEqual(
      reopened.audit().records.find(({ kind }) => kind === "event").record,
      expected,
    );
    assert.deepEqual(reopened.get(expected.recordId).record, expected);
    assert.deepEqual(
      reopened.list("w-demo").records.find(({ kind }) => kind === "event")
        .record,
      expected,
    );
    assert.deepEqual(reopened.replayEvents("w-demo", "s1"), [
      expected.envelope,
    ]);
    assert.equal(
      reopened.eventHighwater("w-demo", "s1"),
      expected.envelope.seq,
    );
    const exportedPath = join(directory, "export.jsonl");
    assert.equal(reopened.exportJSONL(exportedPath), 2);
    assert.equal(imported.importJSONL(exportedPath, caller), 2);
    assert.deepEqual(imported.get(expected.recordId).record, expected);
    assert.equal(
      reopened.db
        .prepare("SELECT payload FROM records WHERE kind = 'event'")
        .get().payload,
      raw,
    );
    reopened.noteDeletion("e1");
    assert.equal(reopened.audit().recordCount, 2);
    assert.equal(factory.handshakeReadiness.store, true);
    assert.throws(
      () => reopened.replayEvents("w-demo", "s1"),
      code("UNRESOLVED_REFERENCE"),
    );
    assert.equal(
      reopened.db
        .prepare("SELECT payload FROM records WHERE kind = 'event'")
        .get().payload,
      raw,
    );
  } finally {
    imported.close();
    factory?.close();
    reopened.close();
  }
});

for (const version of [3, "1"]) {
  test(`stored event protocol ${JSON.stringify(version)} remains invalid`, (t) => {
    const { host, writer } = fixture(t);
    seedEvent(writer);
    writer.db
      .prepare(
        "UPDATE records SET payload = json_set(payload, '$.envelope.protocolVersion', ?) WHERE kind = 'event'",
      )
      .run(version);
    const raw = writer.db
      .prepare("SELECT payload FROM records WHERE kind = 'event'")
      .get().payload;
    assert.throws(() => writer.audit(), code("CONTRACT_UNSUPPORTED_VERSION"));
    assert.equal(host.handshakeReadiness.store, true);
    assert.throws(
      () => writer.get(fixtures.event.recordId),
      code("UNSUPPORTED_VERSION"),
    );
    assert.throws(() => writer.list("w-demo"), code("UNSUPPORTED_VERSION"));
    assert.throws(
      () => writer.replayEvents("w-demo", "s1"),
      code("UNSUPPORTED_VERSION"),
    );
    assert.equal(
      writer.db
        .prepare("SELECT payload FROM records WHERE kind = 'event'")
        .get().payload,
      raw,
    );
  });
}

test("protocol-1 live append and transport validation stay closed", (t) => {
  const { writer } = fixture(t);
  append(writer, "run", { recordId: "e1" });
  const legacy = {
    ...fixtures.event,
    envelope: { ...fixtures.event.envelope, protocolVersion: 1 },
  };
  const before = writer.cursor();
  assert.throws(
    () => writer.append({ kind: "event", record: legacy }, caller),
    code("EVENT_COMMIT_REQUIRED"),
  );
  const { seq, ...draft } = legacy.envelope;
  assert.throws(
    () => writer.commitEvents([], [draft], caller),
    code("CONTRACT_UNSUPPORTED_VERSION"),
  );
  assert.throws(
    () =>
      validateEvent(legacy.envelope, {
        ...caller,
        scopeId: "w-demo",
        lastDurableSeq: 1,
        maxInlineBytes: 65536,
      }),
    code("UNSUPPORTED_VERSION"),
  );
  assert.equal(writer.cursor(), before);
  assert.equal(writer.eventHighwater("w-demo", "s1"), 0);
});
