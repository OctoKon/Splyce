import { shellPeer, shellFixturePath } from "./fixtures/native-shell.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { ConfigAuthority } from "../packages/splyce-pi/dist/config.js";
import { createProviderProfiles } from "../packages/splyce-pi/dist/provider-profiles.js";
import { createNativeProviderSetup } from "../packages/splyce-pi/src/native-provider-setup.mjs";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";
import {
  actionArgumentsDigest,
  currentNativePolicyRevision,
} from "../packages/splyce-pi/dist/policy.js";
import { SessionMap } from "../packages/splyce-pi/dist/session-map.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSplyceOwner } from "../vendor/pi/packages/agent/dist/splyce-readiness.js";
import { acquireNativeSessionWriter } from "../packages/splyce-pi/src/native-session-writer.mjs";
import { captureNativeSnapshot } from "../packages/splyce-pi/src/native-snapshots.mjs";
import {
  createNativeArgumentsArtifact,
  commitNativePromptAdmission,
  createNativeSessionFactory,
  resolveNativeSessionSelection,
  stageNativeTaskArtifact,
} from "../packages/splyce-pi/src/native-session-factory.mjs";

function fixture(
  t,
  chat,
  endpoint = "https://example.test/v1",
  apiFamily = "openai-completions",
  locality = "hosted",
  seedCapability = true,
  nativeHostLayout = false,
) {
  // The admitted workspace must be the on-disk long form: native-host resolves it
  // with realpathSync.native on every context read and fails NATIVE_WORKSPACE_CHANGED
  // when the admitted spelling keeps an 8.3 short name (C:\Users\MOHAMM~1\...).
  const appDataDir = realpathSync.native(
    mkdtempSync(join(tmpdir(), "splyce-session-selection-")),
  );
  const dir = nativeHostLayout ? join(appDataDir, "splyce") : appDataDir;
  mkdirSync(dir, { recursive: true });
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  const store = Store.open(join(dir, "store.db"));
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    store.close();
    rmSync(appDataDir, { recursive: true, force: true });
  });
  const caller = {
    sessionId: "setup",
    configRevision: "cfg-0",
    profileRevision: "cfg-0",
    policyRevision: "0",
    resolveReference: (ref, scope) =>
      ref === scope ||
      store
        .list(scope)
        .records.some(
          ({ record }) =>
            record.recordId === ref ||
            record.artifactId === ref ||
            record.profileId === ref ||
            record.providerConnectionId === ref ||
            (record.endpointId &&
              `${record.endpointId}@${record.revision}` === ref),
        ),
  };
  const stat = statSync(cwd, { bigint: true });
  const workspace = store.admitWorkspace(
    {
      canonicalPath: cwd,
      volumeSerial: String(stat.dev),
      fileId: String(stat.ino),
    },
    caller,
  );
  const metadata = {
    requestId: "request1",
    workspaceId: workspace.workspaceId,
    providerConnectionId: "conn1",
    profileId: "profile1",
    apiFamily,
    endpoint,
    locality,
    chat,
    accountScopeRef: "provider-default",
    expectedConnectionRevision: null,
    expectedProfileRevision: null,
    expectedEndpointRevision: null,
    credentialKind: "new",
  };
  const setup = createNativeProviderSetup(store, dir);
  const prepared = setup.prepare(metadata);
  setup.commit({ metadata, credentialRef: prepared.credentialRef });
  const connection = store
    .readSetupState(workspace.workspaceId)
    .records.find(({ kind }) => kind === "providerConnection").record;
  const providerCapability = {
    capabilityId: `provider.${connection.apiFamily}`,
    capabilityVersion: connection.adapterRevision,
  };
  const capabilityDescriptor = {
    kind: "native-provider-capability",
    ...providerCapability,
    apiFamily: connection.apiFamily,
    implementation: "NativeProviderRequests",
  };
  const capabilityBytes = JSON.stringify(capabilityDescriptor);
  const registerCapability = () =>
    store.append(
      {
        kind: "artifact",
        record: {
          schemaVersion: 1,
          recordId: providerCapability.capabilityId,
          scopeId: workspace.workspaceId,
          createdAt: new Date().toISOString(),
          sourceIds: [],
          artifactId: providerCapability.capabilityId,
          digest: `sha256:${createHash("sha256").update(capabilityBytes).digest("hex")}`,
          mediaType: "application/vnd.splyce.provider-capability+json",
          byteLength: Buffer.byteLength(capabilityBytes),
          retentionClass: "workspace",
          descriptor: capabilityDescriptor,
        },
      },
      caller,
    );
  if (seedCapability) registerCapability();
  const config = new ConfigAuthority(store);
  const profiles = createProviderProfiles({ store, config });
  for (const id of ["intent1", "change1"]) {
    const bytes = Buffer.from("{}");
    writeFileSync(join(dir, `${id}.json`), bytes);
    store.append(
      {
        kind: "artifact",
        record: {
          schemaVersion: 1,
          recordId: id,
          scopeId: workspace.workspaceId,
          createdAt: new Date().toISOString(),
          sourceIds: [],
          artifactId: id,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          mediaType: "application/json",
          byteLength: bytes.length,
          retentionClass: "workspace",
          locationRef: id,
        },
      },
      caller,
    );
  }
  profiles.select(
    {
      scopeId: workspace.workspaceId,
      profileId: "profile1",
      profileRevision: "p1",
      expectedConfigRevision: "cfg-0",
      acceptedConfigRevision: "cfg-1",
      transitionId: "transition1",
      intentRef: "intent1",
      changedValuesArtifactId: "change1",
    },
    caller,
  );
  const input = {
    store,
    profiles,
    directory: dir,
    workspaceId: workspace.workspaceId,
    profileId: "profile1",
    profileRevision: "p1",
  };
  return {
    store,
    input,
    path: join(dir, "store.db"),
    appDataDir,
    dir,
    caller,
    cleanup,
    providerCapability,
    registerCapability,
  };
}

test("real Pi preparation binds only the committed preview and publishes its real tree", async (t) => {
  const {
    store,
    input,
    dir,
    caller,
    cleanup,
    providerCapability,
    registerCapability,
  } = fixture(
    t,
    {
      modelId: "model1",
      model: { contextWindow: 8192, maxOutputTokens: 1024 },
    },
    undefined,
    undefined,
    undefined,
    false,
  );
  let control,
    statusCalls = 0;
  control = new NativeControl(async ({ native }) => {
    if (native.method === "credential.status") statusCalls++;
    control.accept({
      native: {
        id: native.id,
        ok: true,
        value:
          native.method === "credential.status"
            ? { present: true }
            : { text: native.params.text, redactedCount: 0 },
      },
    });
  });
  t.after(() => control.shutdown());
  let capabilityResolutions = 0;
  const factory = createNativeSessionFactory({
    store,
    profiles: input.profiles,
    control,
    directory: dir,
    currentPolicyRevision: currentNativePolicyRevision,
    providerCapability(selected) {
      capabilityResolutions++;
      assert.equal(selected.state.workspace.workspaceId, input.workspaceId);
      assert.equal(
        selected.connection.adapterRevision,
        providerCapability.capabilityVersion,
      );
      if (
        !store
          .readSetupState(input.workspaceId)
          .records.some(
            ({ record }) => record.recordId === providerCapability.capabilityId,
          )
      )
        registerCapability();
      return providerCapability;
    },
  });
  assert.equal(factory.hasReadySession, false);
  const request = {
    requestId: "start1",
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    expectedConfigRevision: "cfg-1",
  };
  const before = store.cursor();
  const value = await factory.prepare({
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    profileRevision: input.profileRevision,
    requestId: request.requestId,
  });
  assert.equal(capabilityResolutions, 1);
  cleanup.push(() => factory.dispose(value));
  t.after(() => factory.dispose(value));
  assert.equal(store.cursor(), before + 1);
  await assert.rejects(() => factory.bind(value), {
    code: "NATIVE_SESSION_UNAVAILABLE",
  });
  assert.equal(statusCalls, 0);
  assert.equal(store.cursor(), before + 1);
  const capture = store.prepareNativeSessionSetup("session.start", request);
  const commit = store.commitNativeSessionStart(
    capture,
    { piSessionId: value.piSessionId, branchAnchor: value.branchAnchor },
    caller,
    currentNativePolicyRevision,
  );
  assert.equal(commit.result.sessionId, value.piSessionId);
  assert.deepEqual(commit.branchAnchor, value.branchAnchor);
  const committedCursor = store.cursor();
  await factory.bind(value);
  assert.ok(statusCalls > 0, "the genuine native provider was initialized");
  assert.equal(factory.hasReadySession, true);
  assert.deepEqual(factory.subscribe(value.piSessionId, 0), {
    sessionId: value.piSessionId,
    scopeId: input.workspaceId,
    afterSeq: 0,
  });
  const replay = factory.drainEvents(value.piSessionId);
  const tree = replay.frames.find(
    (event) => event.kind === "session.tree_updated",
  );
  assert.equal(tree.payload.sessionId, value.piSessionId);
  assert.equal(tree.scopeId, input.workspaceId);
  assert.ok(store.cursor() > committedCursor);
  store.assertNativeSessionStartCurrent({
    workspaceId: input.workspaceId,
    sessionId: value.piSessionId,
    sessionRevision: commit.result.sessionRevision,
  });
  const afterBound = store.cursor();
  await assert.rejects(
    () =>
      factory.restore({
        workspaceId: input.workspaceId,
        piSessionId: value.piSessionId,
        branchAnchor: value.branchAnchor,
      }),
    { code: "NATIVE_SESSION_UNAVAILABLE" },
  );
  assert.equal(store.cursor(), afterBound);
  store.noteDeletion("provider.openai-completions");
  assert.equal(factory.hasReadySession, false);
  await factory.dispose(value);
  await factory.dispose(value);
});

