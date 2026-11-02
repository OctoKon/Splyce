// Native select/start Store boundaries on real SQLite. Synthetic Pi ids below
// qualify storage only; the native factory owns proof of a real prepared session.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { currentNativePolicyRevision } from "../../packages/splyce-pi/dist/policy.js";
import { ConfigAuthority } from "../../packages/splyce-pi/dist/config.js";
import {
  type GrantRecord,
  originView,
  type RecordByKind,
} from "../../packages/splyce-pi/dist/contracts.js";
import { createProviderProfiles } from "../../packages/splyce-pi/dist/provider-profiles.js";
import type { SetupInput } from "../../packages/splyce-pi/dist/setup-metadata.js";
import {
  type CallerContext,
  Store,
  StoreError,
} from "../../packages/splyce-pi/dist/store.js";

const createdAt = "2026-10-28T00:00:00.000Z";
const identity = { volumeSerial: "1", fileId: "2" };
const credentialRef = `splyce-credential:v1:${"0".repeat(64)}`;
const code = (expected: string) => (error: unknown) =>
  error instanceof StoreError && error.code === expected;
type ProfileName = "a" | "b";
type Command = "profile.select" | "session.start";
const storedSources = (
  store: Store,
  workspaceId: string,
  sourceIds: readonly string[],
) => {
  const stored = new Set(
    store.list(workspaceId).records.map(({ record }) => record.recordId),
  );
  return sourceIds.filter((id) => stored.has(id));
};

function fixture(t: TestContext, multiOrigin = false) {
  const dir = mkdtempSync(join(tmpdir(), "native-session-store-"));
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const references = new DatabaseSync(path);
  const handles = new Set([store]);
  const caller: CallerContext = {
    sessionId: "store-fixture",
    configRevision: "cfg-0",
    profileRevision: "p1",
    policyRevision: "policy1",
    resolveReference: (id, scopeId) =>
      references
        .prepare(
          "SELECT 1 FROM records r WHERE scope_id = ? " +
            "AND NOT EXISTS (SELECT 1 FROM deletions d WHERE d.record_id = r.record_id) " +
            "AND (record_id = ? OR (kind = 'providerEndpoint' " +
            "AND json_extract(payload, '$.endpointId') || '@' || json_extract(payload, '$.revision') = ?)) LIMIT 1",
        )
        .get(scopeId, id, id) !== undefined,
  };
  const workspace = store.admitWorkspace(
    { canonicalPath: join(dir, "workspace"), ...identity },
    caller,
  );
  const workspaceId = workspace.workspaceId;
  for (const recordId of [credentialRef, "account", "limits", "egress"])
    store.append(
      {
        kind: "artifact",
        record: {
          schemaVersion: 1,
          recordId,
          createdAt,
          scopeId: workspaceId,
          sourceIds: [],
          artifactId: recordId,
          digest: `sha256:${createHash("sha256").update("{}").digest("hex")}`,
          mediaType: "application/json",
          byteLength: 2,
          retentionClass: "workspace",
        },
      },
      caller,
    );
  const seed = (name: ProfileName) => {
    const input: SetupInput = {
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
            modelId: "org/model:version",
            modelDescriptor: {
              source: "user",
              contextWindow: 128000,
              maxOutputTokens: 8192,
              reasoning: true,
              input: ["text", "image"],
              costKnown: false,
            },
          },
        ],
      },
      descriptors: {
        accountScopeRef: "account",
        limitsArtifactId: "limits",
        apiVersion: "v1",
        adapterRevision: "adapter1",
        egressPolicyRefs: ["egress"],
      },
      expected: {
        endpointRevision: null,
        connectionRevision: null,
        profileRevision: null,
      },
    };
    return store.commitSetup(input, caller);
  };
  let a = seed("a");
  const b = seed("b");
  if (multiOrigin) {
    const chat = a.profile.bindings![0]!;
    const profile: RecordByKind["profileSnapshot"] = {
      ...a.profile,
      recordId: "fixture-multi-profile",
      profileRevision: "p2",
      sourceIds: storedSources(store, workspaceId, a.profile.sourceIds),
      bindings: [
        chat,
        { ...chat, role: "extract" },
        { ...b.profile.bindings![0]!, role: "rerank" },
      ],
    };
    store.compareAndAppend(
      { kind: "profileSnapshot", record: profile },
      caller,
      {
        kind: "profileSnapshot",
        scopeId: workspaceId,
        entityId: profile.profileId,
        expectedRevision: "p1",
      },
    );
    a = { ...a, profile };
  }
  let requests = 0;
  const next = (prefix: string) => `${prefix}-${String(++requests)}`;
  const open = () => {
    const other = Store.open(path);
    handles.add(other);
    return other;
  };
  t.after(() => {
    for (const handle of handles) handle.close();
    references.close();
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("native-session-store-"));
    rmSync(target, { recursive: true, force: true });
  });
  return {
    dir,
    path,
    store,
    caller,
    workspaceId,
    a,
    b,
    next,
    open,
    references,
  };
}
type Fixture = ReturnType<typeof fixture>;

