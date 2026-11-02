import { currentNativePolicyRevision } from "../packages/splyce-pi/dist/policy.js";
// Real provider-setup producer joined to native selection/start on SQLite.
// Credential references and Pi IDs qualify metadata/storage only: no NativeControl,
// Credential Manager, secret, model request, or installed factory is involved.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";
import { createNativeProviderSetup } from "../packages/splyce-pi/src/native-provider-setup.mjs";
import { Store } from "../packages/splyce-pi/dist/store.js";

// Metadata and admitted-workspace support follow native-provider-setup.test.mjs.
function fixture(t, route = "commit") {
  const directory = mkdtempSync(join(tmpdir(), "splyce-producer-join-"));
  const workspacePath = join(directory, "workspace");
  mkdirSync(workspacePath);
  const host = createNativeHost(directory);
  const path = join(directory, "splyce", "store.db");
  const store = Store.open(path);
  t.after(() => {
    host.close();
    store.close();
    const actual = resolve(directory);
    assert.equal(
      dirname(actual).toLowerCase(),
      resolve(tmpdir()).toLowerCase(),
    );
    assert.ok(basename(actual).startsWith("splyce-producer-join-"));
    rmSync(actual, { recursive: true, force: true });
  });
  const workspace = host.admitWorkspace({
    canonicalPath: workspacePath,
    volumeSerial: "1",
    fileId: "2",
  });
  const metadata = {
    requestId: "producer-request",
    workspaceId: workspace.workspaceId,
    providerConnectionId: "producer-connection",
    profileId: "producer-profile",
    apiFamily: "openai-completions",
    endpoint: "https://example.test/api/v1",
    locality: "hosted",
    chat: {
      modelId: "vendor/model:version",
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
  };
  const setup = createNativeProviderSetup(store, join(directory, "splyce"));
  const prepared = setup.prepare(metadata);
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.reservation.created, true);
  const input = { metadata, credentialRef: prepared.credentialRef };
  const committed = setup.commit(input),
    read = setup.read(input),
    replay = setup.prepare(metadata);
  assert.equal(committed.state, "committed");
  assert.deepEqual(read, committed);
  assert.equal(replay.state, "replayed");
  assert.deepEqual(replay.view, committed.view);
  const produced =
    route === "read" ? read : route === "prepare-replay" ? replay : committed;
  const rows = () => store.readSetupState(metadata.workspaceId).records;
  const profile = rows().find(({ kind }) => kind === "profileSnapshot").record;
  const connection = rows().find(
    ({ kind }) => kind === "providerConnection",
  ).record;
  const refs = {
    account: connection.accountScopeRef,
    limits: profile.limitsArtifactId,
    egress: profile.egressPolicyRefs[0],
  };
  const descriptor = (name) =>
    rows().find(
      ({ kind, record }) =>
        kind === "artifact" && record.artifactId === refs[name],
    );
  for (const name of Object.keys(refs)) {
    assert.ok(
      descriptor(name),
      "the actual producer stored its referenced artifact",
    );
    assert.notEqual(
      descriptor(name).record.recordId,
      refs[name],
      "fixture must retain the real logical-ID/record-ID distinction",
    );
  }
  const caller = {
    sessionId: "producer-store-fixture",
    configRevision: "cfg-0",
    profileRevision: "cfg-0",
    policyRevision: "cfg-0",
    resolveReference: (id, scopeId) =>
      store.db
        .prepare(
          "SELECT 1 FROM records r WHERE scope_id = ? AND record_id = ? AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.record_id = r.record_id)",
        )
        .get(scopeId, id) !== undefined,
  };
  const selection = () => ({
    requestId: "select-real-producer",
    workspaceId: produced.view.workspaceId,
    profileId: produced.view.profileId,
    expectedProfileRevision: produced.view.profileRevision,
    // The public view's configRevision shape is a separate producer-owner regression.
    expectedConfigRevision: store.configRevision(metadata.workspaceId),
  });
  const state = () => ({
    cursor: store.cursor(),
    configRevision: store.configRevision(metadata.workspaceId),
    observation: store.readSetupState(metadata.workspaceId),
  });
  const update = (recordId, transform) => {
    const raw = new DatabaseSync(path);
    try {
      const current = JSON.parse(
        raw
          .prepare("SELECT payload FROM records WHERE record_id = ?")
          .get(recordId).payload,
      );
      raw
        .prepare("UPDATE records SET payload = ? WHERE record_id = ?")
        .run(JSON.stringify(transform(current)), recordId);
    } finally {
      raw.close();
    }
  };
  return {
    directory,
    host,
    store,
    path,
    metadata,
    produced,
    profile,
    connection,
    refs,
    descriptor,
    caller,
    selection,
    state,
    update,
  };
}

