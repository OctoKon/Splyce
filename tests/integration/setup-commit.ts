// Splyce TD-26: atomic first-run setup commit on the real Store.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSetupMetadata } from "../../packages/splyce-pi/dist/setup-metadata.js";
import { ConfigAuthority } from "../../packages/splyce-pi/dist/config.js";
import { Store, StoreError } from "../../packages/splyce-pi/dist/store.js";

// Every setup targets a real admitted workspace; fixture() sets it.
let W = "w1";
const base = {
  sessionId: "s1",
  configRevision: "cfg-0",
  profileRevision: "p1",
  policyRevision: "policy1",
};
// The codebase has no account/limits/egress/credential descriptor kinds, so each
// descriptor is a real stored `artifact` record and refs resolve against the Store.
const DESCRIPTORS = ["cred1", "acct-default", "limits1", "egress1"];
const artifact = (recordId: string) => ({
  schemaVersion: 1,
  recordId,
  createdAt: "2026-10-27T00:00:00.000Z",
  scopeId: W,
  sourceIds: [],
  artifactId: recordId,
  digest: "sha256:" + "0".repeat(64),
  mediaType: "application/json",
  byteLength: 2,
  retentionClass: "workspace",
});
// The pure validator is Store-independent: it throws its own SETUP_INVALID error.
const invalid = (error: unknown) =>
  (error as { code?: string } | null)?.code === "SETUP_INVALID";
const code = (expected: string) => (error: unknown) =>
  error instanceof StoreError && error.code === expected;

const input = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: W,
  requestId: "req1",
  endpoint: {
    endpointId: "ep1",
    canonicalUrl: "https://api.example.com/v1",
    apiFamily: "openai-completions",
    locality: "hosted",
    revision: "e1",
  },
  connection: {
    providerConnectionId: "conn1",
    revision: "c1",
    apiFamily: "openai-completions",
    locality: "hosted",
    endpointRef: "ep1@e1",
    credentialRef: "cred1",
  },
  profile: {
    profileId: "profile1",
    profileRevision: "p1",
    bindings: [
      {
        role: "chat",
        providerConnectionId: "conn1",
        connectionRevision: "c1",
        modelId: "gpt-x",
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
    accountScopeRef: "acct-default",
    limitsArtifactId: "limits1",
    apiVersion: "v1",
    adapterRevision: "adapter1",
    egressPolicyRefs: ["egress1"],
  },
  expected: {
    endpointRevision: null,
    connectionRevision: null,
    profileRevision: null,
  },
  ...overrides,
});

function fixture(t: { after(callback: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "td26-setup-"));
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const caller = {
    ...base,
    resolveReference: (id: string, scopeId: string) =>
      store.list(scopeId).records.some(({ record }) => record.recordId === id),
  };
  const admitted = store.admitWorkspace(
    { canonicalPath: join(dir, "ws"), volumeSerial: "1", fileId: "2" },
    caller,
  );
  W = admitted.workspaceId;
  for (const id of DESCRIPTORS)
    store.append({ kind: "artifact", record: artifact(id) }, caller);
  t.after(() => {
    store.close();
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("td26-setup-"));
    rmSync(target, { recursive: true, force: true });
  });
  return { path, store, caller, dir };
}
const kinds = (store: Store) =>
  store
    .list(W)
    .records.map(({ kind }) => kind)
    .filter((kind) => kind !== "artifact" && kind !== "admittedWorkspace");