const rows = (f: Fixture) => f.store.list(f.workspaceId).records;
const state = (f: Fixture) => ({
  cursor: f.store.cursor(),
  configRevision: f.store.configRevision(f.workspaceId),
  deletionEpoch: f.store.deletionEpoch(),
  records: rows(f),
});
const grantRows = (f: Fixture): GrantRecord[] =>
  rows(f)
    .filter(({ kind }) => kind === "grant")
    .map(({ record }) => record as GrantRecord);
const mintedGrants = (f: Fixture) =>
  grantRows(f).filter((record) => record.recordId === record.grantId);
const selectRequest = (
  f: Fixture,
  name: ProfileName = "a",
  requestId = f.next("select"),
) => ({
  requestId,
  workspaceId: f.workspaceId,
  profileId: f[name].profile.profileId,
  expectedProfileRevision: f[name].profile.profileRevision,
  expectedConfigRevision: f.store.configRevision(f.workspaceId),
});
const startRequest = (
  f: Fixture,
  name: ProfileName = "a",
  requestId = f.next("start"),
) => ({
  requestId,
  workspaceId: f.workspaceId,
  profileId: f[name].profile.profileId,
  expectedConfigRevision: f.store.configRevision(f.workspaceId),
});
const binding = (piSessionId: string) => ({
  piSessionId,
  branchAnchor: {
    branchAnchorId: `anchor-${piSessionId}`,
    piSessionId,
    parentAnchorId: null,
    forkPointEntryId: null,
    firstChildEntryId: null,
    activeLeafEntryId: null,
  },
});
const select = (f: Fixture, name: ProfileName = "a") =>
  f.store.commitNativeProfileSelection(
    f.store.prepareNativeSessionSetup("profile.select", selectRequest(f, name)),
    f.caller,
  );
const start = (f: Fixture, name: ProfileName = "a") =>
  f.store.commitNativeSessionStart(
    f.store.prepareNativeSessionSetup("session.start", startRequest(f, name)),
    binding(f.next("pi-storage")),
    f.caller,
    currentNativePolicyRevision,
  );
const use = (f: Fixture, grant: GrantRecord) => ({
  grantId: grant.grantId,
  workspaceId: f.workspaceId,
  sessionId: grant.sessionId,
  capability: grant.capability,
  observedIdentity: identity,
  ...(grant.origin === undefined ? {} : { origin: grant.origin }),
});
const commit = (
  f: Fixture,
  command: Command,
  preparation: ReturnType<Store["prepareNativeSessionSetup"]>,
) =>
  command === "profile.select"
    ? f.store.commitNativeProfileSelection(preparation, f.caller)
    : f.store.commitNativeSessionStart(
        preparation,
        binding(f.next("pi-storage")),
        f.caller,
        currentNativePolicyRevision,
      );
const trigger = (f: Fixture, sql: string) => {
  const raw = new DatabaseSync(f.path);
  try {
    raw.exec(sql);
  } finally {
    raw.close();
  }
};

test("native setup preparation rejects malformed DTOs without writes", (t) => {
  const f = fixture(t);
  select(f);
  for (const command of ["profile.select", "session.start"] as const) {
    const valid =
      command === "profile.select" ? selectRequest(f) : startRequest(f);
    assert.doesNotThrow(() =>
      f.store.prepareNativeSessionSetup(command, valid),
    );
    for (const bad of [
      { ...valid, requestId: "x".repeat(129) },
      { ...valid, requestId: "bad\u200brequest" },
      { ...valid, workspaceId: "" },
      { ...valid, expectedConfigRevision: null },
      { ...valid, sessionId: "renderer-supplied" },
      { ...valid, grants: [] },
    ]) {
      const before = state(f);
      assert.throws(
        () => f.store.prepareNativeSessionSetup(command, bad),
        code("SETUP_INVALID"),
      );
      assert.deepEqual(state(f), before);
    }
  }
});

test("select commits the exact profile and config without minting a grant", (t) => {
  const f = fixture(t);
  const request = selectRequest(f);
  const preparation = f.store.prepareNativeSessionSetup(
    "profile.select",
    request,
  );
  assert.ok(Object.isFrozen(preparation));
  assert.equal(preparation.profile.recordId, f.a.profile.recordId);
  assert.equal(
    preparation.bindings[0]!.connection.recordId,
    f.a.connection.recordId,
  );
  assert.equal(
    preparation.bindings[0]!.endpoint.recordId,
    f.a.endpoint.recordId,
  );
  const descriptor = preparation.bindings[0]!.descriptorArtifact;
  assert.ok(
    descriptor,
    "a valid stored chat descriptor is a positive precondition",
  );
  assert.equal(f.store.get(descriptor.recordId).kind, "artifact");
  const selected = f.store.commitNativeProfileSelection(preparation, f.caller);
  assert.equal(selected.result.selectedProfileId, request.profileId);
  assert.equal(
    selected.result.profileRevision,
    request.expectedProfileRevision,
  );
  assert.equal(
    selected.result.configRevision,
    f.store.configRevision(f.workspaceId),
  );
  assert.notEqual(
    selected.result.configRevision,
    request.expectedConfigRevision,
  );
  assert.deepEqual(selected.grantIds, []);
  assert.deepEqual(grantRows(f), []);
});

