// TD-26 / C4 profile persistence: public DTO + actual Store/ConfigAuthority.
// These cases qualify persistence and selection only, never a live provider.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { ConfigAuthority } from "../../packages/splyce-pi/dist/config.js";
import {
  createProviderProfiles,
  type ConnectionInput,
  type ProfileInput,
  type SelectInput,
} from "../../packages/splyce-pi/dist/provider-profiles.js";
import {
  Store,
  type CallerContext,
} from "../../packages/splyce-pi/dist/store.js";

const scopeId = "w-demo";
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const admittedReferences = new Set([
  fixture.providerConnection.endpointRef,
  fixture.providerConnection.credentialRef,
  fixture.providerConnection.accountScopeRef,
  fixture.profileSnapshot.egressPolicyRefs[0],
  fixture.profileSnapshot.limitsArtifactId,
  fixture.configurationTransition.intentRef,
  fixture.configurationTransition.changedValuesArtifactId,
]);
const caller: CallerContext = {
  sessionId: "s1",
  configRevision: "cfg-0",
  profileRevision: "profile1",
  policyRevision: "policy1",
  resolveReference: (id, scope) =>
    scope === scopeId && admittedReferences.has(id),
};
const connection = (apiVersion = "v1"): ConnectionInput => ({
  scopeId,
  providerConnectionId: fixture.providerConnection.providerConnectionId,
  apiFamily: fixture.providerConnection.apiFamily,
  apiVersion,
  endpointRef: fixture.providerConnection.endpointRef,
  credentialRef: fixture.providerConnection.credentialRef,
  adapterRevision: fixture.providerConnection.adapterRevision,
  accountScopeRef: fixture.providerConnection.accountScopeRef,
  locality: fixture.providerConnection.locality,
});
const profile = (
  connectionRevision = "c1",
  expectedProfileRevision: string | null = null,
  modelId = "anthropic/claude-sonnet-4-5",
): ProfileInput => ({
  scopeId,
  profileId: "profile-chat",
  bindings: [
    {
      role: "chat",
      providerConnectionId: connection().providerConnectionId,
      connectionRevision,
      modelId,
    },
  ],
  egressPolicyRefs: [...fixture.profileSnapshot.egressPolicyRefs],
  limitsArtifactId: fixture.profileSnapshot.limitsArtifactId,
  expectedProfileRevision,
});
const selection = (
  profileRevision = "p1",
  expectedConfigRevision = "cfg-0",
  acceptedConfigRevision = "cfg-1",
  transitionId = "select1",
): SelectInput => ({
  scopeId,
  profileId: "profile-chat",
  profileRevision,
  expectedConfigRevision,
  acceptedConfigRevision,
  transitionId,
  intentRef: fixture.configurationTransition.intentRef,
  changedValuesArtifactId:
    fixture.configurationTransition.changedValuesArtifactId,
});
const code = (expected: string) => (error: unknown) =>
  error instanceof Error && (error as { code?: string }).code === expected;

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "td26-provider-profiles-"));
  const path = join(dir, "store.db");
  const handles = new Set<Store>();
  const open = () => {
    const store = Store.open(path);
    handles.add(store);
    const config = new ConfigAuthority(store);
    return {
      store,
      config,
      profiles: () => createProviderProfiles({ store, config }),
    };
  };
  const close = (store: Store) => {
    store.close();
    handles.delete(store);
  };
  t.after(() => {
    for (const store of handles) store.close();
    // Delete only this case's freshly created real temporary directory.
    const actual = realpathSync(dir);
    assert.equal(
      dirname(actual).toLowerCase(),
      realpathSync(tmpdir()).toLowerCase(),
    );
    assert.equal(actual.toLowerCase(), resolve(dir).toLowerCase());
    assert.ok(basename(actual).startsWith("td26-provider-profiles-"));
    rmSync(actual, { recursive: true, force: true });
  });
  const first = open();
  first.store.appendBatch(
    [...admittedReferences].map((id) => ({
      kind: "artifact" as const,
      record: {
        ...structuredClone(fixture.artifact),
        recordId: id,
        artifactId: id,
        sourceIds: [],
      },
    })),
    caller,
  );
  return { ...first, path, open, close };
}