if (process.argv[2] === "setup-child") {
  W = process.argv[4]!;
  const store = Store.open(process.argv[3]!);
  const childCaller = {
    ...base,
    resolveReference: (id: string, scopeId: string) =>
      store.list(scopeId).records.some(({ record }) => record.recordId === id),
  };
  let result;
  try {
    const done = store.commitSetup(input(), childCaller);
    result = {
      ok: true,
      ids: [done.endpoint, done.connection, done.profile].map(
        (r) => r.recordId,
      ),
    };
  } catch (error) {
    result = {
      ok: false,
      code: error instanceof StoreError ? error.code : String(error),
    };
  } finally {
    store.close();
  }
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (process.argv[2] === "config-child") {
  const store = Store.open(process.argv[3]!);
  try {
    new ConfigAuthority(store).apply(
      {
        scopeId: process.argv[4]!,
        transitionId: "competing-config",
        expectedConfigRevision: "cfg-0",
        acceptedConfigRevision: "cfg-1",
        intentRef: "intent1",
        changedValuesArtifactId: "changes1",
      },
      { ...base, resolveReference: () => true },
    );
  } finally {
    store.close();
  }
  process.exit(0);
}

test("create path appends endpoint, connection and profile atomically", (t) => {
  const { store, caller } = fixture(t);
  const result = store.commitSetup(input(), caller);
  assert.equal(result.endpoint.endpointId, "ep1");
  assert.equal(result.connection.endpointRef, "ep1@e1");
  assert.equal(result.connection.credentialRef, "cred1");
  assert.equal(result.profile.bindings?.[0]?.modelId, "gpt-x");
  assert.deepEqual(kinds(store).sort(), [
    "profileSnapshot",
    "providerConnection",
    "providerEndpoint",
  ]);
});

test("a competing process changing configuration before setup lock leaves no setup records", (t) => {
  const { path, store, caller } = fixture(t);
  let changed = false;
  const racing = {
    ...caller,
    resolveReference: (id: string, scopeId: string) => {
      if (!changed) {
        changed = true;
        const child = spawnSync(
          process.execPath,
          [fileURLToPath(import.meta.url), "config-child", path, W],
          { encoding: "utf8", windowsHide: true },
        );
        assert.equal(child.status, 0, child.stderr);
      }
      return caller.resolveReference(id, scopeId);
    },
  };
  assert.throws(
    () => store.commitSetup(input(), racing),
    code("CONFIG_STALE_REVISION"),
  );
  assert.equal(changed, true);
  assert.equal(store.configRevision(W), "cfg-1");
  assert.deepEqual(kinds(store), ["configurationTransition"]);
  assert.equal(
    store
      .list(W)
      .records.some(({ record }) => record.recordId.startsWith("setup:")),
    false,
  );
});

test("a failure mid-batch rolls back every record", (t) => {
  const { path, store, caller } = fixture(t);
  const raw = new DatabaseSync(path);
  raw.exec(
    "CREATE TRIGGER boom BEFORE INSERT ON records WHEN NEW.kind = 'profileSnapshot' BEGIN SELECT RAISE(ABORT, 'boom'); END;",
  );
  raw.close();
  const before = store.cursor();
  assert.throws(() => store.commitSetup(input(), caller));
  assert.equal(store.cursor(), before);
  assert.deepEqual(kinds(store), []);
});

for (const [name, expected] of [
  ["endpoint", { endpointRevision: "e0" }],
  ["connection", { connectionRevision: "c0" }],
  ["profile", { profileRevision: "p0" }],
] as const) {
  test(`stale expected ${name} revision appends nothing`, (t) => {
    const { store, caller } = fixture(t);
    const before = store.cursor();
    assert.throws(
      () =>
        store.commitSetup(
          input({
            expected: {
              endpointRevision: null,
              connectionRevision: null,
              profileRevision: null,
              ...expected,
            },
          }),
          caller,
        ),
      code("ENTITY_STALE_REVISION"),
    );
    assert.equal(store.cursor(), before);
    assert.deepEqual(kinds(store), []);
  });
}

test("an identical retry is idempotent and appends nothing", (t) => {
  const { store, caller } = fixture(t);
  const first = store.commitSetup(input(), caller);
  const cursor = store.cursor();
  const second = store.commitSetup(input(), caller);
  assert.deepEqual(second, first);
  assert.equal(store.cursor(), cursor);
  assert.equal(kinds(store).length, 3);
});

test("the same requestId with a different payload conflicts", (t) => {
  const { store, caller } = fixture(t);
  store.commitSetup(input(), caller);
  const cursor = store.cursor();
  const changed = input();
  changed.profile.bindings[0]!.modelId = "gpt-y";
  assert.throws(
    () => store.commitSetup(changed, caller),
    code("SETUP_REQUEST_CONFLICT"),
  );
  assert.equal(store.cursor(), cursor);
});

test("a second request revises all three entities against the stored revisions", (t) => {
  const { store, caller } = fixture(t);
  store.commitSetup(input(), caller);
  const next = input({
    requestId: "req2",
    endpoint: { ...input().endpoint, revision: "e2" },
    connection: {
      ...input().connection,
      revision: "c2",
      endpointRef: "ep1@e2",
    },
    profile: {
      profileId: "profile1",
      profileRevision: "p2",
      bindings: [{ ...input().profile.bindings[0]!, connectionRevision: "c2" }],
    },
    expected: {
      endpointRevision: "e1",
      connectionRevision: "c1",
      profileRevision: "p1",
    },
  });
  assert.equal(store.commitSetup(next, caller).profile.profileRevision, "p2");
  assert.equal(kinds(store).length, 6);
});

test("binding that references another connection revision is rejected", (t) => {
  const { store, caller } = fixture(t);
  const bad = input();
  bad.profile.bindings[0]!.connectionRevision = "c9";
  assert.throws(() => store.commitSetup(bad, caller), code("SETUP_INVALID"));
  assert.deepEqual(kinds(store), []);
});

test("connection endpointRef must name this endpoint revision", (t) => {
  const { store, caller } = fixture(t);
  const bad = input();
  bad.connection.endpointRef = "ep1@e9";
  assert.throws(() => store.commitSetup(bad, caller), code("SETUP_INVALID"));
});

test("missing modelId and non-canonical URL are rejected", (t) => {
  const { store, caller } = fixture(t);
  const noModel = input();
  delete (noModel.profile.bindings[0] as Record<string, unknown>).modelId;
  assert.throws(
    () => store.commitSetup(noModel, caller),
    code("SETUP_INVALID"),
  );
  const slash = input();
  slash.endpoint.canonicalUrl = "https://API.example.com/v1/";
  assert.throws(() => store.commitSetup(slash, caller), code("SETUP_INVALID"));
  assert.deepEqual(kinds(store), []);
});

test("raw secret fields are rejected at every level", (t) => {
  const { store, caller } = fixture(t);
  const top = { ...input(), apiKey: "sk-live-123" };
  assert.throws(() => store.commitSetup(top, caller), code("SETUP_INVALID"));
  const nested = input();
  (nested.connection as Record<string, unknown>).apiKey = "sk-live-123";
  assert.throws(() => store.commitSetup(nested, caller), code("SETUP_INVALID"));
  assert.deepEqual(kinds(store), []);
});

test("an unresolvable descriptor or credential ref appends nothing", (t) => {
  const { store, caller } = fixture(t);
  const cursor = store.cursor();
  const cases: [string, Record<string, unknown>][] = [
    [
      "descriptors.accountScopeRef",
      {
        descriptors: {
          ...input().descriptors,
          accountScopeRef: "acct-missing",
        },
      },
    ],
    [
      "descriptors.limitsArtifactId",
      {
        descriptors: {
          ...input().descriptors,
          limitsArtifactId: "limits-missing",
        },
      },
    ],
    [
      "descriptors.egressPolicyRefs[0]",
      {
        descriptors: {
          ...input().descriptors,
          egressPolicyRefs: ["egress-missing"],
        },
      },
    ],
    [
      "connection.credentialRef",
      { connection: { ...input().connection, credentialRef: "cred-missing" } },
    ],
  ];
  for (const [field, override] of cases)
    assert.throws(
      () => store.commitSetup(input(override), caller),
      (error: unknown) =>
        error instanceof StoreError &&
        error.code === "SETUP_INVALID" &&
        error.message.includes(field),
    );
  assert.equal(store.cursor(), cursor);
  assert.deepEqual(kinds(store), []);
});

test("a caller without a resolver cannot commit setup", (t) => {
  const { store } = fixture(t);
  assert.throws(
    () => store.commitSetup(input(), { ...base }),
    code("SETUP_INVALID"),
  );
  assert.deepEqual(kinds(store), []);
});

test("descriptors are required, strict and persisted as supplied", (t) => {
  const { store, caller } = fixture(t);
  const { descriptors: _omit, ...without } = input();
  assert.throws(
    () => store.commitSetup(without, caller),
    code("SETUP_INVALID"),
  );
  assert.throws(
    () =>
      store.commitSetup(
        input({ descriptors: { ...input().descriptors, extra: "x" } }),
        caller,
      ),
    code("SETUP_INVALID"),
  );
  const result = store.commitSetup(input(), caller);
  assert.equal(result.connection.accountScopeRef, "acct-default");
  assert.equal(result.connection.apiVersion, "v1");
  assert.equal(result.connection.adapterRevision, "adapter1");
  assert.equal(result.profile.limitsArtifactId, "limits1");
  assert.deepEqual(result.profile.egressPolicyRefs, ["egress1"]);
});

test("two real processes racing the identical request: one appends, the other replays", async (t) => {
  const { store, path } = fixture(t);
  const run = () =>
    new Promise<{ ok: boolean; code?: string; ids?: string[] }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), "setup-child", path, W],
          {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += String(d)));
        child.stderr.on("data", (d) => (err += String(d)));
        child.on("error", reject);
        child.on("close", (exit) => {
          if (exit !== 0)
            return reject(new Error(`child exit ${exit}: ${err}`));
          try {
            resolve(JSON.parse(out));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true],
  );
  assert.deepEqual(results[0]!.ids, results[1]!.ids);
  assert.equal(kinds(store).length, 3);
});