test("bind without a private capability declaration stays unavailable", async (t) => {
  const { store, input, dir, caller, cleanup } = fixture(t, {
    modelId: "model1",
    model: { contextWindow: 8192, maxOutputTokens: 1024 },
  });
  let statusCalls = 0;
  let control;
  control = new NativeControl(async ({ native }) => {
    if (native.method === "credential.status") statusCalls++;
    control.accept({
      native: {
        id: native.id,
        ok: true,
        value:
          native.method === "credential.status"
            ? { present: true }
            : { text: native.params.text, redactedCount: 0 },
      },
    });
  });
  t.after(() => control.shutdown());
  const factory = createNativeSessionFactory({
    store,
    profiles: input.profiles,
    control,
    directory: dir,
    currentPolicyRevision: currentNativePolicyRevision,
  });
  const request = {
    requestId: "missing-cap",
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    expectedConfigRevision: "cfg-1",
  };
  const capture = store.prepareNativeSessionSetup("session.start", request);
  const value = await factory.prepare({
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    profileRevision: input.profileRevision,
    requestId: request.requestId,
  });
  cleanup.push(() => factory.dispose(value));
  store.commitNativeSessionStart(
    capture,
    { piSessionId: value.piSessionId, branchAnchor: value.branchAnchor },
    caller,
    currentNativePolicyRevision,
  );
  await assert.rejects(() => factory.bind(value), {
    code: "NATIVE_SESSION_UNAVAILABLE",
  });
  assert.equal(statusCalls, 0);
  assert.equal(factory.hasReadySession, false);
  await factory.dispose(value);
});

test("prepared owner fails closed if deletion epoch changes", async (t) => {
  const { store, input, dir, cleanup } = fixture(t, {
    modelId: "model1",
    model: { contextWindow: 8192, maxOutputTokens: 1024 },
  });
  let control;
  control = new NativeControl(async ({ native }) =>
    control.accept({
      native: {
        id: native.id,
        ok: true,
        value:
          native.method === "credential.status"
            ? { present: true }
            : { text: native.params.text, redactedCount: 0 },
      },
    }),
  );
  t.after(() => control.shutdown());
  const factory = createNativeSessionFactory({
    store,
    profiles: input.profiles,
    control,
    directory: dir,
    currentPolicyRevision: currentNativePolicyRevision,
    providerCapability: {
      capabilityId: "provider.openai-completions",
      capabilityVersion:
        resolveNativeSessionSelection(input).connection.adapterRevision,
    },
  });
  const value = await factory.prepare({
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    profileRevision: input.profileRevision,
    requestId: "epoch1",
  });
  cleanup.push(() => factory.dispose(value));
  store.noteDeletion("intent1");
  const cursor = store.cursor();
  await assert.rejects(() => factory.bind(value), {
    code: "NATIVE_SESSION_UNAVAILABLE",
  });
  assert.equal(store.cursor(), cursor);
  await factory.dispose(value);
});

test("prepared owner rechecks policy revision after preparation", async (t) => {
  const { store, input, dir, cleanup } = fixture(t, {
    modelId: "model1",
    model: { contextWindow: 8192, maxOutputTokens: 1024 },
  });
  let changed = false;
  const currentPolicyRevision = (scope) =>
    changed ? "1" : currentNativePolicyRevision(scope);
  let control;
  control = new NativeControl(async ({ native }) =>
    control.accept({
      native: {
        id: native.id,
        ok: true,
        value:
          native.method === "credential.status"
            ? { present: true }
            : { text: native.params.text, redactedCount: 0 },
      },
    }),
  );
  t.after(() => control.shutdown());
  const factory = createNativeSessionFactory({
    store,
    profiles: input.profiles,
    control,
    directory: dir,
    currentPolicyRevision,
  });
  const value = await factory.prepare({
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    profileRevision: input.profileRevision,
    requestId: "policy-fence",
  });
  cleanup.push(() => factory.dispose(value));
  changed = true;
  const before = store.cursor();
  await assert.rejects(() => factory.bind(value), {
    code: "NATIVE_SESSION_UNAVAILABLE",
  });
  assert.equal(store.cursor(), before);
  await factory.dispose(value);
});