test("fixture precondition: referenced artifacts are real persisted Store rows", (t) => {
  const f = setup(t);
  assert.equal(f.store.list(scopeId).records.length, admittedReferences.size);
  for (const id of admittedReferences)
    assert.equal(f.store.get(id).kind, "artifact");
  assert.equal(f.config.effectiveRevision(scopeId), "cfg-0");
});

test("no selection means no effective provider profile", (t) => {
  const f = setup(t);
  assert.equal(f.profiles().effective(scopeId), null);
});

test("connection c1 and c2 remain immutable and distinct across reopen", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  const c1 = profiles.writeConnection(connection(), caller);
  const c2 = profiles.writeConnection(connection("v2"), caller);
  assert.equal(c1.revision, "c1");
  assert.equal(c2.revision, "c2");
  assert.ok(c2.seq > c1.seq);
  const before = f.store
    .list(scopeId)
    .records.filter((row) => row.kind === "providerConnection");
  assert.equal(before.length, 2);
  assert.equal((before[0]!.record as { apiVersion: string }).apiVersion, "v1");
  assert.equal((before[1]!.record as { apiVersion: string }).apiVersion, "v2");
  f.close(f.store);
  const reopened = f.open();
  assert.deepEqual(
    reopened.store
      .list(scopeId)
      .records.filter((row) => row.kind === "providerConnection"),
    before,
  );
});

test("a chat binding keeps c1 when a newer connection c2 exists", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  const p1 = profiles.writeProfile(profile(), caller);
  profiles.writeConnection(connection("v2"), caller);
  profiles.select(selection(p1.profileRevision), caller);
  assert.deepEqual(profiles.effective(scopeId)?.bindings, profile().bindings);
  f.close(f.store);
  assert.deepEqual(
    f.open().profiles().effective(scopeId)?.bindings,
    profile().bindings,
  );
});

test("profile p2 appends a new snapshot without rewriting p1", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  const p1 = profiles.writeProfile(profile(), caller);
  const original = f.store
    .list(scopeId)
    .records.find((row) => row.seq === p1.seq);
  profiles.writeConnection(connection("v2"), caller);
  const p2 = profiles.writeProfile(profile("c2", "p1", "model-two"), caller);
  assert.equal(p1.profileRevision, "p1");
  assert.equal(p2.profileRevision, "p2");
  assert.ok(p2.seq > p1.seq);
  assert.deepEqual(
    f.store.list(scopeId).records.find((row) => row.seq === p1.seq),
    original,
  );
  profiles.select(selection("p1"), caller);
  assert.deepEqual(
    profiles.effective(scopeId)?.bindings,
    profile("c1").bindings,
  );
  profiles.select(selection("p2", "cfg-1", "cfg-2", "select2"), caller);
  assert.deepEqual(
    profiles.effective(scopeId)?.bindings,
    profile("c2", null, "model-two").bindings,
  );
  // Each revision pins its own model; c2 does not rewrite p1.
  assert.equal(profiles.effective(scopeId)?.bindings[0]?.modelId, "model-two");
});

test("a stale expected profile revision rejects without any durable write", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  profiles.writeProfile(profile(), caller);
  profiles.writeProfile(profile("c1", "p1"), caller);
  const before = f.store.list(scopeId);
  const cursor = f.store.cursor(scopeId);
  assert.throws(
    () => profiles.writeProfile(profile("c1", "p1"), caller),
    code("PROFILE_STALE_REVISION"),
  );
  assert.equal(f.store.cursor(scopeId), cursor);
  assert.deepEqual(f.store.list(scopeId), before);
});

test("a duplicate first profile revision cannot overwrite an existing profile", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  profiles.writeProfile(profile(), caller);
  const before = f.store.list(scopeId);
  assert.throws(
    () => profiles.writeProfile(profile(), caller),
    code("PROFILE_STALE_REVISION"),
  );
  assert.deepEqual(f.store.list(scopeId), before);
});

test("an unknown connection is rejected without a profile row", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  const before = f.store.list(scopeId);
  assert.throws(
    () => profiles.writeProfile(profile(), caller),
    code("PROFILE_UNKNOWN_CONNECTION"),
  );
  assert.deepEqual(f.store.list(scopeId), before);
});

