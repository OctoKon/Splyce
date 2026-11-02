import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  createNativeSessionSetup,
  validateNativeSessionSetup,
} from "../packages/splyce-pi/src/native-session-setup.mjs";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";
import { currentNativePolicyRevision } from "../packages/splyce-pi/dist/policy.js";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";
import {
  encodeFrame,
  runHost,
} from "../packages/splyce-pi/src/engine-host.mjs";

const selection = {
  requestId: "request-1",
  workspaceId: "workspace-1",
  profileId: "profile-1",
  expectedProfileRevision: "p1",
  expectedConfigRevision: "cfg-0",
};
const start = {
  requestId: "request-2",
  workspaceId: "workspace-1",
  profileId: "profile-1",
  expectedConfigRevision: "cfg-1",
};
const denied = (error) =>
  error?.code === "SETUP_INVALID" &&
  error.message === "Native setup unavailable";

test("setup commands capture only the exact frozen renderer fields", () => {
  for (const [command, input] of [
    ["profile.select", selection],
    ["session.start", start],
  ]) {
    const accepted = validateNativeSessionSetup(
      command,
      input,
      input.requestId,
    );
    assert.deepEqual(accepted, input);
    assert.notEqual(accepted, input);
    assert.equal(Object.isFrozen(accepted), true);
  }
});

test("setup rejects authority fields and missing fields before accepting a request", () => {
  for (const [command, input] of [
    ["profile.select", selection],
    ["session.start", start],
  ]) {
    for (const field of [
      "sessionId",
      "grantId",
      "credentialRef",
      "endpoint",
      "generationReady",
      "apiKey",
    ]) {
      assert.throws(
        () =>
          validateNativeSessionSetup(
            command,
            { ...input, [field]: "private-fixture" },
            input.requestId,
          ),
        denied,
      );
    }
    for (const field of Object.keys(input)) {
      const partial = { ...input };
      delete partial[field];
      assert.throws(
        () => validateNativeSessionSetup(command, partial, input.requestId),
        denied,
      );
    }
  }
});

test("setup requires matching inner and outer request identities", () => {
  assert.throws(
    () =>
      validateNativeSessionSetup("profile.select", selection, "other-request"),
    denied,
  );
  assert.throws(
    () => validateNativeSessionSetup("session.start", start, undefined),
    denied,
  );
  assert.throws(
    () => validateNativeSessionSetup("session.prompt", start, start.requestId),
    denied,
  );
});

test("setup bounds every opaque id in UTF-8 and rejects ambiguous revisions", () => {
  for (const [command, input] of [
    ["profile.select", selection],
    ["session.start", start],
  ]) {
    for (const field of Object.keys(input)) {
      for (const value of [
        null,
        undefined,
        1,
        {},
        "",
        "bad/id",
        "bad\\id",
        "bad id",
        "bad\n",
        "bad\u200b",
        "\ud800",
        "é".repeat(65),
      ]) {
        const candidate = { ...input, [field]: value };
        assert.throws(
          () =>
            validateNativeSessionSetup(command, candidate, candidate.requestId),
          denied,
        );
      }
    }
  }
  const boundary = { ...selection, requestId: "é".repeat(64) };
  assert.deepEqual(
    validateNativeSessionSetup("profile.select", boundary, boundary.requestId),
    boundary,
  );
});

test("setup does not invoke accessors or retain a mutable input object", () => {
  let reads = 0;
  const input = { ...selection };
  Object.defineProperty(input, "profileId", {
    enumerable: true,
    get() {
      reads++;
      return "profile-1";
    },
  });
  assert.throws(
    () =>
      validateNativeSessionSetup("profile.select", input, selection.requestId),
    denied,
  );
  assert.equal(reads, 0);
  const changed = { ...selection };
  const accepted = validateNativeSessionSetup(
    "profile.select",
    changed,
    changed.requestId,
  );
  changed.profileId = "profile-2";
  assert.equal(accepted.profileId, "profile-1");
});