test("model references with namespaces, versions and ARNs are accepted and persisted", (t) => {
  const forms = [
    "org/model:version",
    "vendor/model",
    "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2:1",
  ];
  for (const [i, modelId] of forms.entries()) {
    const { store, caller } = fixture(t);
    const value = input({ requestId: `req-model-${i}` });
    value.profile.bindings[0]!.modelId = modelId;
    const done = store.commitSetup(value, caller);
    assert.equal(
      store.get(done.profile.recordId).record.bindings[0].modelId,
      modelId,
    );
  }
});

test("control and format characters in modelId are rejected", (t) => {
  const { store, caller } = fixture(t);
  for (const modelId of ["gpt\u200bx", "gpt\u0007x", "gpt x", ""]) {
    const value = input();
    value.profile.bindings[0]!.modelId = modelId;
    assert.throws(
      () => store.commitSetup(value, caller),
      code("SETUP_INVALID"),
    );
  }
  assert.deepEqual(kinds(store), []);
});

test("the same requestId with any different accepted field conflicts", (t) => {
  const { store, caller } = fixture(t);
  store.commitSetup(input(), caller);
  const cursor = store.cursor();
  const changes: Record<string, unknown>[] = [
    { expected: { ...input().expected, endpointRevision: "e0" } },
    { descriptors: { ...input().descriptors, apiVersion: "v2" } },
    { connection: { ...input().connection, credentialRef: "acct-default" } },
  ];
  for (const change of changes)
    assert.throws(
      () => store.commitSetup(input(change), caller),
      code("SETUP_REQUEST_CONFLICT"),
    );
  assert.equal(store.cursor(), cursor);
});

