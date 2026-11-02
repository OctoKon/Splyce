// Actual SQLite, provider-setup producer, selection fold and NativeControl.
// Only the native parent's credential-status replies are protocol fixtures.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ConfigAuthority } from "../packages/splyce-pi/dist/config.js";
import { canonicalEndpointUrl } from "../packages/splyce-pi/dist/contracts.js";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";
import { createNativeProviderSetup } from "../packages/splyce-pi/src/native-provider-setup.mjs";
import { createNativeSetupReader } from "../packages/splyce-pi/src/native-setup-read.mjs";
import { createNativeSessionSetup } from "../packages/splyce-pi/src/native-session-setup.mjs";

const denied = (error) =>
  error?.code === "SETUP_UNAVAILABLE" &&
  error.message === "Native setup unavailable" &&
  !Object.hasOwn(error, "cause");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "splyce-setup-read-"));
  const project = join(directory, "private-project-path");
  mkdirSync(project);
  const path = join(directory, "store.db");
  const store = Store.open(path);
  const rival = Store.open(path);
  const state = { onStatus: async () => true };
  const frames = [];
  const control = new NativeControl(async (frame) => {
    frames.push(frame);
    assert.equal(frame.native.method, "credential.status");
    assert.deepEqual(Object.keys(frame.native.params), ["target"]);
    const present = await state.onStatus(frame);
    control.accept({
      native: { id: frame.native.id, ok: true, value: { present } },
    });
  });
  t.after(() => {
    control.shutdown();
    store.close();
    rival.close();
    const actual = resolve(directory);
    assert.equal(
      dirname(actual).toLowerCase(),
      resolve(tmpdir()).toLowerCase(),
    );
    assert.ok(basename(actual).startsWith("splyce-setup-read-"));
    rmSync(actual, { recursive: true, force: true });
  });
  const caller = {
    sessionId: "setup-read-storage-fixture",
    configRevision: "cfg-0",
    profileRevision: "p1",
    policyRevision: "cfg-0",
    resolveReference: (id, scopeId) =>
      store.db
        .prepare(
          "SELECT 1 FROM records r WHERE scope_id = ? AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.record_id = r.record_id) AND (record_id = ? OR json_extract(payload, '$.artifactId') = ? OR json_extract(payload, '$.endpointId') || '@' || json_extract(payload, '$.revision') = ? OR json_extract(payload, '$.credentialRef') = ? OR (? GLOB 'setup-request:sha256:*' AND EXISTS (SELECT 1 FROM json_each(r.payload, '$.sourceIds') j WHERE j.value = ?)))",
        )
        .get(scopeId, id, id, id, id, id, id) !== undefined,
  };
  const workspace = store.admitWorkspace(
    { canonicalPath: project, volumeSerial: "1", fileId: "2" },
    caller,
  );
  const setup = createNativeProviderSetup(store, directory);
  let number = 0;
  function produce(overrides = {}) {
    number++;
    const metadata = {
      requestId: `producer-${number}`,
      workspaceId: workspace.workspaceId,
      providerConnectionId: `connection-${number}`,
      profileId: `profile-${number}`,
      apiFamily: "openai-completions",
      endpoint: "https://example.test/private-api/v1",
      locality: "hosted",
      chat: {
        modelId: "namespace/model:revision",
        model: {
          contextWindow: 8192,
          maxOutputTokens: 1024,
          reasoning: false,
          input: ["text"],
        },
      },
      accountScopeRef: "provider-default",
      expectedConnectionRevision: null,
      expectedProfileRevision: null,
      expectedEndpointRevision: null,
      credentialKind: "new",
      ...overrides,
    };
    const prepared = setup.prepare(metadata);
    const result = setup.commit({
      metadata,
      credentialRef: prepared.credentialRef,
    });
    assert.equal(result.state, "committed");
    const rows = store.readSetupState(workspace.workspaceId).records;
    const profile = rows.findLast(
      ({ kind, record }) =>
        kind === "profileSnapshot" && record.profileId === metadata.profileId,
    ).record;
    const connection = rows.findLast(
      ({ kind, record }) =>
        kind === "providerConnection" &&
        record.providerConnectionId === metadata.providerConnectionId,
    ).record;
    const endpoint = rows.findLast(
      ({ kind, record }) =>
        kind === "providerEndpoint" &&
        `${record.endpointId}@${record.revision}` === connection.endpointRef,
    ).record;
    return {
      metadata,
      profile,
      connection,
      endpoint,
      credentialRef: prepared.credentialRef,
    };
  }
  const input = {
    requestId: "read-request",
    workspaceId: workspace.workspaceId,
  };
  const read = createNativeSetupReader({ store, control });
  const snapshot = () => ({
    cursor: rival.cursor(),
    state: rival.readSetupState(workspace.workspaceId),
  });
  const select = (profile, requestId = "selection") =>
    rival.commitNativeProfileSelection(
      rival.prepareNativeSessionSetup("profile.select", {
        requestId,
        workspaceId: workspace.workspaceId,
        profileId: profile.profileId,
        expectedProfileRevision: profile.profileRevision,
        expectedConfigRevision: rival.configRevision(workspace.workspaceId),
      }),
      caller,
    );
  const advance = () =>
    new ConfigAuthority(rival).apply(
      {
        scopeId: workspace.workspaceId,
        transitionId: "reader-unrelated-transition",
        expectedConfigRevision: rival.configRevision(workspace.workspaceId),
        acceptedConfigRevision: "cfg-reader-current",
        intentRef: "reader-intent",
        changedValuesArtifactId: "reader-changes",
      },
      { ...caller, resolveReference: () => true },
    );
  const revise = (kind, record, changes) =>
    rival.compareAndAppend(
      {
        kind,
        record: { ...record, recordId: `${record.recordId}-next`, ...changes },
      },
      caller,
      {
        kind,
        scopeId: workspace.workspaceId,
        entityId:
          record.profileId ?? record.providerConnectionId ?? record.endpointId,
        expectedRevision: record.profileRevision ?? record.revision,
      },
    );
  const update = (recordId, transform) => {
    const raw = new DatabaseSync(path);
    try {
      const payload = JSON.parse(
        raw
          .prepare("SELECT payload FROM records WHERE record_id = ?")
          .get(recordId).payload,
      );
      raw
        .prepare("UPDATE records SET payload = ? WHERE record_id = ?")
        .run(JSON.stringify(transform(payload)), recordId);
    } finally {
      raw.close();
    }
  };
  return {
    directory,
    path,
    store,
    rival,
    state,
    frames,
    control,
    workspace,
    caller,
    input,
    read,
    snapshot,
    produce,
    select,
    advance,
    revise,
    update,
  };
}