const stale = (error) =>
  error?.code === "STALE_REVISION" &&
  error.message === "Native setup unavailable";
const piMetadata = (id) => ({
  piSessionId: id,
  branchAnchor: {
    branchAnchorId: `anchor-${id}`,
    piSessionId: id,
    parentAnchorId: null,
    forkPointEntryId: null,
    firstChildEntryId: null,
    activeLeafEntryId: null,
  },
});

test("native provider commit/read/replay output supplies real descriptors for select and start", (t) => {
  for (const route of ["commit", "read", "prepare-replay"]) {
    const f = fixture(t, route);
    const preparation = f.store.prepareNativeSessionSetup(
      "profile.select",
      f.selection(),
    );
    assert.equal(preparation.profile.profileId, f.produced.view.profileId);
    const selected = f.store.commitNativeProfileSelection(
      preparation,
      f.caller,
    );
    assert.equal(selected.result.selectedProfileId, f.produced.view.profileId);
    assert.equal(
      selected.result.profileRevision,
      f.produced.view.profileRevision,
    );
    assert.equal(
      selected.result.configRevision,
      f.store.configRevision(f.metadata.workspaceId),
    );
    assert.equal(
      f.store
        .list(f.metadata.workspaceId)
        .records.some(({ kind }) => kind === "grant"),
      false,
    );
    const started = f.store.commitNativeSessionStart(
      f.store.prepareNativeSessionSetup("session.start", {
        requestId: "start-real-producer",
        workspaceId: f.produced.view.workspaceId,
        profileId: selected.result.selectedProfileId,
        expectedConfigRevision: selected.result.configRevision,
      }),
      piMetadata("pi-producer-storage-fixture"),
      f.caller,
      currentNativePolicyRevision,
    );
    assert.equal(started.result.sessionId, "pi-producer-storage-fixture");
    assert.deepEqual(started.result.readiness, { state: "unavailable" });
    assert.equal(started.grantIds.length, 2);
    assert.equal(f.store.get(started.grantIds[1]).record.capability, "fs.read");
    assert.equal(
      f.store.get(started.grantIds[0]).record.origin,
      f.produced.view.endpointOrigin,
    );
    assert.doesNotThrow(() =>
      f.store.assertNativeSessionStartCurrent({
        workspaceId: f.metadata.workspaceId,
        sessionId: started.result.sessionId,
        sessionRevision: started.result.sessionRevision,
      }),
    );
  }
});

test("native logical artifact references reject unknown, deleted and ambiguous history before or after capture", (t) => {
  for (const name of ["account", "limits", "egress"]) {
    for (const mutation of [
      "unknown",
      "deleted",
      "duplicate",
      "deleted-duplicate",
      "deleted-original",
      "legacy-collision",
    ]) {
      const f = fixture(t),
        request = f.selection();
      const preparation = f.store.prepareNativeSessionSetup(
        "profile.select",
        request,
      );
      const original = f.descriptor(name).record;
      if (mutation === "unknown") {
        f.update(
          name === "account" ? f.connection.recordId : f.profile.recordId,
          (record) => ({
            ...record,
            ...(name === "account"
              ? { accountScopeRef: "missing-native-descriptor" }
              : name === "limits"
                ? { limitsArtifactId: "missing-native-descriptor" }
                : { egressPolicyRefs: ["missing-native-descriptor"] }),
          }),
        );
      } else if (mutation === "deleted") {
        f.store.noteDeletion(original.recordId);
      } else {
        const duplicate = {
          ...original,
          recordId:
            mutation === "legacy-collision"
              ? f.refs[name]
              : "duplicate-native-descriptor",
          artifactId:
            mutation === "legacy-collision"
              ? "different-logical-descriptor"
              : original.artifactId,
        };
        f.store.append({ kind: "artifact", record: duplicate }, f.caller);
        if (mutation === "deleted-duplicate")
          f.store.noteDeletion(duplicate.recordId);
        if (mutation === "deleted-original")
          f.store.noteDeletion(original.recordId);
      }
      const before = f.state();
      assert.throws(
        () => f.store.prepareNativeSessionSetup("profile.select", request),
        stale,
        `${name}/${mutation}`,
      );
      assert.throws(
        () => f.store.commitNativeProfileSelection(preparation, f.caller),
        stale,
        `${name}/${mutation}`,
      );
      assert.deepEqual(f.state(), before);
    }
  }
});