test("displayName and unknown api families are rejected", (t) => {
  const { store, caller } = fixture(t);
  const named = input();
  (named.connection as Record<string, unknown>).displayName = "Example";
  assert.throws(() => store.commitSetup(named, caller), code("SETUP_INVALID"));
  const other = input();
  other.endpoint.apiFamily = "anthropic";
  other.connection.apiFamily = "anthropic";
  assert.throws(() => store.commitSetup(other, caller), code("SETUP_INVALID"));
  assert.deepEqual(kinds(store), []);
});

test("requestId, apiVersion and adapterRevision are bounded, plain and secret-free", (t) => {
  const { store, caller } = fixture(t);
  // Assembled at runtime so the fixture file never contains a key-shaped literal.
  const bad = [
    ["s", "k-ant-api03-abcdefghijklmnop"].join(""),
    ["gh", "p_abcdefghijklmnopqrstuvwxyz"].join(""),
    ["AK", "IAABCDEFGHIJKLMNOP"].join(""),
    "x".repeat(65),
    "has space",
    "semi;colon",
  ];
  for (const value of bad) {
    if (!["x".repeat(65), "semi;colon"].includes(value))
      assert.throws(
        () => store.commitSetup(input({ requestId: value }), caller),
        code("SETUP_INVALID"),
      );
    for (const field of ["apiVersion", "adapterRevision"])
      assert.throws(
        () =>
          store.commitSetup(
            input({ descriptors: { ...input().descriptors, [field]: value } }),
            caller,
          ),
        code("SETUP_INVALID"),
      );
  }
  assert.deepEqual(kinds(store), []);
});

test("a descriptor that stops resolving between check and commit cannot commit", (t) => {
  const { store, caller } = fixture(t);
  // The descriptor resolves for the pre-checks, then disappears before the write lock is held.
  let calls = 0;
  const flaky = {
    ...caller,
    resolveReference: (id: string, scopeId: string) =>
      id === "limits1" ? ++calls <= 2 : caller.resolveReference(id, scopeId),
  };
  const cursor = store.cursor();
  assert.throws(
    () => store.commitSetup(input(), flaky),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "SETUP_INVALID" &&
      error.message.includes("descriptors.limitsArtifactId"),
  );
  assert.equal(store.cursor(), cursor);
  assert.deepEqual(kinds(store), []);
});