test("empty admitted workspace needs no credential facility and reads current config without writing", async (t) => {
  const f = fixture(t);
  f.advance();
  const before = f.snapshot();
  const read = createNativeSetupReader({ store: f.store });
  assert.deepEqual(await read(f.input), {
    configRevision: "cfg-reader-current",
    selectedProfileId: null,
    profiles: [],
  });
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.frames.length, 0);
});

test("actual producer and selection survive reopen with exact redacted read projection", async (t) => {
  const f = fixture(t);
  const p = f.produce();
  f.select(p.profile);
  f.advance();
  const before = f.snapshot();
  const expected = {
    configRevision: "cfg-reader-current",
    selectedProfileId: p.profile.profileId,
    profiles: [
      {
        profileId: p.profile.profileId,
        profileRevision: "p1",
        apiFamily: "openai-completions",
        modelId: "namespace/model:revision",
        endpointOrigin: "https://example.test",
        providerConnectionId: p.connection.providerConnectionId,
        connectionRevision: p.connection.revision,
        endpointRevision: p.endpoint.revision,
        endpoint: p.endpoint.canonicalUrl,
        locality: "hosted",
        model: p.metadata.chat.model,
        credential: "configured",
      },
    ],
  };
  assert.deepEqual(await f.read(f.input), expected);
  const encoded = JSON.stringify(expected);
  for (const hidden of [
    p.credentialRef,
    p.endpoint.endpointId,
    f.directory,
    "generationReady",
    "readiness",
    "credentialRef",
    "requestId",
    "workspaceId",
    "secret",
  ])
    assert.equal(encoded.includes(hidden), false, hidden);
  assert.equal(f.frames.length, 1);
  assert.deepEqual(f.frames[0].native.params, { target: p.credentialRef });
  f.store.close();
  const reopened = Store.open(f.path);
  try {
    assert.deepEqual(
      await createNativeSetupReader({ store: reopened, control: f.control })(
        f.input,
      ),
      expected,
    );
  } finally {
    reopened.close();
  }
  assert.deepEqual(f.snapshot(), before);
});

test("all required roles determine credential status and repeated references are queried once", async (t) => {
  const f = fixture(t);
  const a = f.produce(),
    b = f.produce({ endpoint: "https://other.example.test/private-path" });
  f.revise("profileSnapshot", a.profile, {
    profileRevision: "p2",
    bindings: [
      ...a.profile.bindings,
      { ...b.profile.bindings[0], role: "summary" },
      { ...a.profile.bindings[0], role: "review" },
    ],
    sourceIds: [...a.profile.sourceIds, ...b.profile.sourceIds],
  });
  f.state.onStatus = async (frame) =>
    frame.native.params.target !== b.credentialRef;
  const before = f.snapshot();
  const result = await f.read(f.input);
  assert.equal(result.profiles.length, 2);
  assert.equal(
    result.profiles.find((p) => p.profileId === a.profile.profileId)
      .profileRevision,
    "p2",
  );
  assert.deepEqual(
    result.profiles.map((p) => p.credential),
    ["missing", "missing"],
  );
  assert.equal(f.frames.length, 2);
  assert.equal(
    new Set(f.frames.map((frame) => frame.native.params.target)).size,
    2,
  );
  assert.equal(JSON.stringify(result).includes("summary"), false);
  assert.deepEqual(f.snapshot(), before);
});