// Real SQLite and NativeControl; only the parent protocol and factory port are fixtures.
function serviceFixture(
  t,
  currentPolicyRevision = currentNativePolicyRevision,
) {
  const appDataDir = mkdtempSync(join(tmpdir(), "splyce-session-setup-"));
  const directory = join(appDataDir, "splyce");
  mkdirSync(directory);
  const store = Store.open(join(directory, "store.db"));
  const credentialRef = `splyce-credential:v1:${"a".repeat(64)}`;
  const caller = {
    sessionId: "native-setup-fixture",
    configRevision: "cfg-0",
    profileRevision: "p1",
    policyRevision: "cfg-0",
    resolveReference: (id, scopeId) =>
      store
        .list(scopeId)
        .records.some(
          ({ record }) =>
            record.recordId === id ||
            (record.endpointId &&
              `${record.endpointId}@${record.revision}` === id),
        ),
  };
  const workspace = store.admitWorkspace(
    {
      canonicalPath: join(directory, "project"),
      volumeSerial: "1",
      fileId: "2",
    },
    caller,
  );
  const workspaceId = workspace.workspaceId;
  for (const id of [credentialRef, "account", "limits", "egress"])
    store.append(
      {
        kind: "artifact",
        record: {
          schemaVersion: 1,
          recordId: id,
          createdAt: "2026-10-28T00:00:00.000Z",
          scopeId: workspaceId,
          sourceIds: [],
          artifactId: id,
          digest: `sha256:${createHash("sha256").update("{}").digest("hex")}`,
          mediaType: "application/json",
          byteLength: 2,
          retentionClass: "workspace",
        },
      },
      caller,
    );
  for (const name of ["a", "b"])
    store.commitSetup(
      {
        workspaceId,
        requestId: `seed-${name}`,
        endpoint: {
          endpointId: `endpoint-${name}`,
          canonicalUrl: `https://${name}.example.test/v1`,
          apiFamily: "openai-completions",
          locality: "hosted",
          revision: "e1",
        },
        connection: {
          providerConnectionId: `connection-${name}`,
          revision: "c1",
          apiFamily: "openai-completions",
          locality: "hosted",
          endpointRef: `endpoint-${name}@e1`,
          credentialRef,
        },
        profile: {
          profileId: `profile-${name}`,
          profileRevision: "p1",
          bindings: [
            {
              role: "chat",
              providerConnectionId: `connection-${name}`,
              connectionRevision: "c1",
              modelId: "fixture-model",
              modelDescriptor: {
                source: "user",
                contextWindow: 4096,
                maxOutputTokens: 256,
                reasoning: false,
                input: ["text"],
                costKnown: false,
              },
            },
          ],
        },
        descriptors: {
          accountScopeRef: "account",
          limitsArtifactId: "limits",
          apiVersion: "v1",
          adapterRevision: "fixture1",
          egressPolicyRefs: ["egress"],
        },
        expected: {
          endpointRevision: null,
          connectionRevision: null,
          profileRevision: null,
        },
      },
      caller,
    );
  const state = {
    present: true,
    failPrepare: false,
    failBind: false,
    onPrepare: async () => {},
    onBind: async () => {},
  };
  const trace = [],
    frames = [];
  const control = new NativeControl(async (frame) => {
    frames.push(frame);
    assert.equal(frame.native.method, "credential.status");
    assert.deepEqual(frame.native.params, { target: credentialRef });
    control.accept({
      native: {
        id: frame.native.id,
        ok: true,
        value: { present: state.present },
      },
    });
  });
  let number = 0;
  const factory = {
    async prepare(input) {
      trace.push("prepare");
      if (state.failPrepare) throw new Error("private-path-fixture");
      await state.onPrepare(input);
      const piSessionId = `pi-fixture-${++number}`;
      return {
        piSessionId,
        branchAnchor: {
          branchAnchorId: `anchor-${piSessionId}`,
          piSessionId,
          parentAnchorId: null,
          forkPointEntryId: null,
          firstChildEntryId: null,
          activeLeafEntryId: null,
        },
        handle: { private: "private-path-fixture" },
      };
    },
    async restore(input) {
      trace.push("restore");
      return {
        piSessionId: input.piSessionId,
        branchAnchor: input.branchAnchor,
        handle: {},
      };
    },
    async bind(prepared) {
      const rows = store.list(workspaceId).records;
      assert.equal(
        rows.some(
          ({ kind, record }) =>
            kind === "branchAnchor" &&
            record.piSessionId === prepared.piSessionId,
        ),
        true,
        "Store commit must precede publication",
      );
      assert.equal(
        rows.some(
          ({ kind, record }) =>
            kind === "grant" &&
            record.sessionId === prepared.piSessionId &&
            record.capability === "net.provider",
        ),
        true,
        "session grant commits before publication",
      );
      trace.push("bind");
      await state.onBind(prepared);
      if (state.failBind) throw new Error("private-path-fixture");
    },
    async dispose(_prepared, reason) {
      trace.push(`dispose:${reason}`);
    },
  };
  const service = createNativeSessionSetup({
    store,
    control,
    factory,
    currentPolicyRevision,
  });
  t.after(async () => {
    await service.close();
    control.shutdown();
    store.close();
    assert.equal(
      appDataDir.startsWith(join(tmpdir(), "splyce-session-setup-")),
      true,
    );
    rmSync(appDataDir, { recursive: true, force: true });
  });
  const select = (
    requestId = "select-a",
    profileId = "profile-a",
    expectedConfigRevision = "cfg-0",
  ) => ({
    requestId,
    workspaceId,
    profileId,
    expectedProfileRevision: "p1",
    expectedConfigRevision,
  });
  const run = (requestId, configRevision) => ({
    requestId,
    workspaceId,
    profileId: "profile-a",
    expectedConfigRevision: configRevision,
  });
  const handle = (input, command = "profile.select", signal) =>
    service.handle(command, input, input.requestId, signal);
  return {
    appDataDir,
    store,
    caller,
    workspaceId,
    control,
    factory,
    service,
    state,
    trace,
    frames,
    select,
    run,
    handle,
  };
}