test("restore preserves the committed start anchor and reconciles the actual later Pi leaf", async (t) => {
  const { store, input, dir, caller, cleanup } = fixture(t, {
    modelId: "model1",
    model: { contextWindow: 8192, maxOutputTokens: 1024 },
  });
  let control;
  control = new NativeControl(async ({ native }) =>
    control.accept({
      native: {
        id: native.id,
        ok: true,
        value:
          native.method === "inventory.capture"
            ? {
                manifest: {
                  tracked: [],
                  untracked: [],
                  links: [],
                  excluded: [],
                },
              }
            : native.method === "credential.status"
              ? { present: true }
              : { text: native.params.text, redactedCount: 0 },
      },
    }),
  );
  t.after(() => control.shutdown());
  const sessionDir = join(
    dir,
    "sessions",
    createHash("sha256").update(input.workspaceId).digest("hex"),
  );
  mkdirSync(sessionDir, { recursive: true });
  let committed, priorLease;
  const owner = createSplyceOwner(() => {
    const workspace = store.getWorkspace(input.workspaceId);
    const actual = statSync(workspace.canonicalPath, { bigint: true });
    assert.equal(String(actual.dev), workspace.volumeSerial);
    assert.equal(String(actual.ino), workspace.fileId);
    priorLease?.assertCurrent();
    if (committed)
      store.assertNativeSessionStartCurrent({
        workspaceId: input.workspaceId,
        sessionId: committed.result.sessionId,
        sessionRevision: committed.result.sessionRevision,
      });
  });
  const manager = await SessionManager.createOwned(
    store.getWorkspace(input.workspaceId).canonicalPath,
    (subject) =>
      owner.bindPersistence(
        subject,
        async (text, signal) => (await control.redact(text, signal)).text,
      ),
    sessionDir,
  );
  priorLease = acquireNativeSessionWriter(manager.getSessionFile());
  cleanup.push(() => priorLease.close());
  t.after(() => priorLease.close());
  const piSessionId = manager.getSessionId();
  const key = { scopeId: input.workspaceId, sessionId: piSessionId };
  const map = new SessionMap(store, {
    configRevision: "cfg-1",
    profileRevision: "p1",
    policyRevision: "0",
    resolveReference(ref, scope) {
      return (
        scope === input.workspaceId &&
        (ref === scope ||
          ref === piSessionId ||
          manager.getEntries().some((entry) => entry.id === ref) ||
          store
            .list(scope)
            .records.some(
              ({ record }) =>
                record.recordId === ref ||
                record.artifactId === ref ||
                record.branchAnchorId === ref,
            ))
      );
    },
  });
  const historical = map.preview(key, manager).anchor;
  const request = {
    requestId: "restore1",
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    expectedConfigRevision: "cfg-1",
  };
  const capture = store.prepareNativeSessionSetup("session.start", request);
  committed = store.commitNativeSessionStart(
    capture,
    { piSessionId, branchAnchor: historical },
    caller,
    currentNativePolicyRevision,
  );
  const assertCurrent = () =>
    store.assertNativeSessionStartCurrent({
      workspaceId: input.workspaceId,
      sessionId: piSessionId,
      sessionRevision: committed.result.sessionRevision,
    });
  const selected = resolveNativeSessionSelection(input);
  const snapshot = await captureNativeSnapshot({
    store,
    workspace: selected.state.workspace,
    caller: { ...caller, scopeId: input.workspaceId, sessionId: piSessionId },
    assertCurrent,
    control,
  });
  const task = await stageNativeTaskArtifact({
    control,
    directory: dir,
    workspaceId: input.workspaceId,
    text: "redacted user request",
    assertCurrent,
  });
  const ownership = store.acquireWorkspace(input.workspaceId, piSessionId);
  const beforeAdmission = store.cursor();
  const admission = commitNativePromptAdmission({
    store,
    selected,
    committed,
    manager,
    sessionMap: map,
    task,
    snapshot,
    ownership,
    assertCurrent,
    policyRevision: currentNativePolicyRevision(input.workspaceId),
  });
  assert.equal(store.cursor(), beforeAdmission + 2);
  assert.equal(
    store.get(admission.runRecordId).record.taskArtifactId,
    task.record.artifactId,
  );
  assert.equal(
    store.get(admission.runRecordId).record.baseSnapshotId,
    snapshot.recordId,
  );
  assert.equal(store.get(task.record.recordId).kind, "artifact");
  const staleTask = await stageNativeTaskArtifact({
    control,
    directory: dir,
    workspaceId: input.workspaceId,
    text: "stale request",
    assertCurrent,
  });
  const staleSelection = {
    ...selected,
    effective: { ...selected.effective, configRevision: "cfg-stale" },
  };
  const beforeStale = store.cursor();
  assert.throws(() =>
    commitNativePromptAdmission({
      store,
      selected: staleSelection,
      committed,
      manager,
      sessionMap: map,
      task: staleTask,
      snapshot,
      ownership,
      assertCurrent,
      policyRevision: currentNativePolicyRevision(input.workspaceId),
    }),
  );
  assert.equal(store.cursor(), beforeStale);
  assert.throws(() => store.get(staleTask.record.recordId));
  store.releaseWorkspace(input.workspaceId, piSessionId, ownership.epoch);
  await manager.withPersistence((draft) =>
    draft.appendMessage({
      role: "user",
      content: [{ type: "text", text: "later entry" }],
      timestamp: 0,
    }),
  );
  const forkPoint = manager.getLeafId();
  await manager.withPersistence((draft) =>
    draft.appendMessage({
      role: "user",
      content: [{ type: "text", text: "other branch" }],
      timestamp: 1,
    }),
  );
  await manager.withPersistence((draft) => draft.branch(forkPoint));
  await manager.withPersistence((draft) =>
    draft.appendMessage({
      role: "user",
      content: [{ type: "text", text: "selected branch" }],
      timestamp: 2,
    }),
  );
  const leaf = manager.getLeafId();
  assert.ok(leaf);
  const activeAnchor = map.preview(key, manager).anchor;
  owner.dispose();
  priorLease.close();
  const factory = createNativeSessionFactory({
    store,
    profiles: input.profiles,
    control,
    directory: dir,
    currentPolicyRevision: currentNativePolicyRevision,
    providerCapability: {
      capabilityId: "provider.openai-completions",
      capabilityVersion:
        resolveNativeSessionSelection(input).connection.adapterRevision,
    },
  });
  const value = await factory.restore({
    workspaceId: input.workspaceId,
    piSessionId,
    branchAnchor: historical,
  });
  cleanup.push(() => factory.dispose(value));
  t.after(() => factory.dispose(value));
  assert.deepEqual(value.branchAnchor, historical);
  await factory.bind(value);
  const anchors = store
    .list(input.workspaceId, 0, piSessionId)
    .records.filter(({ kind }) => kind === "branchAnchor");
  assert.ok(anchors.length >= 3);
  assert.ok(
    anchors.some(
      ({ record }) =>
        record.branchAnchorId === activeAnchor.branchAnchorId &&
        record.activeLeafEntryId === leaf,
    ),
  );
  assert.equal(
    anchors[0].record.activeLeafEntryId,
    historical.activeLeafEntryId,
  );
  store.assertNativeSessionStartCurrent({
    workspaceId: input.workspaceId,
    sessionId: piSessionId,
    sessionRevision: committed.result.sessionRevision,
  });
  await factory.dispose(value);
});