test("start commits the supplied anchor and exact session grant before reporting unavailable", (t) => {
  const f = fixture(t);
  const selected = select(f);
  const prepared = f.store.prepareNativeSessionSetup(
    "session.start",
    startRequest(f),
  );
  const pi = binding("pi-storage-original");
  const started = f.store.commitNativeSessionStart(
    prepared,
    pi,
    f.caller,
    currentNativePolicyRevision,
  );
  assert.deepEqual(started.result.readiness, { state: "unavailable" });
  assert.equal(started.result.sessionId, pi.piSessionId);
  const anchor = rows(f).find(
    ({ kind, record }) =>
      kind === "branchAnchor" &&
      (record as RecordByKind["branchAnchor"]).piSessionId === pi.piSessionId,
  );
  assert.ok(anchor);
  assert.equal(started.result.sessionRevision, String(anchor.seq));
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(pi.branchAnchor).map((key) => [
        key,
        (anchor.record as unknown as Record<string, unknown>)[key],
      ]),
    ),
    pi.branchAnchor,
  );
  assert.equal(
    f.store.configRevision(f.workspaceId),
    selected.result.configRevision,
  );
  const grants = mintedGrants(f);
  assert.equal(grants.length, 2);
  assert.deepEqual(
    started.grantIds,
    grants.map(({ grantId }) => grantId),
  );
  assert.equal(grants[0]!.sessionId, started.result.sessionId);
  assert.equal(grants[0]!.scope, "session");
  assert.equal(grants[0]!.origin, originView(f.a.endpoint));
  assert.equal(grants[1]!.capability, "fs.read");
  assert.equal(grants[1]!.scope, "session");
  assert.equal(grants[1]!.sessionId, started.result.sessionId);
  assert.equal(
    f.store.requireGrant(use(f, grants[1]!)).grantId,
    grants[1]!.grantId,
  );
  assert.equal(
    f.store.requireGrant(use(f, grants[0]!)).grantId,
    grants[0]!.grantId,
  );
});

test("start deduplicates shared origins and mints one grant for each distinct origin", (t) => {
  const f = fixture(t, true);
  select(f);
  const prepared = f.store.prepareNativeSessionSetup(
    "session.start",
    startRequest(f),
  );
  assert.equal(prepared.bindings.length, 3);
  assert.deepEqual(
    [...prepared.origins].sort(),
    [originView(f.a.endpoint), originView(f.b.endpoint)].sort(),
  );
  const started = f.store.commitNativeSessionStart(
    prepared,
    binding("pi-storage-multi"),
    f.caller,
    currentNativePolicyRevision,
  );
  const grants = mintedGrants(f);
  assert.equal(grants.length, 3);
  assert.equal(new Set(grants.map(({ grantId }) => grantId)).size, 3);
  assert.deepEqual(
    grants
      .filter(({ capability }) => capability === "net.provider")
      .map(({ origin }) => origin)
      .sort(),
    [...prepared.origins].sort(),
  );
  assert.ok(
    grants.every(
      ({ sessionId, scope }) =>
        sessionId === started.result.sessionId && scope === "session",
    ),
  );
});

test("identical select/start replay returns the original result after a later selection", (t) => {
  const f = fixture(t);
  const selection = selectRequest(f);
  const firstSelection = f.store.commitNativeProfileSelection(
    f.store.prepareNativeSessionSetup("profile.select", selection),
    f.caller,
  );
  const request = startRequest(f);
  const firstStart = f.store.commitNativeSessionStart(
    f.store.prepareNativeSessionSetup("session.start", request),
    binding("pi-storage-first"),
    f.caller,
    currentNativePolicyRevision,
  );
  const later = select(f, "b");
  const before = state(f);
  const selectionReplay = f.store.commitNativeProfileSelection(
    f.store.prepareNativeSessionSetup("profile.select", selection),
    f.caller,
  );
  const startReplay = f.store.commitNativeSessionStart(
    f.store.prepareNativeSessionSetup("session.start", request),
    binding("pi-storage-unused-retry"),
    f.caller,
    currentNativePolicyRevision,
  );
  assert.deepEqual(selectionReplay.result, firstSelection.result);
  assert.deepEqual(startReplay.result, firstStart.result);
  assert.deepEqual(startReplay.grantIds, firstStart.grantIds);
  assert.equal(selectionReplay.replayed, true);
  assert.equal(startReplay.replayed, true);
  assert.equal(
    f.store.configRevision(f.workspaceId),
    later.result.configRevision,
  );
  assert.deepEqual(state(f), before);
});