test("requestId is opaque up to 128 characters and still rejects secret shapes", (t) => {
  const { store, caller } = fixture(t);
  const secret = ["s", "k-ant-api03-abcdefghijklmnop"].join("");
  for (const bad of ["x".repeat(129), "a b", "a/b", "a\\b", "a\u0007b", secret])
    assert.throws(
      () => store.commitSetup(input({ requestId: bad }), caller),
      code("SETUP_INVALID"),
    );
  assert.deepEqual(kinds(store), []);
  store.commitSetup(input({ requestId: "r".repeat(128) }), caller);
  assert.equal(kinds(store).length, 3);
});

test("setup into a workspace superseded between prepare and commit is rejected", (t) => {
  const { store, caller, dir } = fixture(t);
  let superseded = false;
  const racing = {
    ...caller,
    resolveReference: (id: string, scopeId: string) => {
      if (!superseded) {
        superseded = true;
        store.admitWorkspace(
          { canonicalPath: join(dir, "ws"), volumeSerial: "1", fileId: "3" },
          caller,
          { readmit: true },
        );
      }
      return caller.resolveReference(id, scopeId);
    },
  };
  const cursor = store.cursor();
  assert.throws(
    () => store.commitSetup(input(), racing),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "SETUP_INVALID" &&
      error.message.includes("workspace"),
  );
  assert.equal(superseded, true);
  assert.deepEqual(kinds(store), []);
  assert.equal(
    store.list(W).records.some(({ kind }) => kind === "providerEndpoint"),
    false,
  );
  assert.ok(store.cursor() > cursor, "only the re-admission was appended");
});

test("an unadmitted workspace cannot receive setup", (t) => {
  const { store, caller } = fixture(t);
  assert.throws(
    () => store.commitSetup(input({ workspaceId: "ws-unknown" }), caller),
    code("SETUP_INVALID"),
  );
});

test("readSetupState returns scoped setup records and the current workspace in one read", (t) => {
  const { store, caller, dir } = fixture(t);
  store.commitSetup(input(), caller);
  const state = store.readSetupState(W);
  assert.deepEqual([...new Set(state.records.map(({ kind }) => kind))].sort(), [
    "admittedWorkspace",
    "artifact",
    "profileSnapshot",
    "providerConnection",
    "providerEndpoint",
  ]);
  assert.deepEqual(state.deletedRecordIds, []);
  assert.equal(state.workspace?.workspaceId, W);
  assert.equal(state.workspace?.canonicalPath, join(dir, "ws"));
  assert.equal(state.workspace?.volumeSerial, "1");
  assert.equal(state.workspace?.fileId, "2");
});

test("readSetupState reports no workspace once it is superseded", (t) => {
  const { store, caller, dir } = fixture(t);
  store.admitWorkspace(
    { canonicalPath: join(dir, "ws"), volumeSerial: "1", fileId: "3" },
    caller,
    { readmit: true },
  );
  const state = store.readSetupState(W);
  assert.equal(state.workspace, null);
  assert.equal(store.readSetupState("ws-unknown").workspace, null);
});