test("real setup service refuses missing credentials before Store or factory effects", async (t) => {
  const f = serviceFixture(t);
  const before = f.store.list(f.workspaceId).records;
  f.state.present = false;
  await assert.rejects(
    f.handle(f.select()),
    (error) =>
      error.code === "CREDENTIAL_UNAVAILABLE" &&
      error.message === "Native setup unavailable",
  );
  assert.deepEqual(f.store.list(f.workspaceId).records, before);
  assert.deepEqual(f.trace, []);
  assert.equal(f.frames.length, 1);
});

test("real setup service orders prepare, atomic commit and bind and projects public identity", async (t) => {
  const f = serviceFixture(t);
  const selected = await f.handle(f.select());
  assert.deepEqual(Object.keys(selected).sort(), [
    "configRevision",
    "profileRevision",
    "selectedProfileId",
  ]);
  assert.equal(
    f.store.list(f.workspaceId).records.filter(({ kind }) => kind === "grant")
      .length,
    0,
    "select cannot mint grants",
  );
  const result = await f.handle(
    f.run("start-a", selected.configRevision),
    "session.start",
  );
  assert.deepEqual(Object.keys(result).sort(), [
    "permissionMode",
    "policyRevision",
    "readiness",
    "sessionId",
    "sessionRevision",
  ]);
  assert.deepEqual(result.readiness, { state: "ready" });
  assert.equal(result.permissionMode, "manual");
  assert.deepEqual(f.trace, ["prepare", "bind"]);
  assert.match(result.sessionRevision, /^[1-9][0-9]*$/);
  assert.equal(JSON.stringify(result).includes("private-path-fixture"), false);
  const grants = f.store
    .list(f.workspaceId)
    .records.filter(({ kind }) => kind === "grant");
  assert.equal(grants.length, 2);
  assert.equal(grants[0].record.capability, "net.provider");
  assert.equal(grants[1].record.capability, "fs.read");
  assert.equal(grants[1].record.scope, "session");
  assert.equal(grants[1].record.sessionId, result.sessionId);
  assert.equal(grants[0].record.scope, "session");
  assert.equal(grants[0].record.sessionId, result.sessionId);
});