test(
  "public factory prompt acknowledges before a genuine native HTTP effect completes",
  { timeout: 20000 },
  async (t) => {
    let entered,
      release,
      enteredSecond,
      releaseSecond,
      closeEntered,
      releaseClose,
      enteredThird,
      enteredFourth,
      releaseFourth,
      closingFourth,
      releaseFourthClose;
    const incoming = new Promise((resolve) => {
      entered = resolve;
    });
    const responseGate = new Promise((resolve) => {
      release = resolve;
    });
    const incomingSecond = new Promise((resolve) => {
      enteredSecond = resolve;
    });
    const secondGate = new Promise((resolve) => {
      releaseSecond = resolve;
    });
    const closing = new Promise((resolve) => {
      closeEntered = resolve;
    });
    const closeGate = new Promise((resolve) => {
      releaseClose = resolve;
    });
    const incomingThird = new Promise((resolve) => {
      enteredThird = resolve;
    });
    const incomingFourth = new Promise((resolve) => {
      enteredFourth = resolve;
    });
    const fourthGate = new Promise((resolve) => {
      releaseFourth = resolve;
    });
    const fourthClosing = new Promise((resolve) => {
      closingFourth = resolve;
    });
    const fourthCloseGate = new Promise((resolve) => {
      releaseFourthClose = resolve;
    });
    let body,
      observedRunning = false,
      requests = 0,
      closed = false;
    const server = createServer(async (req, res) => {
      requests++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      observedRunning = store
        .list(input.workspaceId)
        .records.some(
          ({ kind, record }) => kind === "action" && record.state === "running",
        );
      const event = (delta, finish_reason = null) =>
        `data: ${JSON.stringify({ id: "chat-fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      if (requests === 3) {
        res.writeHead(500, { "content-type": "text/event-stream" });
        res.end("data: failure\n\n");
        enteredThird();
        return;
      }
      if (requests === 4) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(event({ role: "assistant", content: "partial" }));
        enteredFourth();
        await fourthGate;
        if (!res.destroyed) res.end(event({}, "stop") + "data: [DONE]\n\n");
        return;
      }
      if (requests === 2) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(event({ role: "assistant", content: "partial" }));
        enteredSecond();
        await secondGate;
        if (!res.destroyed) res.end(event({}, "stop") + "data: [DONE]\n\n");
        return;
      }
      entered();
      await responseGate;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        event({ role: "assistant", content: "hello from provider" }) +
          event({}, "stop") +
          "data: [DONE]\n\n",
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      release();
      releaseSecond();
      releaseClose();
      releaseFourth();
      releaseFourthClose();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const { store, input, dir, caller, cleanup, providerCapability } = fixture(
      t,
      {
        modelId: "fixture-model",
        model: { contextWindow: 8192, maxOutputTokens: 1024 },
      },
      `http://127.0.0.1:${server.address().port}/v1`,
      "openai-completions",
      "loopback",
    );
    const fixtureCredential = `fixture-${crypto.randomUUID()}`;
    let scopeCloses = 0;
    let control;
    control = new NativeControl(async ({ native }) => {
      let value;
      if (native.method === "credential.status") value = { present: true };
      else if (native.method === "inventory.capture")
        value = {
          manifest: { tracked: [], untracked: [], links: [], excluded: [] },
        };
      else if (native.method === "credential.redact") {
        const text = native.params.text
          .split(fixtureCredential)
          .join("[redacted]");
        value = { text, redactedCount: text === native.params.text ? 0 : 1 };
      } else if (native.method === "credential.read")
        value = { secret: fixtureCredential };
      else if (native.method === "credential.scope.open") value = {};
      else if (native.method === "credential.scope.close") {
        scopeCloses++;
        if (scopeCloses === 2) {
          closeEntered();
          await closeGate;
        }
        if (scopeCloses === 4) {
          closingFourth();
          await fourthCloseGate;
        }
        closed = true;
        value = {};
      } else throw new Error("unexpected fixture method");
      control.accept({ native: { id: native.id, ok: true, value } });
    });
    t.after(() => control.shutdown());
    const factory = createNativeSessionFactory({
      store,
      profiles: input.profiles,
      control,
      directory: dir,
      currentPolicyRevision: currentNativePolicyRevision,
      providerCapability,
    });
    const start = {
      requestId: "prompt-start",
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      expectedConfigRevision: "cfg-1",
    };
    const capture = store.prepareNativeSessionSetup("session.start", start);
    const value = await factory.prepare({
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      profileRevision: input.profileRevision,
      requestId: start.requestId,
    });
    cleanup.push(() => factory.dispose(value));
    store.commitNativeSessionStart(
      capture,
      { piSessionId: value.piSessionId, branchAnchor: value.branchAnchor },
      caller,
      currentNativePolicyRevision,
    );
    await factory.bind(value);
    assert.equal(factory.hasReadySession, true);
    factory.subscribe(value.piSessionId, 0);
    assert.ok(
      factory
        .drainEvents(value.piSessionId)
        .frames.some((event) => event.kind === "session.tree_updated"),
    );
    let wake, earlyFailure;
    const early = new Promise((_, reject) => {
      earlyFailure = reject;
    });
    let ackReceived = false;
    const events = [];
    const collect = () => {
      if (!ackReceived) return;
      try {
        events.push(...factory.drainEvents(value.piSessionId).frames);
        const failed = events.find((event) => event.kind === "turn.failed");
        if (failed)
          earlyFailure(
            new Error(
              `run failed before HTTP: ${JSON.stringify(failed.payload)}; ${JSON.stringify(store.list(input.workspaceId).records.map(({ kind, record }) => ({ kind, state: record.state, effectState: record.effectState })))}`,
            ),
          );
      } catch (error) {
        earlyFailure(error);
      }
    };
    const detach = factory.onEvents(() => {
      collect();
      if (wake) {
        const notify = wake;
        wake = undefined;
        notify();
      }
    });
    t.after(detach);
    const command = {
      protocolVersion: 2,
      correlationId: "prompt1",
      sessionId: value.piSessionId,
      scopeId: input.workspaceId,
      expectedConfigRevision: "cfg-1",
      expectedProfileRevision: "p1",
      expectedPolicyRevision: currentNativePolicyRevision(input.workspaceId),
      op: "session.prompt",
      payload: { text: `hello user ${fixtureCredential}` },
    };
    const ack = await factory.preparePrompt(command);
    assert.equal(ack.accepted, true);
    assert.ok(ack.runId && ack.turnId);
    ackReceived = true;
    collect();
    await Promise.race([incoming, early]);
    assert.equal(
      events.find((event) => event.kind === "turn.started").payload.userPrompt,
      "hello user [redacted]",
    );
    assert.equal(observedRunning, true);
    assert.equal(closed, false);
    assert.equal(
      body.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("hello user"),
      ),
      true,
    );
    release();
    while (
      !events.some((event) =>
        ["turn.completed", "turn.failed", "turn.canceled"].includes(event.kind),
      )
    ) {
      const drained = factory.drainEvents(value.piSessionId);
      events.push(...drained.frames);
      if (
        !events.some((event) =>
          ["turn.completed", "turn.failed", "turn.canceled"].includes(
            event.kind,
          ),
        )
      )
        await new Promise((resolve) => {
          wake = resolve;
        });
    }
    assert.equal(events.at(-1).kind, "turn.completed");
    assert.equal(
      events.some(
        (event) =>
          event.kind === "turn.stream_delta" &&
          event.payload.delta.includes("hello from provider"),
      ),
      true,
    );
    assert.equal(requests, 1);
    assert.equal(closed, true);
    assert.ok(
      store
        .list(input.workspaceId)
        .records.some(
          ({ kind, record }) =>
            kind === "outcome" && record.effectState === "observed-success",
        ),
    );
    const second = await factory.preparePrompt({
      ...command,
      correlationId: "prompt2",
      payload: { text: "cancel request" },
    });
    assert.equal(second.accepted, true);
    await incomingSecond;
    assert.deepEqual(
      body.messages
        .filter((message) => ["user", "assistant"].includes(message.role))
        .map((message) => [
          message.role,
          typeof message.content === "string"
            ? message.content
            : message.content.map((block) => block.text ?? "").join(""),
        ]),
      [
        ["user", "hello user [redacted]"],
        ["assistant", "hello from provider"],
        ["user", "cancel request"],
      ],
    );
    let cancellationSettled = false;
    const cancellation = factory.cancel({
      sessionId: value.piSessionId,
      reason: "user",
    });
    void cancellation.then(
      () => {
        cancellationSettled = true;
      },
      () => {
        cancellationSettled = true;
      },
    );
    await closing;
    assert.equal(cancellationSettled, false);
    releaseClose();
    releaseSecond();
    assert.deepEqual(await cancellation, { canceled: true });
    assert.equal(requests, 2);
    assert.equal(store.workspaceOwner(input.workspaceId), undefined);
    const cancellationRecords = store.list(input.workspaceId).records;
    const interruptedAction = cancellationRecords.findLast(
      ({ kind, record }) => kind === "action" && record.runId === second.runId,
    )?.record;
    assert.ok(interruptedAction);
    assert.ok(
      cancellationRecords.some(
        ({ kind, record }) =>
          kind === "outcome" &&
          record.actionId === interruptedAction.actionId &&
          record.effectState === "uncertain",
      ),
    );
    collect();
    assert.ok(
      events.some(
        (event) =>
          event.kind === "turn.canceled" &&
          event.payload.runId === second.runId &&
          event.payload.cleanedUp === true,
      ),
    );
    const third = await factory.preparePrompt({
      ...command,
      correlationId: "prompt3",
      payload: { text: "server failure" },
    });
    await incomingThird;
    while (
      !events.some(
        (event) =>
          event.kind === "turn.failed" && event.payload.runId === third.runId,
      )
    ) {
      collect();
      if (
        !events.some(
          (event) =>
            event.kind === "turn.failed" && event.payload.runId === third.runId,
        )
      )
        await new Promise((resolve) => {
          wake = resolve;
        });
    }
    assert.equal(requests, 3, "non-2xx response is not retried");
    assert.equal(
      events.some(
        (event) =>
          event.kind === "turn.completed" &&
          event.payload.runId === third.runId,
      ),
      false,
    );
    const failedRecords = store.list(input.workspaceId).records;
    const failedAction = failedRecords.findLast(
      ({ kind, record }) => kind === "action" && record.runId === third.runId,
    )?.record;
    assert.ok(failedAction);
    assert.ok(
      failedRecords.some(
        ({ kind, record }) =>
          kind === "outcome" &&
          record.actionId === failedAction.actionId &&
          record.effectState === "uncertain",
      ),
    );
    const fourth = await factory.preparePrompt({
      ...command,
      correlationId: "prompt4",
      payload: { text: "shutdown request" },
    });
    await incomingFourth;
    let disposalSettled = false;
    const disposal = factory.dispose(value);
    void disposal.then(
      () => {
        disposalSettled = true;
      },
      () => {
        disposalSettled = true;
      },
    );
    await fourthClosing;
    assert.equal(disposalSettled, false);
    releaseFourthClose();
    releaseFourth();
    await disposal;
    assert.equal(factory.hasReadySession, false);
    assert.equal(store.workspaceOwner(input.workspaceId), undefined);
    assert.equal(requests, 4);
    assert.equal(
      events.some(
        (event) =>
          event.kind === "turn.completed" &&
          event.payload.runId === fourth.runId,
      ),
      false,
    );
  },
);