// Shared fixtures: the pure validator and commitSetup must agree on every case.
const clone = () => structuredClone(input());
type Case = [string, (value: ReturnType<typeof input>) => void, boolean];
const secretLike = ["s", "k-ant-api03-abcdefghijklmnop"].join("");
const METADATA_CASES: Case[] = [
  ["baseline", () => {}, true],
  ["requestId 128", (v) => void (v.requestId = "r".repeat(128)), true],
  [
    "bedrock arn model",
    (v) =>
      void (v.profile.bindings[0]!.modelId =
        "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2:1"),
    true,
  ],
  [
    "cjk model id",
    (v) => void (v.profile.bindings[0]!.modelId = "org/模型:版本"),
    true,
  ],
  [
    "embedding-only bindings (no chat)",
    (v) => void (v.profile.bindings[0]!.role = "embedding"),
    false,
  ],
  [
    "duplicate role bindings",
    (v) => void v.profile.bindings.push({ ...v.profile.bindings[0]! }),
    false,
  ],
  [
    "chat plus distinct embedding",
    (v) =>
      void v.profile.bindings.push({
        role: "embedding",
        providerConnectionId: "conn1",
        connectionRevision: "c1",
        modelId: "embed-x",
      } as never),
    true,
  ],
  [
    "chat binding without descriptor",
    (v) =>
      void delete (v.profile.bindings[0] as Record<string, unknown>)
        .modelDescriptor,
    false,
  ],
  [
    "user descriptor with explicit limits",
    (v) =>
      void (v.profile.bindings[0]!.modelDescriptor = {
        source: "user",
        contextWindow: 32000,
        maxOutputTokens: 4096,
        reasoning: false,
        input: ["text"],
        costKnown: false,
      } as never),
    true,
  ],
  [
    "user descriptor without contextWindow",
    (v) =>
      void (v.profile.bindings[0]!.modelDescriptor = {
        source: "user",
        maxOutputTokens: 4096,
        reasoning: false,
        input: ["text"],
        costKnown: false,
      } as never),
    false,
  ],
  [
    "user descriptor without maxOutputTokens",
    (v) =>
      void (v.profile.bindings[0]!.modelDescriptor = {
        source: "user",
        contextWindow: 32000,
        reasoning: false,
        input: ["text"],
        costKnown: false,
      } as never),
    false,
  ],
  [
    "catalog descriptor without catalogVersion",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).source = "catalog"),
    false,
  ],
  [
    "unknown descriptor source",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).source = "guess"),
    false,
  ],
  [
    "non-positive contextWindow",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).contextWindow = 0),
    false,
  ],
  [
    "fractional maxOutputTokens",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).maxOutputTokens = 1.5),
    false,
  ],
  [
    "empty input modalities",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).input = []),
    false,
  ],
  [
    "duplicate input modalities",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).input = ["text", "text"]),
    false,
  ],
  [
    "unknown input modality",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).input = ["audio"]),
    false,
  ],
  [
    "non-boolean reasoning",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).reasoning = "yes"),
    false,
  ],
  [
    "unknown descriptor field",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).price = 1),
    false,
  ],
  [
    "descriptor on a non-chat binding",
    (v) =>
      void v.profile.bindings.push({
        ...structuredClone(v.profile.bindings[0]!),
        role: "embedding",
      }),
    false,
  ],
  [
    "user descriptor carrying catalogVersion",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).catalogVersion = "2026-10"),
    false,
  ],
  [
    "user descriptor claiming known cost",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).costKnown = true),
    false,
  ],
  [
    "renderer-claimed catalog descriptor (no trusted catalog)",
    (v) =>
      void Object.assign(v.profile.bindings[0]!.modelDescriptor as object, {
        source: "catalog",
        catalogVersion: "2026-10",
      }),
    false,
  ],
  [
    "contextWindow at the 2^21 cap",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).contextWindow = 2097152),
    true,
  ],
  [
    "contextWindow above the cap",
    (v) =>
      void ((
        v.profile.bindings[0]!.modelDescriptor as Record<string, unknown>
      ).contextWindow = 2097153),
    false,
  ],
  [
    "maxOutputTokens at the 2^20 cap",
    (v) =>
      void Object.assign(v.profile.bindings[0]!.modelDescriptor as object, {
        contextWindow: 2097152,
        maxOutputTokens: 1048576,
      }),
    true,
  ],
  [
    "maxOutputTokens above the cap",
    (v) =>
      void Object.assign(v.profile.bindings[0]!.modelDescriptor as object, {
        contextWindow: 2097152,
        maxOutputTokens: 1048577,
      }),
    false,
  ],
  [
    "maxOutputTokens above contextWindow",
    (v) =>
      void Object.assign(v.profile.bindings[0]!.modelDescriptor as object, {
        contextWindow: 4096,
        maxOutputTokens: 4097,
      }),
    false,
  ],
  [
    "maxOutputTokens equal to contextWindow",
    (v) =>
      void Object.assign(v.profile.bindings[0]!.modelDescriptor as object, {
        contextWindow: 4096,
        maxOutputTokens: 4096,
      }),
    true,
  ],
  ["requestId 129", (v) => void (v.requestId = "r".repeat(129)), false],
  ["requestId secret shape", (v) => void (v.requestId = secretLike), false],
  [
    "non-canonical url",
    (v) => void (v.endpoint.canonicalUrl = "https://API.example.com/v1/"),
    false,
  ],
  [
    "unknown api family",
    (v) => {
      v.endpoint.apiFamily = "anthropic";
      v.connection.apiFamily = "anthropic";
    },
    false,
  ],
  ["locality mismatch", (v) => void (v.connection.locality = "local"), false],
  [
    "model with format char",
    (v) => void (v.profile.bindings[0]!.modelId = "gpt​x"),
    false,
  ],
  [
    "binding wrong connection revision",
    (v) => void (v.profile.bindings[0]!.connectionRevision = "c9"),
    false,
  ],
  [
    "endpointRef mismatch",
    (v) => void (v.connection.endpointRef = "ep1@e9"),
    false,
  ],
  [
    "apiVersion with space",
    (v) => void (v.descriptors.apiVersion = "v 1"),
    false,
  ],
  [
    "adapterRevision too long",
    (v) => void (v.descriptors.adapterRevision = "a".repeat(65)),
    false,
  ],
  [
    "adapterRevision secret shape",
    (v) => void (v.descriptors.adapterRevision = secretLike),
    false,
  ],
  [
    "raw key field",
    (v) => void ((v.connection as Record<string, unknown>).apiKey = secretLike),
    false,
  ],
  [
    "displayName",
    (v) => void ((v.connection as Record<string, unknown>).displayName = "x"),
    false,
  ],
];