test("a missing connection revision never resolves to the latest revision", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  const before = f.store.list(scopeId);
  assert.throws(
    () => profiles.writeProfile(profile("c999"), caller),
    code("PROFILE_CONNECTION_REVISION_MISMATCH"),
  );
  assert.deepEqual(f.store.list(scopeId), before);
});

test("a pending or failed profile request cannot activate before an apply", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  profiles.writeProfile(profile(), caller);
  const change = selection();
  f.config.request(change, caller);
  assert.equal(profiles.effective(scopeId), null);
  f.config.fail(change, caller);
  assert.equal(profiles.effective(scopeId), null);
  assert.equal(f.config.effectiveRevision(scopeId), "cfg-0");
});

test("only the latest applied selection is effective, ignoring later pending and failed requests across reopen", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  profiles.writeProfile(profile(), caller);
  profiles.writeConnection(connection("v2"), caller);
  profiles.writeProfile(profile("c2", "p1"), caller);
  profiles.select(selection("p1"), caller);
  const applied = profiles.effective(scopeId);
  assert.equal(applied?.profileRevision, "p1");
  assert.equal(applied?.configRevision, "cfg-1");
  const pending = selection("p2", "cfg-1", "cfg-2", "pending2");
  f.config.request(pending, caller);
  f.config.fail(pending, caller);
  assert.deepEqual(profiles.effective(scopeId), applied);
  f.close(f.store);
  const reopened = f.open();
  assert.deepEqual(reopened.profiles().effective(scopeId), applied);
  reopened
    .profiles()
    .select(selection("p2", "cfg-1", "cfg-2", "select2"), caller);
  assert.deepEqual(reopened.profiles().effective(scopeId), {
    profileId: "profile-chat",
    profileRevision: "p2",
    configRevision: "cfg-2",
    bindings: profile("c2").bindings,
    generationReady: true,
    generationBlocker: null,
  });
});

test("competing selectors on separate real Store handles cannot both apply cfg-0", (t) => {
  const f = setup(t);
  const a = f.profiles();
  a.writeConnection(connection(), caller);
  a.writeProfile(profile(), caller);
  const other = f.open();
  const b = other.profiles();
  a.select(selection("p1", "cfg-0", "cfg-a", "select-a"), caller);
  assert.throws(
    () => b.select(selection("p1", "cfg-0", "cfg-b", "select-b"), caller),
    code("CONFIG_STALE_REVISION"),
  );
  assert.equal(other.config.effectiveRevision(scopeId), "cfg-a");
  assert.deepEqual(b.effective(scopeId), a.effective(scopeId));
  const applied = f.store
    .list(scopeId)
    .records.filter(
      (row) =>
        row.kind === "configurationTransition" &&
        (row.record as { state: string }).state === "applied",
    );
  assert.equal(applied.length, 1);
});

test("effective profile and config revision come from one durable observation", (t) => {
  const f = setup(t);
  const a = f.profiles();
  a.writeConnection(connection(), caller);
  a.writeProfile(profile(), caller);
  a.select(selection(), caller);
  a.writeConnection(connection("v2"), caller);
  a.writeProfile(profile("c2", "p1"), caller);
  const other = f.open();
  const actualRead = f.store.readAuthority.bind(f.store);
  let interleaved = false;
  // Schedule a real second-handle apply immediately before the SQLite read.
  // Selection and config must both reflect that single observation.
  f.store.readAuthority = (scope) => {
    if (!interleaved) {
      interleaved = true;
      other
        .profiles()
        .select(selection("p2", "cfg-1", "cfg-2", "select2"), caller);
    }
    return actualRead(scope);
  };
  const value = a.effective(scopeId);
  assert.equal(interleaved, true);
  assert.deepEqual(value, {
    profileId: "profile-chat",
    profileRevision: "p2",
    configRevision: "cfg-2",
    bindings: profile("c2").bindings,
    generationReady: true,
    generationBlocker: null,
  });
});