test("actual producer endpoints use URL.origin with default ports omitted", async (t) => {
  for (const raw of [
    "https://example.test/private-api/v1",
    "https://example.test:443/private-api/v1",
    "https://example.test:8443/private-api/v1",
  ]) {
    const f = fixture(t);
    const endpoint = canonicalEndpointUrl(raw, "hosted");
    const p = f.produce({ endpoint });
    assert.equal(p.endpoint.canonicalUrl, endpoint);
    assert.equal(
      (await f.read(f.input)).profiles[0].endpointOrigin,
      new URL(raw).origin,
    );
  }
});

test("preexisting descriptor tombstone does not turn a metadata view into readiness", async (t) => {
  const f = fixture(t);
  f.produce();
  const descriptor = f.rival
    .readSetupState(f.workspace.workspaceId)
    .records.find(
      ({ kind, record }) =>
        kind === "artifact" &&
        record.mediaType === "application/vnd.splyce.model-descriptor+json",
    );
  f.rival.noteDeletion(descriptor.record.recordId);
  const before = f.snapshot();
  const result = await f.read(f.input);
  assert.equal(result.profiles[0].credential, "configured");
  assert.deepEqual(Object.keys(result.profiles[0]), [
    "profileId",
    "profileRevision",
    "apiFamily",
    "modelId",
    "endpointOrigin",
    "providerConnectionId",
    "connectionRevision",
    "endpointRevision",
    "endpoint",
    "locality",
    "credential",
  ]);
  assert.equal(JSON.stringify(result).includes("ready"), false);
  assert.deepEqual(f.snapshot(), before);
});

test("a tombstoned latest profile never falls back to a live historical revision", async (t) => {
  const f = fixture(t),
    p = f.produce();
  f.revise("profileSnapshot", p.profile, { profileRevision: "p2" });
  const latest = f.rival
    .readSetupState(f.workspace.workspaceId)
    .records.findLast(({ kind }) => kind === "profileSnapshot").record;
  assert.equal(latest.profileRevision, "p2");
  f.rival.noteDeletion(latest.recordId);
  const before = f.snapshot();
  assert.deepEqual(await f.read(f.input), {
    configRevision: "cfg-0",
    selectedProfileId: null,
    profiles: [],
  });
  assert.equal(f.frames.length, 0);
  assert.deepEqual(f.snapshot(), before);
});