test("real setup service compensates bind failure and never resurrects revoked grants on replay", async (t) => {
  const f = serviceFixture(t);
  const selected = await f.handle(f.select());
  f.state.failBind = true;
  const input = f.run("failed-start", selected.configRevision);
  const result = await f.handle(input, "session.start");
  assert.deepEqual(result.readiness, {
    state: "unavailable",
    code: "SESSION_BIND_FAILED",
  });
  assert.deepEqual(f.trace, ["prepare", "bind", "dispose:SESSION_BIND_FAILED"]);
  const rows = f.store.list(f.workspaceId).records;
  assert.equal(
    rows.some(
      ({ kind, record }) =>
        kind === "grant" &&
        record.sessionId === result.sessionId &&
        record.revokedAt,
    ),
    true,
  );
  f.state.failBind = false;
  const replay = await f.handle(input, "session.start");
  assert.deepEqual(replay, result);
  assert.deepEqual(f.store.list(f.workspaceId).records, rows);
  assert.deepEqual(f.trace, ["prepare", "bind", "dispose:SESSION_BIND_FAILED"]);
});

test("real setup service disposes inert preparation after a competing selection", async (t) => {
  const f = serviceFixture(t);
  const selected = await f.handle(f.select());
  f.state.onPrepare = async () => {
    const input = f.select(
      "rival-selection",
      "profile-b",
      selected.configRevision,
    );
    const preparation = f.store.prepareNativeSessionSetup(
      "profile.select",
      input,
    );
    f.store.commitNativeProfileSelection(preparation, f.caller);
  };
  await assert.rejects(
    f.handle(f.run("raced-start", selected.configRevision), "session.start"),
    (error) => error.code === "STALE_REVISION",
  );
  assert.deepEqual(f.trace, ["prepare", "dispose:SETUP_COMMIT_FAILED"]);
  assert.equal(
    f.store
      .list(f.workspaceId)
      .records.some(({ kind }) => kind === "branchAnchor" || kind === "grant"),
    false,
  );
});

test("real setup service replays stable identities and restores binding without a second Store effect", async (t) => {
  const f = serviceFixture(t);
  const selected = await f.handle(f.select());
  const input = f.run("replayed-start", selected.configRevision);
  const first = await f.handle(input, "session.start");
  const rows = f.store.list(f.workspaceId).records;
  assert.deepEqual(await f.handle(input, "session.start"), first);
  assert.deepEqual(f.trace, ["prepare", "bind"]);
  const reopened = createNativeSessionSetup({
    currentPolicyRevision: currentNativePolicyRevision,
    store: f.store,
    control: f.control,
    factory: f.factory,
  });
  t.after(() => reopened.close());
  const replay = await reopened.handle("session.start", input, input.requestId);
  assert.deepEqual(replay, first);
  assert.deepEqual(f.trace, ["prepare", "bind", "restore", "bind"]);
  assert.deepEqual(f.store.list(f.workspaceId).records, rows);
});

test("real setup service keeps missing factory and private preparation failures unavailable", async (t) => {
  const f = serviceFixture(t);
  const selected = await f.handle(f.select());
  const before = f.store.list(f.workspaceId).records;
  const unavailable = createNativeSessionSetup({
    currentPolicyRevision: currentNativePolicyRevision,
    store: f.store,
    control: f.control,
  });
  t.after(() => unavailable.close());
  const input = f.run("no-factory", selected.configRevision);
  await assert.rejects(
    unavailable.handle("session.start", input, input.requestId),
    (error) => error.code === "SETUP_UNAVAILABLE",
  );
  f.state.failPrepare = true;
  await assert.rejects(
    f.handle(
      f.run("private-failure", selected.configRevision),
      "session.start",
    ),
    (error) =>
      error.code === "SETUP_UNAVAILABLE" &&
      error.message === "Native setup unavailable",
  );
  assert.deepEqual(f.store.list(f.workspaceId).records, before);
});

test("historical selection replay does not dispose the currently bound profile", async (t) => {
  const f = serviceFixture(t);
  const original = f.select();
  const a = await f.handle(original);
  const b = await f.handle(f.select("select-b", "profile-b", a.configRevision));
  const input = {
    ...f.run("start-b", b.configRevision),
    profileId: "profile-b",
  };
  const active = await f.handle(input, "session.start");
  const rows = f.store.list(f.workspaceId).records;
  assert.deepEqual(await f.handle(original), a);
  assert.deepEqual(f.trace, ["prepare", "bind"]);
  assert.deepEqual(await f.handle(input, "session.start"), active);
  assert.deepEqual(f.store.list(f.workspaceId).records, rows);
  assert.deepEqual(f.trace, ["prepare", "bind"]);
});