for (const input of [
  { ...selection(), profileId: "unknown-profile" },
  { ...selection(), profileRevision: "p999" },
]) {
  test(`an unknown selected ${input.profileId === "unknown-profile" ? "profile" : "profile revision"} is rejected without activation`, (t) => {
    const f = setup(t);
    const profiles = f.profiles();
    profiles.writeConnection(connection(), caller);
    profiles.writeProfile(profile(), caller);
    const before = f.store.list(scopeId);
    assert.throws(
      () => profiles.select(input, caller),
      code("PROFILE_UNKNOWN_PROFILE"),
    );
    assert.deepEqual(f.store.list(scopeId), before);
    assert.equal(profiles.effective(scopeId), null);
    assert.equal(f.config.effectiveRevision(scopeId), "cfg-0");
  });
}

test("an unreadable applied config row fails closed instead of reviving an older profile", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  profiles.writeProfile(profile(), caller);
  profiles.select(selection(), caller);
  f.close(f.store);
  const raw = new DatabaseSync(f.path);
  try {
    raw
      .prepare(
        "INSERT INTO records (kind, record_id, schema_version, scope_id, session_id, created_at, payload) VALUES ('configurationTransition', 'future.applied', 99, 'w-demo', 's1', '2026-10-26T00:00:00.000Z', ?)",
      )
      .run(
        JSON.stringify({
          recordId: "future.applied",
          scopeId,
          state: "applied",
          acceptedConfigRevision: "cfg-future",
          profileId: "profile-chat",
          profileRevision: "p1",
        }),
      );
  } finally {
    raw.close();
  }
  assert.throws(
    () => f.open().profiles().effective(scopeId),
    code("UNKNOWN_SCHEMA"),
  );
});

test("a new profile must name its model", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  const before = f.store.list(scopeId);
  const input = {
    ...profile(),
    bindings: [
      {
        role: "chat",
        providerConnectionId: connection().providerConnectionId,
        connectionRevision: "c1",
      },
    ],
  };
  assert.throws(
    () => profiles.writeProfile(input as never, caller),
    code("PROFILE_INVALID"),
  );
  assert.deepEqual(f.store.list(scopeId), before);
  const p1 = profiles.writeProfile(profile(), caller);
  const stored = f.store
    .list(scopeId)
    .records.find((row) => row.seq === p1.seq);
  assert.deepEqual(
    (stored?.record as { bindings: unknown }).bindings,
    profile().bindings,
  );
});

for (const modelId of [
  "anthropic",
  "anthropic/claude-sonnet-4-5",
  "openrouter/anthropic",
  "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
  "arn:aws:bedrock:us-east-1:123456789012:foundation-model/anthropic.claude-v2:1",
  "模型/модель:é",
  "x".repeat(256),
]) {
  test(`a model reference accepts ${JSON.stringify(modelId.slice(0, 40))}`, (t) => {
    const f = setup(t);
    const profiles = f.profiles();
    profiles.writeConnection(connection(), caller);
    const p1 = profiles.writeProfile(profile("c1", null, modelId), caller);
    profiles.select(selection(p1.profileRevision), caller);
    const value = profiles.effective(scopeId);
    assert.equal(value?.bindings[0]?.modelId, modelId);
    assert.equal(value?.generationReady, true);
  });
}

for (const modelId of [
  "",
  " ",
  "a b",
  "a\nb",
  "\u0000abc",
  "\u007fabc",
  "\u0080abc",
  "a\u0085b",
  "a\u009fb",
  "x".repeat(257),
]) {
  test(`a malformed model reference ${JSON.stringify(modelId.slice(0, 12))} is rejected without a profile row`, (t) => {
    const f = setup(t);
    const profiles = f.profiles();
    profiles.writeConnection(connection(), caller);
    const before = f.store.list(scopeId);
    assert.throws(
      () => profiles.writeProfile(profile("c1", null, modelId), caller),
      code("PROFILE_INVALID"),
    );
    assert.deepEqual(f.store.list(scopeId), before);
  });
}