test("reusing a request with changed expected fields conflicts without writes", (t) => {
  const f = fixture(t);
  const selection = selectRequest(f);
  f.store.commitNativeProfileSelection(
    f.store.prepareNativeSessionSetup("profile.select", selection),
    f.caller,
  );
  const request = startRequest(f);
  f.store.commitNativeSessionStart(
    f.store.prepareNativeSessionSetup("session.start", request),
    binding("pi-storage-conflict"),
    f.caller,
    currentNativePolicyRevision,
  );
  for (const [command, changed] of [
    ["profile.select", { ...selection, expectedProfileRevision: "p-other" }],
    ["profile.select", { ...selection, expectedConfigRevision: "cfg-other" }],
    ["session.start", { ...request, expectedConfigRevision: "cfg-other" }],
  ] as const) {
    const before = state(f);
    assert.throws(
      () =>
        commit(f, command, f.store.prepareNativeSessionSetup(command, changed)),
      code("SETUP_REQUEST_CONFLICT"),
    );
    assert.deepEqual(state(f), before);
  }
});

test("a configuration change after prepare makes either commit stale without writes", (t) => {
  for (const command of ["profile.select", "session.start"] as const) {
    const f = fixture(t);
    select(f);
    const request =
      command === "profile.select" ? selectRequest(f) : startRequest(f);
    const prepared = f.store.prepareNativeSessionSetup(command, request);
    const other = f.open();
    other.commitNativeProfileSelection(
      other.prepareNativeSessionSetup("profile.select", selectRequest(f, "b")),
      f.caller,
    );
    const before = state(f);
    assert.throws(() => commit(f, command, prepared), code("STALE_REVISION"));
    assert.deepEqual(state(f), before);
  }
});