test("validateSetupMetadata and commitSetup accept and reject the same cases", (t) => {
  for (const [name, mutate, valid] of METADATA_CASES) {
    const { store, caller } = fixture(t);
    const value = clone();
    mutate(value);
    const pending = structuredClone(value);
    delete (pending.connection as Record<string, unknown>).credentialRef;
    const pendingCheck = () =>
      validateSetupMetadata(pending, { credentialPending: true });
    if (valid) {
      assert.doesNotThrow(() => validateSetupMetadata(value), name);
      assert.doesNotThrow(pendingCheck, name);
      assert.doesNotThrow(() => store.commitSetup(value, caller), name);
    } else {
      assert.throws(() => validateSetupMetadata(value), invalid, name);
      assert.throws(pendingCheck, invalid, name);
      assert.throws(
        () => store.commitSetup(value, caller),
        code("SETUP_INVALID"),
        name,
      );
    }
  }
});

test("the pure validator accepts a pending credential slot; commitSetup still requires one", (t) => {
  const { store, caller } = fixture(t);
  const omitted = clone();
  delete (omitted.connection as Record<string, unknown>).credentialRef;
  const nulled = clone();
  (nulled.connection as Record<string, unknown>).credentialRef = null;
  for (const value of [omitted, nulled]) {
    const meta = validateSetupMetadata(value, { credentialPending: true });
    assert.equal(meta.connection.credentialRef, null);
    assert.throws(() => validateSetupMetadata(value), invalid);
    assert.throws(
      () => store.commitSetup(value, caller),
      code("SETUP_INVALID"),
    );
  }
  // Pending still validates everything else.
  const bad = clone();
  delete (bad.connection as Record<string, unknown>).credentialRef;
  bad.profile.bindings[0]!.modelId = "gpt​x";
  assert.throws(
    () => validateSetupMetadata(bad, { credentialPending: true }),
    invalid,
  );
  assert.deepEqual(kinds(store), []);
});

test("a non-ASCII model id persists unchanged", (t) => {
  const { store, caller } = fixture(t);
  const value = clone();
  value.profile.bindings[0]!.modelId = "org/模型:版本";
  const done = store.commitSetup(value, caller);
  assert.equal(
    (
      store.get(done.profile.recordId).record as {
        bindings: { modelId: string }[];
      }
    ).bindings[0]!.modelId,
    "org/模型:版本",
  );
});

test("a replay never resurrects a record another handle deleted", (t) => {
  const { store, caller, path } = fixture(t);
  const first = store.commitSetup(input(), caller);
  const other = Store.open(path);
  other.noteDeletion(first.profile.recordId);
  const cursor = store.cursor();
  let returned: unknown;
  assert.throws(() => {
    returned = store.commitSetup(input(), caller);
  }, code("SETUP_DELETED"));
  assert.equal(returned, undefined);
  assert.equal(store.cursor(), cursor);
  for (const record of [first.endpoint, first.connection]) {
    other.noteDeletion(record.recordId);
    assert.throws(
      () => store.commitSetup(input(), caller),
      code("SETUP_DELETED"),
    );
  }
  other.close();
});