test("task staging persists only redacted text and does not commit a run", async (t) => {
  const { store, input, dir } = fixture(t, {
    modelId: "model1",
    model: { contextWindow: 8192, maxOutputTokens: 1024 },
  });
  let control;
  control = new NativeControl(async ({ native }) => {
    const text = native.params.text.replace("sensitive", "[redacted]");
    control.accept({
      native: { id: native.id, ok: true, value: { text, redactedCount: 1 } },
    });
  });
  t.after(() => control.shutdown());
  const before = store.cursor();
  const task = await stageNativeTaskArtifact({
    control,
    directory: dir,
    workspaceId: input.workspaceId,
    text: "hello sensitive",
    assertCurrent() {
      resolveNativeSessionSelection(input);
    },
  });
  assert.equal(task.text, "hello [redacted]");
  assert.equal(store.cursor(), before);
  const file = join(dir, "tasks", `${task.record.digest.slice(7)}.json`);
  const bytes = readFileSync(file);
  assert.equal(bytes.includes("sensitive"), false);
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), { text: task.text });
  assert.equal(task.record.byteLength, bytes.length);
  task.verify();
  writeFileSync(file, "{}");
  assert.throws(() => task.verify());
});

test("actual native redaction control validates semantic units before writing exact argument bytes", async (t) => {
  const { store, input, dir, caller } = fixture(t, {
    modelId: "model1",
    model: { contextWindow: 8192, maxOutputTokens: 1024 },
  });
  let redact = false;
  let failRedaction = false;
  let calls = 0;
  let control;
  control = new NativeControl(async ({ native }) => {
    assert.equal(native.method, "credential.redact");
    calls++;
    if (failRedaction) {
      control.accept({
        native: {
          id: native.id,
          ok: false,
          error: { code: "PERSIST_REDACTION_UNAVAILABLE" },
        },
      });
      return;
    }
    const text = redact
      ? native.params.text.replace("sensitive", "[redacted]")
      : native.params.text;
    control.accept({
      native: {
        id: native.id,
        ok: true,
        value: { text, redactedCount: text === native.params.text ? 0 : 1 },
      },
    });
  });
  t.after(() => control.shutdown());
  const semantic = {
    schema: "splyce-provider-request-v1",
    apiFamily: "openai-completions",
    endpointRef: "endpoint1",
    model: "model1",
    context: {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    },
    options: { model: { id: "model1" } },
  };
  const args = {
    store,
    control,
    directory: dir,
    workspaceId: input.workspaceId,
    caller,
    semantic,
    assertCurrent() {
      const selected = resolveNativeSessionSelection(input);
      const actual = statSync(selected.state.workspace.canonicalPath, {
        bigint: true,
      });
      assert.equal(String(actual.dev), selected.state.workspace.volumeSerial);
      assert.equal(String(actual.ino), selected.state.workspace.fileId);
    },
  };
  const artifact = await createNativeArgumentsArtifact(args);
  assert.equal(calls, 4);
  assert.equal(artifact.digest, actionArgumentsDigest(semantic));
  assert.deepEqual(artifact.semantic, semantic);
  artifact.verify();
  const before = store.cursor();
  redact = true;
  semantic.context.messages[0].content = "sensitive";
  await assert.rejects(() => createNativeArgumentsArtifact(args), {
    code: "NATIVE_ARGUMENTS_UNAVAILABLE",
  });
  assert.equal(store.cursor(), before);
  redact = false;
  failRedaction = true;
  await assert.rejects(() => createNativeArgumentsArtifact(args), {
    code: "PERSIST_REDACTION_UNAVAILABLE",
  });
  assert.equal(store.cursor(), before);
  const controller = new AbortController();
  controller.abort();
  const previousCalls = calls;
  await assert.rejects(
    () => createNativeArgumentsArtifact({ ...args, signal: controller.signal }),
    { code: "NATIVE_ARGUMENTS_UNAVAILABLE" },
  );
  assert.equal(calls, previousCalls);
  assert.equal(store.cursor(), before);
  writeFileSync(
    join(dir, "arguments", `${artifact.digest.slice(7)}.json`),
    "{}",
  );
  assert.throws(() => artifact.verify());
});

for (const field of ["model", "endpointRef"]) {
  test(`argument metadata ${field} is redacted before any write`, async (t) => {
    const { store, input, dir, caller } = fixture(t, {
      modelId: "model1",
      model: { contextWindow: 8192, maxOutputTokens: 1024 },
    });
    let control;
    control = new NativeControl(async ({ native }) => {
      const text = native.params.text.replace("sensitive", "[redacted]");
      control.accept({
        native: {
          id: native.id,
          ok: true,
          value: { text, redactedCount: text === native.params.text ? 0 : 1 },
        },
      });
    });
    t.after(() => control.shutdown());
    const semantic = {
      schema: "splyce-provider-request-v1",
      apiFamily: "openai-completions",
      endpointRef: "endpoint1",
      model: "model1",
      context: { messages: [{ role: "user", content: "hello" }], tools: [] },
      options: { model: { id: "model1" } },
    };
    semantic[field] = "sensitive";
    const cursor = store.cursor();
    await assert.rejects(
      () =>
        createNativeArgumentsArtifact({
          store,
          control,
          directory: dir,
          workspaceId: input.workspaceId,
          caller,
          semantic,
          assertCurrent() {
            resolveNativeSessionSelection(input);
          },
        }),
      { code: "NATIVE_ARGUMENTS_UNAVAILABLE" },
    );
    assert.equal(store.cursor(), cursor);
    assert.equal(existsSync(join(dir, "arguments")), false);
  });
}

test("redaction suspension cannot publish arguments after selected authority is deleted", async (t) => {
  const { store, input, dir, caller } = fixture(t, {
    modelId: "model1",
    model: { contextWindow: 8192, maxOutputTokens: 1024 },
  });
  let reached, release;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let control;
  control = new NativeControl(async ({ native }) => {
    reached();
    await gate;
    control.accept({
      native: {
        id: native.id,
        ok: true,
        value:
          native.method === "credential.status"
            ? { present: true }
            : { text: native.params.text, redactedCount: 0 },
      },
    });
  });
  t.after(() => {
    release();
    control.shutdown();
  });
  const selected = resolveNativeSessionSelection(input);
  const descriptor = selected.state.records.find(
    ({ kind, record }) => kind === "artifact" && record.role === "chat",
  ).record;
  const semantic = {
    schema: "splyce-provider-request-v1",
    apiFamily: "openai-completions",
    endpointRef: "endpoint1",
    model: "model1",
    context: { messages: [{ role: "user", content: "hello" }], tools: [] },
    options: { model: { id: "model1" } },
  };
  const cursor = store.cursor();
  const pending = createNativeArgumentsArtifact({
    store,
    control,
    directory: dir,
    workspaceId: input.workspaceId,
    caller,
    semantic,
    assertCurrent() {
      resolveNativeSessionSelection(input);
    },
  });
  await entered;
  store.noteDeletion(descriptor.recordId);
  release();
  await assert.rejects(() => pending, { code: "NATIVE_SESSION_UNAVAILABLE" });
  assert.equal(store.cursor(), cursor);
});

test("real selected setup resolves exact user model and rejects removed descriptor", (t) => {
  const { store, input } = fixture(t, {
    modelId: "model1",
    model: { contextWindow: 8192, maxOutputTokens: 1024 },
  });
  const result = resolveNativeSessionSelection(input);
  assert.equal(result.model.provider, "conn1");
  assert.equal(result.model.baseUrl, "https://example.test/v1");
  assert.equal(result.model.maxTokens, 1024);
  assert.equal(result.descriptor.costKnown, false);
  assert.throws(() =>
    resolveNativeSessionSelection({ ...input, profileRevision: "p2" }),
  );
  const record = result.state.records.find(
    ({ kind, record }) => kind === "artifact" && record.role === "chat",
  ).record;
  store.noteDeletion(record.recordId);
  assert.throws(() => resolveNativeSessionSelection(input));
});

for (const kind of ["account", "limits", "egress"]) {
  test(`${kind} descriptor bytes must match the real artifact record`, (t) => {
    const { input, dir } = fixture(t, {
      modelId: "model1",
      model: { contextWindow: 8192, maxOutputTokens: 1024 },
    });
    const selected = resolveNativeSessionSelection(input);
    const id =
      kind === "account"
        ? selected.connection.accountScopeRef
        : kind === "limits"
          ? selected.profile.limitsArtifactId
          : selected.profile.egressPolicyRefs[0];
    const artifact = selected.state.records.find(
      ({ kind, record }) => kind === "artifact" && record.artifactId === id,
    ).record;
    const name = createHash("sha256").update(artifact.recordId).digest("hex");
    writeFileSync(join(dir, "setup-descriptors", `${name}.json`), "{}");
    assert.throws(() => resolveNativeSessionSelection(input));
  });
}