for (const point of [
  0x0080, 0x0085, 0x009f, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a,
  0x2060, 0xfeff, 0x2028, 0x2029, 0x00ad, 0x061c, 0x180e, 0xe0001,
]) {
  const label = `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
  test(`a model reference containing ${label} is rejected without changing the Store or effective selection`, (t) => {
    const f = setup(t);
    const profiles = f.profiles();
    profiles.writeConnection(connection(), caller);
    const p1 = profiles.writeProfile(
      profile("c1", null, "org/model:version"),
      caller,
    );
    profiles.select(selection(p1.profileRevision), caller);
    const effective = profiles.effective(scopeId);
    assert.equal(effective?.bindings[0]?.modelId, "org/model:version");
    assert.equal(effective?.generationReady, true);
    const before = f.store.list(scopeId);
    const cursor = f.store.cursor(scopeId);
    const configRevision = f.config.effectiveRevision(scopeId);
    const modelId = `org/model${String.fromCodePoint(point)}suffix:v1`;
    try {
      assert.throws(
        () =>
          profiles.writeProfile(
            profile("c1", p1.profileRevision, modelId),
            caller,
          ),
        code("PROFILE_INVALID"),
      );
    } finally {
      assert.equal(f.store.cursor(scopeId), cursor);
      assert.deepEqual(f.store.list(scopeId), before);
      assert.equal(f.config.effectiveRevision(scopeId), configRevision);
      assert.deepEqual(profiles.effective(scopeId), effective);
    }
  });
}

test("a legacy binding stays readable but is not generation ready and cannot be selected again", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  const p1 = profiles.writeProfile(profile(), caller);
  profiles.select(selection(p1.profileRevision), caller);
  // An install written before modelId existed: only the triple is at rest.
  f.store.append(
    {
      kind: "profileSnapshot",
      record: {
        schemaVersion: 1,
        recordId: "legacy-profile",
        createdAt: "2026-10-27T00:00:00.000Z",
        scopeId,
        sourceIds: [],
        profileId: "profile-chat",
        profileRevision: "p2",
        configRevision: "cfg-1",
        roleBindingRefs: [],
        installedModuleRefs: [],
        bindings: [
          {
            role: "chat",
            providerConnectionId: connection().providerConnectionId,
            connectionRevision: "c1",
          },
        ],
        egressPolicyRefs: [...fixture.profileSnapshot.egressPolicyRefs],
        limitsArtifactId: fixture.profileSnapshot.limitsArtifactId,
      },
    },
    caller,
  );
  const change = selection("p2", "cfg-1", "cfg-2", "legacy-apply");
  f.config.request(change, caller);
  f.config.apply(change, caller);
  const value = profiles.effective(scopeId);
  assert.equal(value?.profileRevision, "p2");
  assert.equal(value?.generationReady, false);
  assert.deepEqual(value?.generationBlocker, {
    code: "PROFILE_MODEL_UNBOUND",
    role: "chat",
  });
  assert.equal(value?.bindings[0]?.modelId, undefined);
  const before = f.store.list(scopeId);
  assert.throws(
    () =>
      profiles.select(
        selection("p2", "cfg-2", "cfg-3", "legacy-reselect"),
        caller,
      ),
    code("PROFILE_MODEL_UNBOUND"),
  );
  assert.deepEqual(f.store.list(scopeId), before);
  assert.equal(f.config.effectiveRevision(scopeId), "cfg-2");
});

test("connection input rejects an unknown credential-bearing property at runtime and persists nothing", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  const before = f.store.list(scopeId);
  // A generic canary, not a real credential. Structural typing accepts this
  // variable, so only the runtime boundary can reject the unknown property.
  const input = { ...connection(), apiKey: "generic-rejected-material" };
  assert.throws(
    () => profiles.writeConnection(input, caller),
    code("PROFILE_INVALID"),
  );
  assert.deepEqual(f.store.list(scopeId), before);
  assert.equal(
    JSON.stringify(f.store.list(scopeId)).includes(input.apiKey),
    false,
  );
});

test("profile input rejects an unknown credential-bearing property at runtime and persists nothing", (t) => {
  const f = setup(t);
  const profiles = f.profiles();
  profiles.writeConnection(connection(), caller);
  const before = f.store.list(scopeId);
  const input = { ...profile(), credential: "generic-rejected-material" };
  assert.throws(
    () => profiles.writeProfile(input, caller),
    code("PROFILE_INVALID"),
  );
  assert.deepEqual(f.store.list(scopeId), before);
  assert.equal(
    JSON.stringify(f.store.list(scopeId)).includes(input.credential),
    false,
  );
});