test("legacy unbound or unresolved live pinned state is refused before credential lookup", async (t) => {
  for (const variant of ["legacy", "connection", "endpoint"]) {
    const f = fixture(t),
      p = f.produce();
    assert.equal((await f.read(f.input)).profiles.length, 1);
    f.frames.length = 0;
    if (variant === "legacy")
      f.update(p.profile.recordId, (profile) => ({
        ...profile,
        bindings: profile.bindings.map(({ modelId, ...binding }) => binding),
      }));
    else f.rival.noteDeletion(p[variant].recordId);
    const before = f.snapshot();
    await assert.rejects(f.read(f.input), denied);
    assert.equal(f.frames.length, 0);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("refuses snapshot changes from a second SQLite handle during credential status", async (t) => {
  for (const variant of [
    "config",
    "profile",
    "connection",
    "endpoint",
    "descriptor",
    "workspace",
  ]) {
    const f = fixture(t),
      p = f.produce();
    assert.equal((await f.read(f.input)).profiles[0].credential, "configured");
    const reached = deferred(),
      release = deferred();
    f.state.onStatus = async () => {
      reached.resolve();
      await release.promise;
      return true;
    };
    const pending = f.read(f.input).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    await reached.promise;
    if (variant === "config") f.advance();
    else if (variant === "profile")
      f.revise("profileSnapshot", p.profile, { profileRevision: "p2" });
    else if (variant === "connection")
      f.revise("providerConnection", p.connection, { revision: "c2" });
    else if (variant === "endpoint")
      f.revise("providerEndpoint", p.endpoint, { revision: "r2" });
    else if (variant === "descriptor") {
      const descriptor = f.rival
        .readSetupState(f.workspace.workspaceId)
        .records.find(
          ({ kind, record }) =>
            kind === "artifact" &&
            record.mediaType === "application/vnd.splyce.model-descriptor+json",
        );
      f.rival.noteDeletion(descriptor.record.recordId);
    } else
      f.rival.admitWorkspace(
        {
          canonicalPath: f.workspace.canonicalPath,
          volumeSerial: "1",
          fileId: "3",
        },
        f.caller,
        { readmit: true },
      );
    const before = f.snapshot();
    release.resolve();
    assert.ok(denied((await pending).error), variant);
    assert.deepEqual(f.snapshot(), before, variant);
  }
});

test("abort, unavailable native status, control shutdown and Store close expose only fixed errors", async (t) => {
  for (const variant of [
    "abort",
    "shutdown",
    "store-close",
    "raw-error",
    "no-control",
  ]) {
    const f = fixture(t);
    f.produce();
    const before = f.snapshot();
    if (variant === "no-control") {
      await assert.rejects(
        createNativeSetupReader({ store: f.store })(f.input),
        denied,
      );
    } else if (variant === "raw-error") {
      f.state.onStatus = async () => {
        throw new Error(`secret-private-failure-${f.directory}`);
      };
      await assert.rejects(f.read(f.input), denied);
    } else {
      const reached = deferred(),
        release = deferred();
      f.state.onStatus = async () => {
        reached.resolve();
        await release.promise;
        return true;
      };
      const abort = new AbortController();
      const pending = f.read(f.input, abort.signal);
      await reached.promise;
      if (variant === "abort") abort.abort(new Error("secret-abort-marker"));
      else if (variant === "shutdown") f.control.shutdown();
      else f.store.close();
      release.resolve();
      await assert.rejects(pending, denied);
    }
    assert.deepEqual(f.snapshot(), before, variant);
  }
});

test("future schema and superseded workspace never return a profile or query credentials", async (t) => {
  for (const variant of ["future", "superseded"]) {
    const f = fixture(t),
      p = f.produce();
    if (variant === "future") {
      const raw = new DatabaseSync(f.path);
      try {
        raw
          .prepare(
            "UPDATE records SET schema_version = 999 WHERE record_id = ?",
          )
          .run(p.profile.recordId);
      } finally {
        raw.close();
      }
    } else
      f.rival.admitWorkspace(
        {
          canonicalPath: f.workspace.canonicalPath,
          volumeSerial: "1",
          fileId: "3",
        },
        f.caller,
        { readmit: true },
      );
    const before = f.rival.cursor();
    await assert.rejects(f.read(f.input), denied);
    assert.equal(f.rival.cursor(), before);
    assert.equal(f.frames.length, 0);
  }
});

test("actual setup.read routing preserves projection and rejects authority fields before status", async (t) => {
  const f = fixture(t);
  f.produce();
  let factoryCalls = 0;
  const unused = () => {
    factoryCalls++;
    assert.fail("read must not invoke the session factory");
  };
  const service = createNativeSessionSetup({
    store: f.store,
    control: f.control,
    factory: {
      prepare: unused,
      restore: unused,
      bind: unused,
      dispose: unused,
    },
  });
  t.after(() => service.close());
  const before = f.snapshot();
  const expected = await f.read(f.input);
  assert.deepEqual(
    await service.handle("setup.read", f.input, f.input.requestId),
    expected,
  );
  assert.equal(factoryCalls, 0);
  assert.deepEqual(f.snapshot(), before);
  const calls = f.frames.length;
  for (const [input, requestId] of [
    [{ ...f.input, grantId: "untrusted-authority" }, f.input.requestId],
    [f.input, "different-outer-request"],
  ]) {
    assert.throws(
      () => service.handle("setup.read", input, requestId),
      (error) =>
        error.code === "SETUP_INVALID" &&
        error.message === "Native setup unavailable",
    );
  }
  assert.equal(f.frames.length, calls);
  await service.close();
  await assert.rejects(
    service.handle("setup.read", f.input, f.input.requestId),
    denied,
  );
  assert.equal(f.frames.length, calls);
  assert.deepEqual(f.snapshot(), before);
});

test("actual setup.read routing refuses a completion after service close during native status", async (t) => {
  const f = fixture(t);
  f.produce();
  const service = createNativeSessionSetup({
    store: f.store,
    control: f.control,
  });
  const reached = deferred(),
    release = deferred();
  f.state.onStatus = async () => {
    reached.resolve();
    await release.promise;
    return true;
  };
  const before = f.snapshot();
  const pending = service.handle("setup.read", f.input, f.input.requestId);
  const refusal = assert.rejects(pending, denied);
  await reached.promise;
  const closing = service.close();
  release.resolve();
  await refusal;
  await closing;
  assert.deepEqual(f.snapshot(), before);
});