test("selected catalog metadata is rechecked against the pinned catalog", (t) => {
  const { input, path } = fixture(
    t,
    { modelId: "gpt-4o" },
    "https://api.openai.com/v1",
    "openai-responses",
  );
  const result = resolveNativeSessionSelection(input);
  assert.equal(result.model.id, "gpt-4o");
  assert.equal(result.descriptor.source, "catalog");
  assert.equal(result.model.provider, "conn1");
  assert.equal(result.descriptor.costKnown, false);
  const artifact = result.state.records.find(
    ({ kind, record }) => kind === "artifact" && record.role === "chat",
  ).record;
  const db = new DatabaseSync(path);
  const changed = structuredClone(artifact);
  changed.descriptor.catalogVersion = "forged-version";
  const json = JSON.stringify(changed.descriptor);
  changed.digest = `sha256:${createHash("sha256").update(json).digest("hex")}`;
  changed.byteLength = Buffer.byteLength(json);
  db.prepare("UPDATE records SET payload = ? WHERE record_id = ?").run(
    JSON.stringify(changed),
    artifact.recordId,
  );
  db.close();
  assert.throws(() => resolveNativeSessionSelection(input));
});

test("removing argument redaction rejection makes the real metadata regression fail", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "splyce-factory-mutant-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const loader = join(directory, "loader.mjs");
  const needle =
    "result.text !== serialized ||\n      result.redactedCount !== 0";
  writeFileSync(
    loader,
    `export async function load(url, context, next) { const result = await next(url, context); if (!url.endsWith('/packages/splyce-pi/src/native-session-factory.mjs')) return result; const source = result.source.toString(); if (source.includes('SPLYCE_TEST_GUARD_REMOVED')) return result; const needle = ${JSON.stringify(needle)}; if (source.split(needle).length !== 2) throw new Error('mutation target unavailable'); return { ...result, source: source.replace(needle, 'false /* SPLYCE_TEST_GUARD_REMOVED */') }; }`,
  );
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-loader",
      pathToFileURL(loader).href,
      "--test",
      "--test-name-pattern=argument metadata model",
      fileURLToPath(import.meta.url),
    ],
    { encoding: "utf8", timeout: 15000, windowsHide: true, env: childEnv },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout + result.stderr, /Missing expected rejection/u);
});

function composedHostSession(captureFails, permissionMode) {
  return async (t) => {
    let body;
    let requestCount = 0;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const event = (delta, finish_reason = null) =>
        `data: ${JSON.stringify({ id: "host-composition", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      const name = (
        permissionMode ? ["write", "edit"] : ["code_search", "memory_search"]
      )[requestCount++];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        (name
          ? event(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: `context-${requestCount}`,
                    type: "function",
                    function: {
                      name,
                      arguments: JSON.stringify(
                        name === "write"
                          ? { path: "automatic.txt", content: "one" }
                          : name === "edit"
                            ? {
                                path: "automatic.txt",
                                edits: [{ oldText: "one", newText: "two" }],
                              }
                            : { query: "nativeDemoMarker" },
                      ),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : event(
              { role: "assistant", content: "default host response" },
              "stop",
            )) + "data: [DONE]\n\n",
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const f = fixture(
      t,
      {
        modelId: "fixture-model",
        model: { contextWindow: 8192, maxOutputTokens: 1024 },
      },
      `http://127.0.0.1:${server.address().port}/v1`,
      "openai-completions",
      "loopback",
      false,
      true,
    );
    writeFileSync(
      join(f.dir, "workspace", "demo.ts"),
      "export function nativeDemoMarker() { return 1; }\n",
    );
    // Explicit synthetic private protocol responses; this does not qualify Rust or Credential Manager.
    let control;
    control = new NativeControl(async ({ native }) => {
      let value;
      if (native.method === "credential.status") value = { present: true };
      else if (native.method === "inventory.capture")
        value = {
          manifest: { tracked: [], untracked: [], links: [], excluded: [] },
        };
      else if (native.method === "credential.redact")
        value = { text: native.params.text, redactedCount: 0 };
      else if (native.method === "credential.read")
        value = { secret: "synthetic-loopback-credential" };
      else if (
        ["credential.scope.open", "credential.scope.close"].includes(
          native.method,
        )
      )
        value = {};
      else throw new Error(`Unexpected native method: ${native.method}`);
      control.accept({ native: { id: native.id, ok: true, value } });
    });
    const host = createNativeHost(f.appDataDir, control);
    f.cleanup.push(async () => {
      await host.shutdown();
      control.shutdown();
    });
    assert.deepEqual(host.handshakeReadiness.ports, {
      generation: false,
      provider: false,
      workspace: false,
      modules: false,
    });
    assert.equal(
      f.store
        .list(f.input.workspaceId)
        .records.some(
          ({ record }) =>
            record.mediaType ===
            "application/vnd.splyce.provider-capability+json",
        ),
      false,
    );
    const selected = await host.selectProfile(
      {
        requestId: "default-host-select",
        workspaceId: f.input.workspaceId,
        profileId: f.input.profileId,
        expectedProfileRevision: "p1",
        expectedConfigRevision: "cfg-1",
      },
      "default-host-select",
    );
    const started = await host.startSession(
      {
        requestId: "default-host-start",
        workspaceId: f.input.workspaceId,
        profileId: selected.selectedProfileId,
        expectedConfigRevision: selected.configRevision,
      },
      "default-host-start",
    );
    assert.deepEqual(started.readiness, { state: "ready" });
    if (permissionMode)
      await host.setPermission(
        {
          requestId: "loaded-mode",
          workspaceId: f.input.workspaceId,
          sessionId: started.sessionId,
          mode: permissionMode,
        },
        "loaded-mode",
      );
    assert.equal(
      started.policyRevision,
      currentNativePolicyRevision(f.input.workspaceId),
    );
    const queued = {
      configRevision: selected.configRevision,
      profileRevision: selected.profileRevision,
      policyRevision: started.policyRevision,
    };
    assert.doesNotThrow(() => host.assertCurrent(f.input.workspaceId, queued));
    assert.throws(
      () =>
        host.assertCurrent(f.input.workspaceId, {
          ...queued,
          policyRevision: "stale",
        }),
      { code: "STALE_REVISION" },
    );
    assert.throws(
      () =>
        host.assertCurrent(
          "unbound-workspace",
          host.current("unbound-workspace"),
        ),
      { code: "STALE_REVISION" },
    );
    const memoryPath = join(
      f.dir,
      "memory",
      createHash("sha256").update(f.input.workspaceId).digest("hex"),
      "memory.db",
    );
    await host.memoryFor(f.input.workspaceId);
    const memoryDb = new DatabaseSync(memoryPath);
    f.cleanup.push(() => memoryDb.close());
    if (captureFails)
      memoryDb.exec(
        "CREATE TRIGGER fail_capture BEFORE INSERT ON observations BEGIN SELECT RAISE(FAIL, 'capture unavailable'); END",
      );
    assert.deepEqual(host.handshakeReadiness.ports, {
      generation: true,
      provider: true,
      workspace: true,
      modules: false,
    });
    const capabilities = f.store
      .list(f.input.workspaceId)
      .records.filter(
        ({ record }) =>
          record.mediaType ===
          "application/vnd.splyce.provider-capability+json",
      );
    assert.equal(capabilities.length, 1);
    assert.equal(
      capabilities[0].record.descriptor.apiFamily,
      "openai-completions",
    );
    host.subscribeSession(started.sessionId, 0);
    const events = [];
    let settle;
    const terminal = new Promise((resolve) => {
      settle = resolve;
    });
    const collect = () => {
      events.push(...host.drainSessionEvents(started.sessionId).frames);
      const result = events.find((event) =>
        ["turn.completed", "turn.failed", "turn.canceled"].includes(event.kind),
      );
      if (result) settle(result);
    };
    const detach = host.onSessionEvents(collect);
    f.cleanup.push(detach);
    const ack = await host.preparePrompt({
      protocolVersion: 2,
      correlationId: "default-host-prompt",
      sessionId: started.sessionId,
      scopeId: f.input.workspaceId,
      expectedConfigRevision: selected.configRevision,
      expectedProfileRevision: selected.profileRevision,
      expectedPolicyRevision: started.policyRevision,
      op: "session.prompt",
      payload: { text: "hello default host" },
    });
    assert.equal(ack.accepted, true);
    collect();
    assert.equal((await terminal).kind, "turn.completed");
    const names = body.tools.map((tool) => tool.function.name);
    assert.ok(names.includes("code_search"));
    assert.ok(names.includes("memory_search"));
    const results = body.messages.filter((message) => message.role === "tool");
    assert.equal(results.length, 2);
    if (permissionMode) {
      assert.equal(
        readFileSync(join(f.dir, "workspace", "automatic.txt"), "utf8"),
        "two",
      );
      assert.equal(
        events.filter((event) => event.kind === "approval.requested").length,
        0,
      );
      const completed = f.store
        .list(f.input.workspaceId)
        .records.filter(
          ({ kind, record }) =>
            kind === "action" &&
            record.state === "completed" &&
            ["workspace.write", "workspace.edit"].includes(record.capabilityId),
        );
      assert.equal(completed.length, 2);
      assert.ok(
        completed.every(
          ({ record }) => record.approvedBy === `mode:${permissionMode}`,
        ),
      );
    } else {
      assert.match(JSON.stringify(results[0].content), /nativeDemoMarker/u);
      assert.match(JSON.stringify(results[1].content), /results/u);
    }
    const captured = memoryDb
      .prepare("SELECT COUNT(*) AS n FROM observations")
      .get().n;
    if (captureFails) {
      assert.equal(captured, 0);
      memoryDb.exec("DROP TRIGGER fail_capture");
      assert.ok(
        (await host.captureMemoryAfterTurn(
          f.input.workspaceId,
          started.sessionId,
        )) > 0,
      );
    } else assert.ok(captured > 0);
    assert.ok(
      body.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("hello default host"),
      ),
    );
    assert.ok(events.some((event) => event.kind === "session.tree_updated"));
    assert.ok(
      f.store
        .list(f.input.workspaceId)
        .records.some(
          ({ kind, record }) =>
            kind === "action" && record.state === "completed",
        ),
    );
  };
}