test("logical descriptor resolution never falls through a cross-kind record identity", (t) => {
  const f = fixture(t),
    request = f.selection();
  const preparation = f.store.prepareNativeSessionSetup(
    "profile.select",
    request,
  );
  f.store.append(
    {
      kind: "configurationTransition",
      record: {
        schemaVersion: 1,
        recordId: f.refs.account,
        createdAt: "2026-10-28T00:00:00.000Z",
        scopeId: f.metadata.workspaceId,
        sourceIds: [],
        transitionId: "cross-kind-alias",
        expectedConfigRevision: "cfg-0",
        acceptedConfigRevision: "cfg-pending-only",
        intentRef: f.descriptor("account").record.recordId,
        changedValuesArtifactId: f.descriptor("limits").record.recordId,
        state: "pending",
        outcomeRef: null,
      },
    },
    f.caller,
  );
  const before = f.state();
  assert.throws(
    () => f.store.prepareNativeSessionSetup("profile.select", request),
    stale,
  );
  assert.throws(
    () => f.store.commitNativeProfileSelection(preparation, f.caller),
    stale,
  );
  assert.deepEqual(f.state(), before);
});

test("logical descriptor resolution never borrows an artifact from another workspace", (t) => {
  const f = fixture(t),
    request = f.selection();
  const preparation = f.store.prepareNativeSessionSetup(
    "profile.select",
    request,
  );
  const foreignPath = join(f.directory, "foreign-workspace");
  mkdirSync(foreignPath);
  const foreign = f.host.admitWorkspace({
    canonicalPath: foreignPath,
    volumeSerial: "1",
    fileId: "3",
  });
  const artifact = f.descriptor("account").record;
  f.store.append(
    {
      kind: "artifact",
      record: {
        ...artifact,
        scopeId: foreign.workspaceId,
        recordId: "foreign-artifact-record",
        artifactId: "foreign-only-reference",
      },
    },
    f.caller,
  );
  f.update(f.connection.recordId, (record) => ({
    ...record,
    accountScopeRef: "foreign-only-reference",
  }));
  const before = f.state();
  assert.throws(
    () => f.store.prepareNativeSessionSetup("profile.select", request),
    stale,
  );
  assert.throws(
    () => f.store.commitNativeProfileSelection(preparation, f.caller),
    stale,
  );
  assert.deepEqual(f.state(), before);
});

test("unique legacy descriptor record IDs remain accepted with distinct logical IDs", (t) => {
  const f = fixture(t);
  f.update(f.connection.recordId, (record) => ({
    ...record,
    accountScopeRef: f.descriptor("account").record.recordId,
  }));
  f.update(f.profile.recordId, (record) => ({
    ...record,
    limitsArtifactId: f.descriptor("limits").record.recordId,
    egressPolicyRefs: [f.descriptor("egress").record.recordId],
  }));
  const selected = f.store.commitNativeProfileSelection(
    f.store.prepareNativeSessionSetup("profile.select", f.selection()),
    f.caller,
  );
  assert.equal(selected.result.selectedProfileId, f.produced.view.profileId);
});

test("the last async snapshot includes resolved descriptor record identity and content", (t) => {
  for (const name of ["account", "limits", "egress"]) {
    const f = fixture(t),
      request = f.selection();
    const preparation = f.store.prepareNativeSessionSetup(
      "profile.select",
      request,
    );
    f.update(f.descriptor(name).record.recordId, (record) => ({
      ...record,
      digest: `sha256:${"f".repeat(64)}`,
      changedByRival: true,
    }));
    const before = f.state();
    assert.throws(
      () => f.store.commitNativeProfileSelection(preparation, f.caller),
      stale,
      name,
    );
    assert.deepEqual(f.state(), before);
  }
});

test("model descriptor sourceIds retain exact record-ID semantics", (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() =>
    f.store.prepareNativeSessionSetup("profile.select", f.selection()),
  );
  const model = f.store
    .readSetupState(f.metadata.workspaceId)
    .records.find(
      ({ kind, record }) =>
        kind === "artifact" &&
        record.mediaType === "application/vnd.splyce.model-descriptor+json",
    ).record;
  f.update(model.recordId, (record) => ({
    ...record,
    artifactId: "logical-model-descriptor-only",
  }));
  f.update(f.profile.recordId, (record) => ({
    ...record,
    sourceIds: record.sourceIds.map((id) =>
      id === model.recordId ? "logical-model-descriptor-only" : id,
    ),
  }));
  const before = f.state();
  assert.throws(
    () => f.store.prepareNativeSessionSetup("profile.select", f.selection()),
    (error) => error?.code === "SETUP_INVALID",
  );
  assert.deepEqual(f.state(), before);
});