for (const revokeOnly of [false, true]) {
  test(`setup does not publish readiness after ${revokeOnly ? "a grant revocation" : "a profile change"} during bind`, async (t) => {
    const f = serviceFixture(t);
    const selected = await f.handle(f.select());
    f.state.onBind = async () => {
      if (revokeOnly) f.store.revokeProviderGrants(f.workspaceId, f.caller);
      else {
        const rival = f.select(
          "bind-rival",
          "profile-b",
          selected.configRevision,
        );
        f.store.commitNativeProfileSelection(
          f.store.prepareNativeSessionSetup("profile.select", rival),
          f.caller,
        );
      }
    };
    const result = await f.handle(
      f.run("bind-race", selected.configRevision),
      "session.start",
    );
    assert.deepEqual(result.readiness, {
      state: "unavailable",
      code: "SESSION_BIND_FAILED",
    });
    assert.deepEqual(f.trace, [
      "prepare",
      "bind",
      "dispose:SESSION_BIND_FAILED",
    ]);
  });
}

test("ready replay rechecks genuine credential presence without minting another grant", async (t) => {
  const f = serviceFixture(t);
  const selected = await f.handle(f.select());
  const input = f.run("recheck-credentials", selected.configRevision);
  const first = await f.handle(input, "session.start");
  const frames = f.frames.length;
  f.state.present = false;
  const replay = await f.handle(input, "session.start");
  assert.deepEqual(replay, {
    sessionId: first.sessionId,
    sessionRevision: first.sessionRevision,
    policyRevision: currentNativePolicyRevision(f.workspaceId),
    readiness: { state: "unavailable", code: "SESSION_BIND_FAILED" },
  });
  assert.equal(f.frames.length, frames + 1);
  assert.equal(
    f.store
      .list(f.workspaceId)
      .records.filter(
        ({ kind, record }) => kind === "grant" && !record.revokedAt,
      ).length,
    2,
    "revocation records do not mint another grant",
  );
});

test("changed-payload replay keeps the frozen setup conflict code and fixed copy", async (t) => {
  const f = serviceFixture(t);
  const input = f.select();
  await f.handle(input);
  await assert.rejects(
    f.handle({ ...input, profileId: "profile-b" }),
    (error) =>
      error.code === "SETUP_REQUEST_CONFLICT" &&
      error.message === "Native setup unavailable",
  );
});