test(
  "default native host composes automatic capabilities, current policy and real provider prompt",
  { timeout: 30000 },
  composedHostSession(false),
);

test(
  "real native session binds code_search and memory_search and survives memory capture failure",
  { timeout: 30000 },
  composedHostSession(true),
);

for (const mode of ["auto", "bypass"])
  test(
    `real loaded Pi ${mode} dispatches writes and edits without approval`,
    { timeout: 30000 },
    composedHostSession(false, mode),
  );

// Cargo's test artifact is built before any measured session deadline starts.
test.before(() => {
  if (process.platform === "win32") shellFixturePath();
});
function nativeToolSession(loseCleanupReply) {
  return async (t) => {
    const bodies = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const turn = bodies.length;
      const tool =
        turn === 1
          ? { name: "read", arguments: JSON.stringify({ path: "README.md" }) }
          : turn === 2 || turn === 3
            ? {
                name: "write<|channel|>commentary",
                arguments: JSON.stringify({
                  path: turn === 2 ? "approved.txt" : "denied.txt",
                  content: turn === 2 ? "approved" : "blocked",
                }),
              }
            : turn === 4 || turn === 6
              ? {
                  name: "powershell",
                  arguments: JSON.stringify({
                    command:
                      turn === 4
                        ? "Write-Output 'native-shell-ok'"
                        : "Start-Sleep -Seconds 10",
                  }),
                }
              : null;
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${turn}`,
                type: "function",
                function: tool,
              },
            ],
          }
        : { role: "assistant", content: "done" };
      const event = (delta, finish_reason) =>
        `data: ${JSON.stringify({ id: "tools-fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(event(delta, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const f = fixture(
      t,
      {
        modelId: "fixture-model",
        model: { contextWindow: 8192, maxOutputTokens: 1024 },
      },
      `http://127.0.0.1:${server.address().port}/v1`,
      "openai-completions",
      "loopback",
      false,
      true,
    );
    const workspace = join(f.dir, "workspace");
    writeFileSync(
      join(workspace, "README.md"),
      "visible fixture PRIVATE_MARKER",
    );
    let control;
    let longStartId,
      longStart,
      accepted = false,
      confirmed;
    const shellRequests = new Map();
    const shell = shellPeer(
      (frame) => {
        const reply = frame.native,
          request = shellRequests.get(reply.id);
        shellRequests.delete(reply.id);
        if (reply.id === longStartId && reply.ok) accepted = true;
        if (
          loseCleanupReply &&
          reply.value?.state === "done" &&
          request?.params.effectId === longStart?.effectId
        ) {
          // The native fixture observed settlement, but the engine loses its terminal reply.
          confirmed = reply.value;
          control.accept({
            native: {
              id: reply.id,
              ok: false,
              error: { code: "SHELL_CLEANUP_UNCERTAIN" },
            },
          });
        } else control.accept(frame);
      },
      () => control.shutdown(),
      {
        onFrame: ({ native }) => {
          shellRequests.set(native.id, native);
          if (
            native.method === "shell.start" &&
            native.params.command === "Start-Sleep -Seconds 10"
          ) {
            longStartId = native.id;
            longStart = native.params;
          }
        },
      },
    );
    t.after(() => shell.close());
    control = new NativeControl(async ({ native }, maySend) => {
      if (native.method.startsWith("shell."))
        return shell.send({ native }, maySend);
      let value;
      if (native.method === "credential.status") value = { present: true };
      else if (native.method === "inventory.capture")
        value = {
          manifest: { tracked: [], untracked: [], links: [], excluded: [] },
        };
      else if (native.method === "credential.redact") {
        const text = native.params.text.replaceAll(
          "PRIVATE_MARKER",
          "[redacted]",
        );
        value = { text, redactedCount: text === native.params.text ? 0 : 1 };
      } else if (native.method === "credential.read")
        value = { secret: "synthetic-loopback-credential" };
      else if (
        ["credential.scope.open", "credential.scope.close"].includes(
          native.method,
        )
      )
        value = {};
      else throw new Error(`Unexpected native method: ${native.method}`);
      control.accept({ native: { id: native.id, ok: true, value } });
    });
    const host = createNativeHost(f.appDataDir, control);
    f.cleanup.push(async () => {
      await host.shutdown();
      control.shutdown();
    });
    const selected = await host.selectProfile(
      {
        requestId: "tools-select",
        workspaceId: f.input.workspaceId,
        profileId: f.input.profileId,
        expectedProfileRevision: "p1",
        expectedConfigRevision: "cfg-1",
      },
      "tools-select",
    );
    const started = await host.startSession(
      {
        requestId: "tools-start",
        workspaceId: f.input.workspaceId,
        profileId: selected.selectedProfileId,
        expectedConfigRevision: selected.configRevision,
      },
      "tools-start",
    );
    host.subscribeSession(started.sessionId, 0);
    const events = [];
    let settle;
    const terminal = new Promise((resolve) => {
      settle = resolve;
    });
    const collect = () => {
      events.push(...host.drainSessionEvents(started.sessionId).frames);
      const result = events.find((event) =>
        ["turn.completed", "turn.failed", "turn.canceled"].includes(event.kind),
      );
      if (result) settle(result);
    };
    f.cleanup.push(host.onSessionEvents(collect));
    const command = {
      protocolVersion: 2,
      correlationId: "tools-prompt",
      sessionId: started.sessionId,
      scopeId: f.input.workspaceId,
      expectedConfigRevision: selected.configRevision,
      expectedProfileRevision: selected.profileRevision,
      expectedPolicyRevision: started.policyRevision,
    };
    assert.equal(
      (
        await host.preparePrompt({
          ...command,
          op: "session.prompt",
          payload: { text: "Read the workspace, then write a file" },
        })
      ).accepted,
      true,
    );
    for (const [index, decision] of ["approve", "deny"].entries()) {
      let approval;
      const deadline = Date.now() + 15000;
      while (
        !approval &&
        Date.now() < deadline &&
        !events.some((event) =>
          ["turn.completed", "turn.failed", "turn.canceled"].includes(
            event.kind,
          ),
        )
      ) {
        collect();
        approval = events.filter(
          (event) => event.kind === "approval.requested",
        )[index];
        if (!approval) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(
        approval,
        JSON.stringify({ events, requestCount: bodies.length }),
      );
      const target = join(
        workspace,
        index === 0 ? "approved.txt" : "denied.txt",
      );
      assert.equal(existsSync(target), false);
      if (index === 1)
        assert.equal(
          readFileSync(join(workspace, "approved.txt"), "utf8"),
          "approved",
        );
      await host.respondApproval({
        ...command,
        correlationId: `tools-${decision}`,
        op: "approval.respond",
        payload: {
          approvalRequestId: approval.payload.approvalRequestId,
          runId: approval.payload.runId,
          actionId: approval.payload.actionId,
          decision,
        },
      });
    }
    collect();
    assert.equal((await terminal).kind, "turn.failed");
    assert.equal(existsSync(join(workspace, "denied.txt")), false);
    assert.equal(
      readFileSync(join(workspace, "approved.txt"), "utf8"),
      "approved",
    );
    const firstEventCount = events.length;
    assert.equal(
      (
        await host.preparePrompt({
          ...command,
          correlationId: "shell-prompt",
          op: "session.prompt",
          payload: { text: "Run the shell command" },
        })
      ).accepted,
      true,
    );
    let shellApproval;
    const shellDeadline = Date.now() + 15000;
    while (!shellApproval && Date.now() < shellDeadline) {
      collect();
      shellApproval = events
        .slice(firstEventCount)
        .find((event) => event.kind === "approval.requested");
      if (!shellApproval)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(shellApproval, JSON.stringify(events.slice(firstEventCount)));
    await host.respondApproval({
      ...command,
      correlationId: "shell-approve",
      op: "approval.respond",
      payload: {
        approvalRequestId: shellApproval.payload.approvalRequestId,
        runId: shellApproval.payload.runId,
        actionId: shellApproval.payload.actionId,
        decision: "approve",
      },
    });
    // collect only the new turn's terminal event
    while (
      !events
        .slice(firstEventCount)
        .some((event) =>
          ["turn.completed", "turn.failed", "turn.canceled"].includes(
            event.kind,
          ),
        ) &&
      Date.now() < shellDeadline
    ) {
      collect();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      events
        .slice(firstEventCount)
        .find((event) =>
          ["turn.completed", "turn.failed", "turn.canceled"].includes(
            event.kind,
          ),
        )?.kind,
      "turn.completed",
    );
    assert.match(JSON.stringify(bodies[4].messages), /native-shell-ok/u);
    const outcome = (id) =>
      f.store
        .list(f.input.workspaceId)
        .records.filter(
          ({ kind, record }) => kind === "outcome" && record.actionId === id,
        )
        .at(-1)?.record;
    assert.equal(
      outcome(shellApproval.payload.actionId)?.cleanupState,
      "complete",
    );
    const cancelEventStart = events.length;
    assert.equal(
      (
        await host.preparePrompt({
          ...command,
          correlationId: "cancel-prompt",
          op: "session.prompt",
          payload: { text: "Run the long shell command" },
        })
      ).accepted,
      true,
    );
    let cancelApproval;
    const cancelDeadline = Date.now() + 15000;
    while (!cancelApproval && Date.now() < cancelDeadline) {
      collect();
      cancelApproval = events
        .slice(cancelEventStart)
        .find((event) => event.kind === "approval.requested");
      if (!cancelApproval)
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(cancelApproval, JSON.stringify(events.slice(cancelEventStart)));
    await host.respondApproval({
      ...command,
      correlationId: "cancel-approve",
      op: "approval.respond",
      payload: {
        approvalRequestId: cancelApproval.payload.approvalRequestId,
        runId: cancelApproval.payload.runId,
        actionId: cancelApproval.payload.actionId,
        decision: "approve",
      },
    });
    const intentDeadline = Date.now() + 5000;
    while (
      (!accepted ||
        !events
          .slice(cancelEventStart)
          .some(
            (event) =>
              event.kind === "turn.tool_intent" &&
              event.payload.actionId === cancelApproval.payload.actionId,
          )) &&
      Date.now() < intentDeadline
    ) {
      collect();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(
      events
        .slice(cancelEventStart)
        .some(
          (event) =>
            event.kind === "turn.tool_intent" &&
            event.payload.actionId === cancelApproval.payload.actionId,
        ),
    );
    assert.equal(accepted, true);
    const cancellation = host.cancelSession({
      sessionId: started.sessionId,
      reason: "user",
    });
    if (loseCleanupReply) {
      await assert.rejects(cancellation);
      const actionId = cancelApproval.payload.actionId;
      assert.equal(outcome(actionId)?.cleanupState, "uncertain");
      assert.equal(longStart.actionId, actionId);
      assert.equal(longStart.workspaceId, f.input.workspaceId);
      assert.equal(longStart.sessionId, started.sessionId);
      assert.equal(confirmed?.status, "aborted");
      const owner = f.store.workspaceOwner(f.input.workspaceId);
      assert.equal(owner.epoch, longStart.ownershipEpoch);
      for (const id of [started.sessionId, "other"])
        assert.throws(() => f.store.acquireWorkspace(f.input.workspaceId, id), {
          code: "OWNERSHIP_CONFLICT",
        });
      await assert.rejects(host.shutdown(), {
        code: "SHELL_CLEANUP_UNCERTAIN",
      });
      assert.throws(() => host.preparePrompt(command), {
        code: "NATIVE_CONTEXT_CLOSED",
      });
      const sessionDir = join(
        f.dir,
        "sessions",
        createHash("sha256").update(f.input.workspaceId).digest("hex"),
      );
      const file = readdirSync(sessionDir).find((n) =>
        n.endsWith(started.sessionId + ".jsonl"),
      );
      assert.ok(file);
      assert.throws(() => acquireNativeSessionWriter(join(sessionDir, file)));
      // Only the separately retained terminal response for this exact live effect qualifies this test's cleanup record.
      const prior = outcome(actionId);
      f.store.append(
        {
          kind: "outcome",
          record: {
            ...prior,
            recordId: "test-confirmed-shell-cleanup",
            cleanupState: "complete",
          },
        },
        {
          ...f.caller,
          sessionId: started.sessionId,
          resolveReference: () => true,
        },
      );
      await host.shutdown();
      const lease = acquireNativeSessionWriter(join(sessionDir, file));
      lease.close();
      return;
    }
    assert.deepEqual(await cancellation, { canceled: true });
    collect();
    const canceledEvents = events.slice(cancelEventStart);
    assert.ok(
      canceledEvents.some((event) => event.kind === "turn.canceled"),
      JSON.stringify(canceledEvents),
    );
    assert.ok(
      canceledEvents.some(
        (event) =>
          event.kind === "turn.tool_outcome" &&
          event.payload.actionId === cancelApproval.payload.actionId,
      ),
      JSON.stringify(canceledEvents),
    );
    const action = f.store
      .list(f.input.workspaceId)
      .records.filter(
        ({ kind, record }) =>
          kind === "action" &&
          record.actionId === cancelApproval.payload.actionId,
      )
      .at(-1);
    assert.ok(
      action && action.record.state !== "running",
      JSON.stringify(action),
    );
    assert.equal(
      outcome(cancelApproval.payload.actionId)?.cleanupState,
      "complete",
    );
    assert.equal(f.store.workspaceOwner(f.input.workspaceId), undefined);
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    );
    assert.ok(
      events.some(
        (event) =>
          event.kind === "turn.tool_outcome" &&
          event.payload.status === "success" &&
          event.payload.summary.preview.includes("visible fixture [redacted]"),
      ),
    );
    const names = bodies[0].tools.map((tool) => tool.function.name);
    for (const name of [
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "powershell",
      "read",
      "write",
    ])
      assert.ok(names.includes(name), name);
    assert.match(
      JSON.stringify(bodies[1].messages),
      /visible fixture \[redacted\]/u,
    );
    assert.doesNotMatch(JSON.stringify(bodies[1].messages), /PRIVATE_MARKER/u);
  };
}
for (const loseCleanupReply of [false, true])
  test(
    loseCleanupReply
      ? "native session retains both writers after loss of shell cleanup proof"
      : "native session dispatches workspace tools with channel metadata and waits for write approval",
    { timeout: 30000 },
    nativeToolSession(loseCleanupReply),
  );