test("native selection cannot reuse a current or historical revision accepted by ConfigAuthority", (t) => {
  for (const position of ["current", "historical"] as const) {
    const f = fixture(t);
    const requestId = "native-config-collision";
    const generatedRevision = `cfg-native-${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
    const config = new ConfigAuthority(f.store);
    const change = {
      scopeId: f.workspaceId,
      transitionId: "existing-config-native-namespace",
      expectedConfigRevision: "cfg-0",
      acceptedConfigRevision: generatedRevision,
      intentRef: "account",
      changedValuesArtifactId: "limits",
      profileId: f.a.profile.profileId,
      profileRevision: f.a.profile.profileRevision,
    };
    config.apply(change, f.caller);
    assert.equal(
      config.effectiveRevision(f.workspaceId),
      generatedRevision,
      "the existing ConfigAuthority legitimately accepted the generated revision",
    );
    if (position === "historical") {
      config.apply(
        {
          ...change,
          transitionId: "existing-config-moved-on",
          expectedConfigRevision: generatedRevision,
          acceptedConfigRevision: "cfg-after-native-namespace",
        },
        f.caller,
      );
      assert.notEqual(
        config.effectiveRevision(f.workspaceId),
        generatedRevision,
      );
    }
    const preparation = f.store.prepareNativeSessionSetup(
      "profile.select",
      selectRequest(f, "a", requestId),
    );
    const before = state(f);
    assert.throws(
      () => f.store.commitNativeProfileSelection(preparation, f.caller),
      code("STALE_REVISION"),
      position,
    );
    assert.deepEqual(state(f), before);
  }
});

test("start carries forward the selected profile across an unrelated config transition", (t) => {
  const f = fixture(t);
  const selected = select(f);
  const config = new ConfigAuthority(f.store);
  config.apply(
    {
      scopeId: f.workspaceId,
      transitionId: "unrelated-config-change",
      expectedConfigRevision: selected.result.configRevision,
      acceptedConfigRevision: "cfg-unrelated-change",
      intentRef: "account",
      changedValuesArtifactId: "limits",
    },
    f.caller,
  );
  const effective = createProviderProfiles({
    store: f.store,
    config,
  }).effective(f.workspaceId);
  assert.ok(effective, "the existing authority retains a selected profile");
  assert.equal(effective.profileId, f.a.profile.profileId);
  assert.equal(effective.profileRevision, f.a.profile.profileRevision);
  assert.equal(effective.configRevision, "cfg-unrelated-change");
  const started = start(f);
  assert.equal(started.profileId, effective.profileId);
  assert.equal(started.profileRevision, effective.profileRevision);
  assert.equal(started.configRevision, effective.configRevision);
  assert.deepEqual(started.result.readiness, { state: "unavailable" });
});

test("captured entity, descriptor and active-grant changes cannot cross the write lock", (t) => {
  for (const command of ["profile.select", "session.start"] as const) {
    for (const mutation of [
      "profile",
      "connection",
      "endpoint",
      "descriptor",
      "grant",
      "revoked-grant",
    ] as const) {
      const f = fixture(t);
      select(f);
      const revocable = mutation === "revoked-grant" ? start(f) : undefined;
      const request =
        command === "profile.select" ? selectRequest(f) : startRequest(f);
      const prepared = f.store.prepareNativeSessionSetup(command, request);
      assert.ok(
        prepared.bindings[0]!.descriptorArtifact,
        "valid descriptor before rival mutation",
      );
      const other = f.open();
      if (mutation === "profile") {
        other.compareAndAppend(
          {
            kind: "profileSnapshot",
            record: {
              ...f.a.profile,
              recordId: "rival-profile",
              profileRevision: "p2",
              sourceIds: storedSources(
                f.store,
                f.workspaceId,
                f.a.profile.sourceIds,
              ),
            },
          },
          f.caller,
          {
            kind: "profileSnapshot",
            scopeId: f.workspaceId,
            entityId: f.a.profile.profileId,
            expectedRevision: "p1",
          },
        );
      } else if (mutation === "connection") {
        other.compareAndAppend(
          {
            kind: "providerConnection",
            record: {
              ...f.a.connection,
              recordId: "rival-connection",
              revision: "c2",
              sourceIds: storedSources(
                f.store,
                f.workspaceId,
                f.a.connection.sourceIds,
              ),
            },
          },
          f.caller,
          {
            kind: "providerConnection",
            scopeId: f.workspaceId,
            entityId: f.a.connection.providerConnectionId,
            expectedRevision: "c1",
          },
        );
        const rival = other.get("rival-connection");
        assert.equal(rival.kind, "providerConnection");
        assert.equal(
          (rival.record as RecordByKind["providerConnection"]).revision,
          "c2",
          "the rival connection revision committed before candidate rejection",
        );
      } else if (mutation === "endpoint") {
        other.compareAndAppend(
          {
            kind: "providerEndpoint",
            record: {
              ...f.a.endpoint,
              recordId: "rival-endpoint",
              revision: "e2",
              sourceIds: storedSources(
                f.store,
                f.workspaceId,
                f.a.endpoint.sourceIds,
              ),
            },
          },
          f.caller,
          {
            kind: "providerEndpoint",
            scopeId: f.workspaceId,
            entityId: f.a.endpoint.endpointId,
            expectedRevision: "e1",
          },
        );
      } else if (mutation === "descriptor") {
        other.noteDeletion(prepared.bindings[0]!.descriptorArtifact!.recordId);
      } else if (mutation === "revoked-grant") {
        assert.ok(revocable);
        other.revokeGrant(revocable.grantIds[0]!, f.caller);
      } else {
        other.mintGrant(
          {
            workspaceId: f.workspaceId,
            sessionId: "pi-storage-rival",
            capability: "net.provider",
            scope: "session",
            origin: originView(f.a.endpoint),
          },
          f.caller,
        );
      }
      const before = state(f);
      assert.throws(
        () => commit(f, command, prepared),
        code("STALE_REVISION"),
        `${command}: ${mutation}`,
      );
      assert.deepEqual(
        state(f),
        before,
        `${command}: ${mutation} appends nothing`,
      );
    }
  }
});

test("workspace supersession after prepare is typed and writes no setup records", (t) => {
  const f = fixture(t);
  select(f);
  const prepared = (["profile.select", "session.start"] as const).map(
    (command) => ({
      command,
      preparation: f.store.prepareNativeSessionSetup(
        command,
        command === "profile.select" ? selectRequest(f) : startRequest(f),
      ),
    }),
  );
  f.open().admitWorkspace(
    { canonicalPath: join(f.dir, "workspace"), volumeSerial: "1", fileId: "3" },
    f.caller,
    { readmit: true },
  );
  const before = state(f);
  for (const { command, preparation } of prepared)
    assert.throws(
      () => commit(f, command, preparation),
      code("WORKSPACE_SUPERSEDED"),
    );
  assert.deepEqual(state(f), before);
});

test("select revokes other-profile sessions while preserving exact-profile and filesystem grants", (t) => {
  const f = fixture(t);
  select(f);
  const first = start(f);
  select(f, "b");
  const otherProfile = start(f, "b");
  const sameProfile = f.store.mintGrant(
    {
      workspaceId: f.workspaceId,
      sessionId: first.result.sessionId,
      capability: "net.provider",
      scope: "session",
      origin: originView(f.a.endpoint),
    },
    f.caller,
  );
  const filesystem = f.store.mintGrant(
    {
      workspaceId: f.workspaceId,
      sessionId: otherProfile.result.sessionId,
      capability: "fs.read",
      scope: "session",
    },
    f.caller,
  );
  const otherGrant = mintedGrants(f).find(({ grantId }) =>
    otherProfile.grantIds.includes(grantId),
  )!;
  assert.ok(otherGrant);
  assert.equal(
    f.store.requireGrant(use(f, sameProfile)).grantId,
    sameProfile.grantId,
  );
  assert.equal(
    f.store.requireGrant(use(f, otherGrant)).grantId,
    otherGrant.grantId,
  );
  const beforeMints = mintedGrants(f).map(({ grantId }) => grantId);
  select(f);
  assert.equal(
    f.store.requireGrant(use(f, sameProfile)).grantId,
    sameProfile.grantId,
  );
  assert.equal(
    f.store.requireGrant(use(f, filesystem)).grantId,
    filesystem.grantId,
  );
  assert.throws(
    () => f.store.requireGrant(use(f, otherGrant)),
    code("GRANT_REVOKED"),
  );
  assert.deepEqual(
    mintedGrants(f).map(({ grantId }) => grantId),
    beforeMints,
  );
  const nextProfile = {
    ...f.a.profile,
    recordId: "fixture-same-profile-next-revision",
    profileRevision: "p2",
    sourceIds: storedSources(f.store, f.workspaceId, f.a.profile.sourceIds),
  };
  f.store.compareAndAppend(
    { kind: "profileSnapshot", record: nextProfile },
    f.caller,
    {
      kind: "profileSnapshot",
      scopeId: f.workspaceId,
      entityId: nextProfile.profileId,
      expectedRevision: "p1",
    },
  );
  f.a = { ...f.a, profile: nextProfile };
  select(f);
  assert.throws(
    () => f.store.requireGrant(use(f, sameProfile)),
    code("GRANT_REVOKED"),
    "the same profile id at a different revision also revokes old-session grants",
  );
  assert.equal(
    f.store.requireGrant(use(f, filesystem)).grantId,
    filesystem.grantId,
  );
});

test("a grant insert failure rolls back start or selection with every cursor and config unchanged", (t) => {
  for (const command of ["profile.select", "session.start"] as const) {
    const f = fixture(t);
    select(f, "b");
    start(f, "b");
    const request =
      command === "profile.select" ? selectRequest(f) : startRequest(f, "b");
    const prepared = f.store.prepareNativeSessionSetup(command, request);
    trigger(
      f,
      "CREATE TRIGGER fail_native_grant BEFORE INSERT ON records WHEN NEW.kind = 'grant' BEGIN SELECT RAISE(ABORT, 'fixture grant failure'); END;",
    );
    const before = state(f);
    assert.throws(() => commit(f, command, prepared));
    assert.deepEqual(state(f), before);
    trigger(f, "DROP TRIGGER fail_native_grant;");
    assert.doesNotThrow(
      () => commit(f, command, prepared),
      "same preparation recovers after rollback",
    );
  }
});

test("bind compensation is atomic and idempotent when another handle already revoked a grant", (t) => {
  const f = fixture(t, true);
  select(f);
  const started = start(f);
  const request = {
    workspaceId: f.workspaceId,
    sessionId: started.result.sessionId,
    sessionRevision: started.result.sessionRevision,
  };
  assert.equal(started.grantIds.length, 3);
  trigger(
    f,
    "CREATE TRIGGER fail_native_compensation BEFORE INSERT ON records WHEN NEW.kind = 'grant' BEGIN SELECT RAISE(ABORT, 'fixture compensation failure'); END;",
  );
  const before = state(f);
  assert.throws(() =>
    f.store.failNativeSessionStart(
      request,
      f.caller,
      currentNativePolicyRevision,
    ),
  );
  assert.deepEqual(state(f), before);
  trigger(f, "DROP TRIGGER fail_native_compensation;");
  f.open().revokeGrant(started.grantIds[0]!, f.caller);
  const failed = f.store.failNativeSessionStart(
    request,
    f.caller,
    currentNativePolicyRevision,
  );
  assert.equal(failed.result.sessionId, started.result.sessionId);
  assert.equal(failed.result.sessionRevision, started.result.sessionRevision);
  assert.deepEqual(failed.result.readiness, {
    state: "unavailable",
    code: "SESSION_BIND_FAILED",
  });
  for (const grantId of started.grantIds) {
    const grant = mintedGrants(f).find(
      (candidate) => candidate.grantId === grantId,
    )!;
    assert.ok(grant);
    assert.throws(
      () => f.store.requireGrant(use(f, grant)),
      code("GRANT_REVOKED"),
    );
  }
  const compensated = state(f);
  assert.deepEqual(
    f.store.failNativeSessionStart(
      request,
      f.caller,
      currentNativePolicyRevision,
    ).result,
    failed.result,
  );
  assert.deepEqual(state(f), compensated);
});

test("select revokes a tombstoned mint that the existing grant checker still accepts", (t) => {
  const f = fixture(t);
  select(f);
  const started = start(f);
  const grant = mintedGrants(f).find(
    ({ grantId }) => grantId === started.grantIds[0],
  );
  assert.ok(grant);
  f.open().noteDeletion(grant.recordId);
  assert.equal(
    f.store.requireGrant(use(f, grant)).grantId,
    grant.grantId,
    "a tombstone alone has not revoked the grant in the existing checker",
  );
  const selected = select(f, "b");
  assert.equal(selected.result.selectedProfileId, f.b.profile.profileId);
  assert.throws(
    () => f.store.requireGrant(use(f, grant)),
    code("GRANT_REVOKED"),
  );
  assert.ok(
    grantRows(f).some(
      (record) =>
        record.grantId === grant.grantId && record.revokedAt !== undefined,
    ),
    "selection durably revokes the grant despite its mint tombstone",
  );
});

test("bind compensation revokes authority after the profile or model descriptor is tombstoned", (t) => {
  for (const deleted of ["profile", "descriptor"] as const) {
    const f = fixture(t);
    select(f);
    const prepared = f.store.prepareNativeSessionSetup(
      "session.start",
      startRequest(f),
    );
    const descriptor = prepared.bindings[0]!.descriptorArtifact;
    assert.ok(descriptor, "the valid start has a stored chat descriptor");
    const started = f.store.commitNativeSessionStart(
      prepared,
      binding(f.next("pi-storage-deleted-metadata")),
      f.caller,
      currentNativePolicyRevision,
    );
    const grant = mintedGrants(f).find(
      ({ grantId }) => grantId === started.grantIds[0],
    );
    assert.ok(grant);
    assert.equal(
      f.store.requireGrant(use(f, grant)).grantId,
      grant.grantId,
      "the start committed usable provider authority before metadata deletion",
    );
    f.open().noteDeletion(
      deleted === "profile" ? f.a.profile.recordId : descriptor.recordId,
    );
    const failed = f.store.failNativeSessionStart(
      {
        workspaceId: f.workspaceId,
        sessionId: started.result.sessionId,
        sessionRevision: started.result.sessionRevision,
      },
      f.caller,
      currentNativePolicyRevision,
    );
    assert.equal(failed.result.sessionId, started.result.sessionId);
    assert.equal(failed.result.sessionRevision, started.result.sessionRevision);
    assert.deepEqual(failed.result.readiness, {
      state: "unavailable",
      code: "SESSION_BIND_FAILED",
    });
    assert.throws(
      () => f.store.requireGrant(use(f, grant)),
      code("GRANT_REVOKED"),
      deleted,
    );
  }
});

test("current start assertion captures exact identity without writes or accessor calls", (t) => {
  const f = fixture(t);
  select(f);
  const started = start(f);
  const identity = {
    workspaceId: f.workspaceId,
    sessionId: started.result.sessionId,
    sessionRevision: started.result.sessionRevision,
  };
  const before = state(f);
  assert.doesNotThrow(() => f.store.assertNativeSessionStartCurrent(identity));
  assert.deepEqual(state(f), before);
  let reads = 0;
  const accessor = { ...identity };
  Object.defineProperty(accessor, "sessionId", {
    enumerable: true,
    get() {
      reads++;
      return identity.sessionId;
    },
  });
  assert.throws(
    () => f.store.assertNativeSessionStartCurrent(accessor),
    code("SETUP_INVALID"),
  );
  assert.equal(reads, 0);
  for (const sessionRevision of [
    "0",
    "01",
    "not-a-revision",
    String(Number.MAX_SAFE_INTEGER + 1),
  ])
    assert.throws(
      () =>
        f.store.assertNativeSessionStartCurrent({
          ...identity,
          sessionRevision,
        }),
      code("SETUP_INVALID"),
    );
  assert.throws(
    () =>
      f.store.assertNativeSessionStartCurrent({
        ...identity,
        sessionRevision: String(Number(identity.sessionRevision) + 1),
      }),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "STALE_REVISION" &&
      error.message === "Native setup unavailable",
  );
  assert.deepEqual(state(f), before);
});

test("current start assertion rejects rival config, grants, descriptors and foreign authority in one read", (t) => {
  for (const mutation of [
    "config",
    "revoked-grant",
    "descriptor",
    "extra-grant",
    "foreign-grant",
    "workspace",
  ] as const) {
    const f = fixture(t);
    select(f);
    const started = start(f);
    const identity = {
      workspaceId: f.workspaceId,
      sessionId: started.result.sessionId,
      sessionRevision: started.result.sessionRevision,
    };
    assert.doesNotThrow(
      () => f.store.assertNativeSessionStartCurrent(identity),
      "valid original identity is current before the rival mutation",
    );
    const other = f.open();
    if (mutation === "config") {
      other.commitNativeProfileSelection(
        other.prepareNativeSessionSetup(
          "profile.select",
          selectRequest(f, "b"),
        ),
        f.caller,
      );
    } else if (mutation === "revoked-grant") {
      other.revokeGrant(started.grantIds[0]!, f.caller);
    } else if (mutation === "descriptor") {
      const descriptor = started.bindings.find(
        ({ binding }) => binding.role === "chat",
      )!.descriptorArtifact!;
      other.noteDeletion(descriptor.recordId);
    } else if (mutation === "workspace") {
      other.admitWorkspace(
        {
          canonicalPath: join(f.dir, "workspace"),
          volumeSerial: "1",
          fileId: "3",
        },
        f.caller,
        { readmit: true },
      );
    } else {
      const workspaceId =
        mutation === "foreign-grant"
          ? other.admitWorkspace(
              {
                canonicalPath: join(f.dir, "foreign-workspace"),
                volumeSerial: "1",
                fileId: "4",
              },
              f.caller,
            ).workspaceId
          : f.workspaceId;
      const extra = other.mintGrant(
        {
          workspaceId,
          sessionId: started.result.sessionId,
          capability: "net.provider",
          scope: "session",
          origin: "https://foreign.example.test:443",
        },
        f.caller,
      );
      assert.ok(
        extra.grantId,
        "rival native grant was genuinely minted before the candidate check",
      );
    }
    const before = state(f);
    assert.throws(
      () => f.store.assertNativeSessionStartCurrent(identity),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code ===
          (mutation === "workspace"
            ? "WORKSPACE_SUPERSEDED"
            : "STALE_REVISION") &&
        error.message === "Native setup unavailable",
      mutation,
    );
    assert.deepEqual(state(f), before, mutation);
  }
});

test("session policy witness is read under the write lock and refreshed on legacy replay without minting", (t) => {
  const f = fixture(t);
  select(f);
  const request = startRequest(f);
  const prepared = f.store.prepareNativeSessionSetup("session.start", request);
  const observer = f.references;
  let calls = 0;
  const lockedPolicy = (workspaceId: string) => {
    calls++;
    assert.equal(workspaceId, f.workspaceId);
    assert.throws(() => observer.exec("BEGIN IMMEDIATE;"), /locked/);
    assert.equal(observer.isTransaction, false);
    return "7";
  };
  const committed = f.store.commitNativeSessionStart(
    prepared,
    binding("pi-policy"),
    { ...f.caller, policyRevision: "untrusted-policy" },
    lockedPolicy,
  );
  assert.equal(calls, 1);
  assert.equal(committed.result.policyRevision, "7");
  const before = state(f);
  const replay = f.store.commitNativeSessionStart(
    f.store.prepareNativeSessionSetup("session.start", request),
    undefined,
    f.caller,
    (workspaceId) => {
      assert.equal(workspaceId, f.workspaceId);
      assert.throws(() => observer.exec("BEGIN IMMEDIATE;"), /locked/);
      return "8";
    },
  );
  assert.equal(replay.result.policyRevision, "8");
  assert.equal(replay.result.sessionId, committed.result.sessionId);
  assert.equal(replay.result.sessionRevision, committed.result.sessionRevision);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.grantIds, committed.grantIds);
  assert.deepEqual(state(f), before);
  // The unchanged v1 receipt contains identity only; replay gets the current native witness.
  const receipt = rows(f).find(
    ({ kind, record }) =>
      kind === "artifact" &&
      (record as unknown as { nativeSetup?: { sessionId?: string } })
        .nativeSetup?.sessionId === "pi-policy",
  );
  assert.ok(receipt);
  assert.equal(JSON.stringify(receipt).includes('"policyRevision"'), false);
});

test("missing, throwing and noncanonical session policy getters roll back fresh starts and replays", (t) => {
  const f = fixture(t);
  select(f);
  const request = startRequest(f);
  const invalidGetters = [
    undefined,
    () => {
      throw new Error("unavailable");
    },
    ...[
      "",
      "00",
      "01",
      "-1",
      "1.0",
      " 1",
      "1\n",
      "9".repeat(129),
      1,
      null,
      Promise.resolve("1"),
    ].map((value) => () => value),
  ];
  for (const getter of invalidGetters) {
    const before = state(f);
    assert.throws(
      () =>
        f.store.commitNativeSessionStart(
          f.store.prepareNativeSessionSetup("session.start", request),
          binding("pi-policy-invalid"),
          f.caller,
          getter as (workspaceId: string) => string,
        ),
      code("SETUP_INVALID"),
    );
    assert.deepEqual(state(f), before);
  }
  const committed = f.store.commitNativeSessionStart(
    f.store.prepareNativeSessionSetup("session.start", request),
    binding("pi-policy-valid"),
    f.caller,
    currentNativePolicyRevision,
  );
  for (const getter of invalidGetters) {
    const before = state(f);
    assert.throws(
      () =>
        f.store.commitNativeSessionStart(
          f.store.prepareNativeSessionSetup("session.start", request),
          undefined,
          f.caller,
          getter as (workspaceId: string) => string,
        ),
      code("SETUP_INVALID"),
    );
    assert.deepEqual(state(f), before);
  }
  const before = state(f);
  assert.throws(
    () =>
      f.store.failNativeSessionStart(
        {
          workspaceId: f.workspaceId,
          sessionId: committed.result.sessionId,
          sessionRevision: committed.result.sessionRevision,
        },
        f.caller,
        () => {
          throw new Error("unavailable");
        },
      ),
    code("SETUP_INVALID"),
  );
  assert.deepEqual(state(f), before);
  const failed = f.store.failNativeSessionStart(
    {
      workspaceId: f.workspaceId,
      sessionId: committed.result.sessionId,
      sessionRevision: committed.result.sessionRevision,
    },
    f.caller,
    () => "9",
  );
  assert.equal(failed.result.policyRevision, "9");
  assert.equal(failed.result.readiness.code, "SESSION_BIND_FAILED");
});