test(
  "framed engine routes select and start through the real native host, Control and SQLite",
  { timeout: 15000 },
  async (t) => {
    const f = serviceFixture(t);
    const input = new PassThrough();
    const pending = new Map();
    const replies = [];
    let buffered = Buffer.alloc(0);
    const output = new Writable({
      write(chunk, _encoding, done) {
        buffered = Buffer.concat([buffered, chunk]);
        while (
          buffered.length >= 4 &&
          buffered.length >= buffered.readUInt32BE(0) + 4
        ) {
          const length = buffered.readUInt32BE(0);
          const frame = JSON.parse(
            buffered.subarray(4, length + 4).toString("utf8"),
          );
          buffered = buffered.subarray(length + 4);
          if (frame.native) {
            assert.equal(frame.native.method, "credential.status");
            input.write(
              encodeFrame({
                native: {
                  id: frame.native.id,
                  ok: true,
                  value: { present: true },
                },
              }),
            );
          } else {
            replies.push(frame);
            const waiter = pending.get(frame.id);
            assert.ok(waiter);
            pending.delete(frame.id);
            waiter(frame);
          }
        }
        done();
      },
    });
    const job = runHost(input, output, (directory, control) =>
      createNativeHost(directory, control, f.factory),
    );
    const rpc = (id, method, params) => {
      const response = new Promise((resolve) => pending.set(id, resolve));
      input.write(encodeFrame({ id, method, params }));
      return response;
    };
    t.after(() => {
      input.destroy();
      output.destroy();
    });
    assert.equal(
      (
        await rpc("native-bootstrap", "native.bootstrap", {
          appDataDir: f.appDataDir,
        })
      ).ok,
      true,
    );
    const readCursor = f.store.cursor();
    const recovered = await rpc("read-rpc", "send", {
      frame: "setup",
      command: "setup.read",
      requestId: "framed-read",
      payload: { requestId: "framed-read", workspaceId: f.workspaceId },
    });
    assert.equal(recovered.ok, true);
    assert.equal(
      recovered.value.configRevision,
      f.store.configRevision(f.workspaceId),
    );
    assert.equal(recovered.value.selectedProfileId, null);
    assert.deepEqual(
      recovered.value.profiles,
      ["a", "b"].map((name) => ({
        profileId: `profile-${name}`,
        profileRevision: "p1",
        apiFamily: "openai-completions",
        modelId: "fixture-model",
        endpointOrigin: `https://${name}.example.test`,
        providerConnectionId: `connection-${name}`,
        connectionRevision: "c1",
        endpointRevision: "e1",
        endpoint: `https://${name}.example.test/v1`,
        locality: "hosted",
        model: {
          contextWindow: 4096,
          maxOutputTokens: 256,
          reasoning: false,
          input: ["text"],
        },
        credential: "configured",
      })),
    );
    assert.equal(f.store.cursor(), readCursor);
    assert.deepEqual(f.trace, []);
    const selection = f.select("framed-select");
    const selected = await rpc("select-rpc", "send", {
      frame: "setup",
      command: "profile.select",
      requestId: selection.requestId,
      payload: selection,
    });
    assert.equal(selected.ok, true);
    const start = f.run("framed-start", selected.value.configRevision);
    const started = await rpc("start-rpc", "send", {
      frame: "setup",
      command: "session.start",
      requestId: start.requestId,
      payload: start,
    });
    assert.equal(started.ok, true);
    assert.deepEqual(started.value.readiness, { state: "ready" });
    assert.deepEqual(f.trace, ["prepare", "bind"]);
    const permission = {
      requestId: "framed-permission",
      workspaceId: f.workspaceId,
      sessionId: started.value.sessionId,
      mode: "auto",
    };
    const permissionSet = await rpc("permission-rpc", "send", {
      frame: "setup",
      command: "permission.set",
      requestId: permission.requestId,
      payload: permission,
    });
    assert.equal(permissionSet.ok, true);
    assert.deepEqual(permissionSet.value, {
      workspaceId: f.workspaceId,
      sessionId: started.value.sessionId,
      mode: "auto",
    });
    const permissionRead = await rpc("permission-read-rpc", "send", {
      frame: "setup",
      command: "permission.read",
      requestId: "framed-permission-read",
      payload: {
        requestId: "framed-permission-read",
        workspaceId: f.workspaceId,
        sessionId: started.value.sessionId,
      },
    });
    assert.equal(permissionRead.ok, true);
    assert.deepEqual(permissionRead.value, permissionSet.value);
    const resumed = await rpc("resume-rpc", "send", {
      frame: "setup",
      command: "session.resume",
      requestId: "framed-resume",
      payload: {
        requestId: "framed-resume",
        workspaceId: f.workspaceId,
        sessionId: started.value.sessionId,
      },
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.value.sessionId, started.value.sessionId);
    assert.equal(resumed.value.permissionMode, "auto");
    const before = f.store.list(f.workspaceId).records;
    const rejected = await rpc("authority-rpc", "send", {
      frame: "setup",
      command: "session.start",
      requestId: "forged",
      payload: { ...start, requestId: "forged", grantId: "foreign" },
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "SETUP_INVALID");
    assert.equal(rejected.error.message, "Native setup unavailable");
    assert.deepEqual(f.store.list(f.workspaceId).records, before);
    assert.equal(
      JSON.stringify(replies).includes("private-path-fixture"),
      false,
    );
    assert.equal(JSON.stringify(replies).includes(f.appDataDir), false);
    assert.equal(JSON.stringify(replies).includes("credentialRef"), false);
    assert.equal((await rpc("shutdown-rpc", "shutdown", {})).ok, true);
    await job;
    assert.equal(pending.size, 0);
  },
);

test("setup projects refreshed Store policy witnesses for ready, replay and unavailable results", async (t) => {
  let revision = "12";
  const f = serviceFixture(t, () => revision);
  const selected = await f.handle(f.select());
  const request = f.run("policy-refresh", selected.configRevision);
  const first = await f.handle(request, "session.start");
  assert.equal(first.policyRevision, "12");
  const before = f.store.list(f.workspaceId).records;
  revision = "13";
  const replay = await f.handle(request, "session.start");
  assert.equal(replay.policyRevision, "13");
  assert.equal(replay.sessionId, first.sessionId);
  assert.deepEqual(f.store.list(f.workspaceId).records, before);
  revision = "14";
  f.state.present = false;
  const unavailable = await f.handle(request, "session.start");
  assert.equal(unavailable.policyRevision, "14");
  assert.equal(unavailable.readiness.code, "SESSION_BIND_FAILED");
  revision = "15";
  const failedReplay = await f.handle(request, "session.start");
  assert.equal(failedReplay.policyRevision, "15");
  assert.equal(failedReplay.sessionId, first.sessionId);
  assert.equal(failedReplay.readiness.code, "SESSION_BIND_FAILED");
});

test("bind failure projects the policy witness captured by its compensation transaction", async (t) => {
  let revision = "21";
  const f = serviceFixture(t, () => revision);
  const selected = await f.handle(f.select());
  f.state.onBind = async () => {
    revision = "22";
  };
  f.state.failBind = true;
  const failed = await f.handle(
    f.run("policy-bind-failure", selected.configRevision),
    "session.start",
  );
  assert.equal(failed.policyRevision, "22");
  assert.equal(failed.readiness.code, "SESSION_BIND_FAILED");
});

test("permission commands require a currently bound admitted session and preserve durable workspace/session choices", async (t) => {
  const f = serviceFixture(t);
  const selected = await f.handle(f.select());
  const request = f.run("permission-session", selected.configRevision);
  const started = await f.handle(request, "session.start");
  const input = {
    requestId: "permission-auto",
    workspaceId: f.workspaceId,
    sessionId: started.sessionId,
    mode: "auto",
  };
  const cursor = f.store.cursor();
  for (const wrong of [
    { ...input, workspaceId: "workspace-foreign" },
    { ...input, sessionId: "session-foreign" },
  ])
    await assert.rejects(f.handle(wrong, "permission.set"), {
      code: "SETUP_UNAVAILABLE",
    });
  assert.equal(f.store.cursor(), cursor);
  const applied = await f.handle(input, "permission.set");
  assert.deepEqual(applied, {
    workspaceId: f.workspaceId,
    sessionId: started.sessionId,
    mode: "auto",
  });
  const saved = f.store.cursor();
  assert.deepEqual(await f.handle(input, "permission.set"), applied);
  assert.equal(f.store.cursor(), saved);
  await assert.rejects(
    f.handle({ ...input, mode: "bypass" }, "permission.set"),
    { code: "SETUP_REQUEST_CONFLICT" },
  );
  const next = await f.handle(
    f.run("permission-inherits", selected.configRevision),
    "session.start",
  );
  assert.equal(next.permissionMode, "auto");
  await f.handle(
    {
      ...input,
      requestId: "permission-other-session",
      sessionId: next.sessionId,
      mode: "bypass",
    },
    "permission.set",
  );
  assert.deepEqual(
    await f.handle(
      {
        requestId: "permission-read",
        workspaceId: f.workspaceId,
        sessionId: started.sessionId,
      },
      "permission.read",
    ),
    applied,
  );
  await f.service.close();
  f.store.close();
  const reopenedStore = Store.open(join(f.appDataDir, "splyce", "store.db"));
  const reopened = createNativeSessionSetup({
    store: reopenedStore,
    control: f.control,
    factory: { ...f.factory, bind: async () => {} },
    currentPolicyRevision: currentNativePolicyRevision,
  });
  try {
    await assert.rejects(
      reopened.handle("permission.set", input, input.requestId),
      { code: "SETUP_UNAVAILABLE" },
    );
    assert.deepEqual(
      await reopened.handle(
        "permission.read",
        {
          requestId: "historical-before-bind",
          workspaceId: f.workspaceId,
          sessionId: started.sessionId,
        },
        "historical-before-bind",
      ),
      applied,
    );
    const restored = await reopened.handle(
      "session.resume",
      {
        requestId: "resume-first",
        workspaceId: f.workspaceId,
        sessionId: started.sessionId,
      },
      "resume-first",
    );
    assert.equal(restored.sessionId, started.sessionId);
    assert.equal(restored.permissionMode, "auto");
    const restoredNext = await reopened.handle(
      "session.resume",
      {
        requestId: "resume-second",
        workspaceId: f.workspaceId,
        sessionId: next.sessionId,
      },
      "resume-second",
    );
    assert.equal(restoredNext.sessionId, next.sessionId);
    assert.equal(restoredNext.permissionMode, "bypass");
    assert.deepEqual(
      await reopened.handle(
        "permission.read",
        {
          requestId: "after-restart",
          workspaceId: f.workspaceId,
          sessionId: started.sessionId,
        },
        "after-restart",
      ),
      applied,
    );
    const anchor = reopenedStore
      .list(f.workspaceId)
      .records.findLast(
        ({ kind, record }) =>
          kind === "branchAnchor" && record.piSessionId === next.sessionId,
      );
    reopenedStore.noteDeletion(anchor.record.recordId);
    await assert.rejects(
      reopened.handle(
        "permission.read",
        {
          requestId: "deleted-session-mode",
          workspaceId: f.workspaceId,
          sessionId: next.sessionId,
        },
        "deleted-session-mode",
      ),
      { code: "SETUP_UNAVAILABLE" },
    );
  } finally {
    await reopened.close();
    reopenedStore.close();
  }
});

test("permission commands reject invalid, authority-bearing and cancelled input before persistence", async (t) => {
  const f = serviceFixture(t);
  const selected = await f.handle(f.select());
  const started = await f.handle(
    f.run("permission-validated", selected.configRevision),
    "session.start",
  );
  const input = {
    requestId: "invalid-mode",
    workspaceId: f.workspaceId,
    sessionId: started.sessionId,
    mode: "auto",
  };
  const cursor = f.store.cursor();
  for (const bad of [
    { ...input, mode: "unknown" },
    { ...input, grantId: "forged" },
    { ...input, mode: {} },
  ])
    assert.throws(
      () => f.service.handle("permission.set", bad, input.requestId),
      { code: "INVALID_PERMISSION_MODE" },
    );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.handle(input, "permission.set", controller.signal), {
    code: "SETUP_UNAVAILABLE",
  });
  assert.equal(f.store.cursor(), cursor);
});

test("legacy native sessions without permission records restore in manual mode", async (t) => {
  const f = serviceFixture(t);
  const selected = await f.handle(f.select());
  const input = f.run("legacy-session", selected.configRevision);
  const preparation = f.store.prepareNativeSessionSetup("session.start", input);
  const prepared = await f.factory.prepare(input);
  f.store.commitNativeSessionStart(
    preparation,
    { piSessionId: prepared.piSessionId, branchAnchor: prepared.branchAnchor },
    f.caller,
    currentNativePolicyRevision,
  );
  assert.equal(
    f.store
      .list(f.workspaceId)
      .records.some(({ record }) => record.permissionMode),
    false,
  );
  const restored = await f.handle(input, "session.start");
  assert.equal(restored.permissionMode, "manual");
  assert.deepEqual(
    await f.handle(
      {
        requestId: "legacy-mode-read",
        workspaceId: f.workspaceId,
        sessionId: restored.sessionId,
      },
      "permission.read",
    ),
    {
      workspaceId: f.workspaceId,
      sessionId: restored.sessionId,
      mode: "manual",
    },
  );
});

test("deleting the latest permission record never revives historical bypass authority", async (t) => {
  const f = serviceFixture(t);
  const selected = await f.handle(f.select());
  const started = await f.handle(
    f.run("mode-deletion-session", selected.configRevision),
    "session.start",
  );
  for (const mode of ["bypass", "manual"])
    await f.handle(
      {
        requestId: `mode-deletion-${mode}`,
        workspaceId: f.workspaceId,
        sessionId: started.sessionId,
        mode,
      },
      "permission.set",
    );
  const latest = f.store
    .list(f.workspaceId)
    .records.findLast(({ record }) => record.permissionMode);
  f.store.noteDeletion(latest.record.recordId);
  const read = await f.handle(
    {
      requestId: "mode-deletion-read",
      workspaceId: f.workspaceId,
      sessionId: started.sessionId,
    },
    "permission.read",
  );
  assert.equal(read.mode, "manual");
});