test("the model descriptor is persisted as an immutable artifact linked from the profile", (t) => {
  const { store, caller } = fixture(t);
  const done = store.commitSetup(input(), caller);
  const ref = done.profile.sourceIds.find(
    (id) => id.startsWith("setup:") && id.includes("modeldesc"),
  );
  assert.ok(ref, "profile links its descriptor artifact");
  const stored = store.get(ref).record as unknown as Record<string, unknown>;
  assert.equal(
    (
      store.get(done.profile.recordId).record as {
        bindings: Record<string, unknown>[];
      }
    ).bindings[0]!.modelDescriptor,
    undefined,
  );
  assert.deepEqual(
    stored.descriptor,
    input().profile.bindings[0]!.modelDescriptor,
  );
  assert.equal(stored.role, "chat");
  // identical retry replays, and a tombstoned descriptor blocks replay
  assert.deepEqual(store.commitSetup(input(), caller), done);
  store.noteDeletion(ref);
  assert.throws(
    () => store.commitSetup(input(), caller),
    code("SETUP_DELETED"),
  );
});

test("a chat binding without a model descriptor names the missing field", (t) => {
  const { store, caller } = fixture(t);
  const value = clone();
  delete (value.profile.bindings[0] as Record<string, unknown>).modelDescriptor;
  const names = (error: unknown) =>
    (error as { code?: string; message?: string }).code === "SETUP_INVALID" &&
    String((error as Error).message).includes(
      "profile.bindings.modelDescriptor",
    );
  assert.throws(() => validateSetupMetadata(value), names);
  assert.throws(
    () => validateSetupMetadata(value, { credentialPending: true }),
    names,
  );
  assert.throws(() => store.commitSetup(value, caller), names);
  assert.deepEqual(kinds(store), []);
});

const CATALOG_ENTRY = {
  catalogVersion: "2026-10",
  contextWindow: 128000,
  maxOutputTokens: 8192,
  reasoning: true,
  input: ["text", "image"] as ("text" | "image")[],
  costKnown: true,
};
const catalogValue = () => {
  const value = clone();
  value.profile.bindings[0]!.modelDescriptor = {
    source: "catalog",
    ...CATALOG_ENTRY,
  } as never;
  return value;
};

test("a catalog descriptor is accepted only when it exactly equals the trusted catalog entry", (t) => {
  const { store, caller } = fixture(t);
  const seen: [string, string][] = [];
  const trustedCatalog = (apiFamily: string, modelId: string) => {
    seen.push([apiFamily, modelId]);
    return apiFamily === "openai-completions" && modelId === "gpt-x"
      ? CATALOG_ENTRY
      : undefined;
  };
  const value = catalogValue();
  // Wire input alone can never claim a catalog.
  assert.throws(() => validateSetupMetadata(value), invalid);
  assert.throws(() => store.commitSetup(value, caller), code("SETUP_INVALID"));
  // Exact match is accepted by the validator and by commitSetup.
  assert.doesNotThrow(() => validateSetupMetadata(value, { trustedCatalog }));
  const done = store.commitSetup(value, { ...caller, trustedCatalog });
  assert.ok(done.profile.sourceIds.some((id) => id.includes("modeldesc")));
  assert.deepEqual(seen[0], ["openai-completions", "gpt-x"]);
  // Any deviation, or no entry for this exact (apiFamily, modelId), is rejected.
  const deviations: ((d: Record<string, unknown>) => void)[] = [
    (d) => void (d.catalogVersion = "2026-11"),
    (d) => void (d.contextWindow = 64000),
    (d) => void (d.maxOutputTokens = 4096),
    (d) => void (d.reasoning = false),
    (d) => void (d.input = ["text"]),
    (d) => void (d.costKnown = false),
  ];
  for (const [i, deviate] of deviations.entries()) {
    const bad = catalogValue();
    deviate(
      bad.profile.bindings[0]!.modelDescriptor as Record<string, unknown>,
    );
    bad.requestId = `req-dev-${i}`;
    assert.throws(
      () => validateSetupMetadata(bad, { trustedCatalog }),
      invalid,
    );
    assert.throws(
      () => store.commitSetup(bad, { ...caller, trustedCatalog }),
      code("SETUP_INVALID"),
    );
  }
  const other = catalogValue();
  other.profile.bindings[0]!.modelId = "gpt-y";
  assert.throws(
    () => validateSetupMetadata(other, { trustedCatalog }),
    invalid,
  );
  // A user descriptor never needs the catalog.
  assert.doesNotThrow(() => validateSetupMetadata(clone(), { trustedCatalog }));
});
