import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createNativeProviderSetup,
  validateProviderSetup,
} from "../packages/splyce-pi/src/native-provider-setup.mjs";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";
import { Store } from "../packages/splyce-pi/dist/store.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const valid = () => ({
  requestId: "request1",
  workspaceId: "workspace1",
  providerConnectionId: "connection1",
  profileId: "profile1",
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
});
const code = (expected) => (error) =>
  error.code === expected && error.message === "Provider setup unavailable";

test("private provider metadata preserves explicit API, model reference and canonical API path", () => {
  for (const apiFamily of ["openai-completions", "openai-responses"]) {
    const input = { ...valid(), apiFamily };
    assert.deepEqual(validateProviderSetup(input), input);
  }
  assert.equal(
    validateProviderSetup({
      ...valid(),
      endpoint: "http://[::1]:8080/v1",
      locality: "loopback",
    }).locality,
    "loopback",
  );
  assert.equal(
    validateProviderSetup({
      ...valid(),
      credentialKind: "keep",
      expectedConnectionRevision: "c1",
    }).credentialKind,
    "keep",
  );
});

test("explicit chat model settings normalize only conservative feature defaults", () => {
  const result = validateProviderSetup({
    ...valid(),
    chat: {
      modelId: "custom/model",
      model: { contextWindow: 8192, maxOutputTokens: 1024 },
    },
  });
  assert.deepEqual(result.chat, {
    modelId: "custom/model",
    model: {
      contextWindow: 8192,
      maxOutputTokens: 1024,
      reasoning: false,
      input: ["text"],
    },
  });
  assert.deepEqual(
    validateProviderSetup({
      ...valid(),
      chat: {
        modelId: "custom/model",
        model: {
          contextWindow: 2 ** 21,
          maxOutputTokens: 2 ** 20,
          input: ["image"],
        },
      },
    }).chat.model,
    {
      contextWindow: 2 ** 21,
      maxOutputTokens: 2 ** 20,
      reasoning: false,
      input: ["image"],
    },
  );
  assert.deepEqual(
    validateProviderSetup({
      ...valid(),
      chat: {
        modelId: "custom/model",
        model: {
          contextWindow: 8192,
          maxOutputTokens: 512,
          reasoning: true,
          input: ["text", "image"],
        },
      },
    }).chat.model,
    {
      contextWindow: 8192,
      maxOutputTokens: 512,
      reasoning: true,
      input: ["text", "image"],
    },
  );
  for (const model of [
    null,
    {},
    { contextWindow: 8192 },
    { contextWindow: 8192, maxOutputTokens: 0 },
    { contextWindow: -1, maxOutputTokens: 1 },
    { contextWindow: 2.5, maxOutputTokens: 1 },
    { contextWindow: Number.MAX_SAFE_INTEGER + 1, maxOutputTokens: 1 },
    { contextWindow: 2 ** 21 + 1, maxOutputTokens: 1 },
    { contextWindow: 2 ** 21, maxOutputTokens: 2 ** 20 + 1 },
    { contextWindow: 8192, maxOutputTokens: 8193 },
    { contextWindow: 8192, maxOutputTokens: 1, reasoning: "false" },
    { contextWindow: 8192, maxOutputTokens: 1, input: [] },
    { contextWindow: 8192, maxOutputTokens: 1, input: ["audio"] },
    { contextWindow: 8192, maxOutputTokens: 1, input: ["text", "text"] },
    { contextWindow: 8192, maxOutputTokens: 1, source: "catalog" },
    { contextWindow: 8192, maxOutputTokens: 1, costKnown: true },
    { contextWindow: 8192, maxOutputTokens: 1, cost: { input: 0, output: 0 } },
  ]) {
    assert.throws(
      () =>
        validateProviderSetup({
          ...valid(),
          chat: { modelId: "custom/model", model },
        }),
      code("SETUP_INVALID"),
    );
  }
});

for (const [name, change] of [
  [
    "unknown secret field",
    (input) => {
      input.secret = "synthetic-private-value";
    },
  ],
  [
    "public credential shape",
    (input) => {
      input.credential = { kind: "new", secret: "synthetic-private-value" };
    },
  ],
  [
    "display name",
    (input) => {
      input.displayName = "Provider";
    },
  ],
  [
    "unqualified API alias",
    (input) => {
      input.apiFamily = "openai-compatible";
    },
  ],
  [
    "absent API",
    (input) => {
      delete input.apiFamily;
    },
  ],
  [
    "nondefault account",
    (input) => {
      input.accountScopeRef = "other-account";
    },
  ],
  [
    "credential ref field",
    (input) => {
      input.credentialRef = "some-reference";
    },
  ],
  [
    "hosted loopback claim",
    (input) => {
      input.endpoint = "https://localhost/v1";
    },
  ],
  [
    "remote local claim",
    (input) => {
      input.locality = "loopback";
    },
  ],
  [
    "remote plaintext",
    (input) => {
      input.endpoint = "http://example.test/v1";
    },
  ],
  [
    "userinfo",
    (input) => {
      input.endpoint = "https://user@example.test/v1";
    },
  ],
  [
    "query",
    (input) => {
      input.endpoint += "?key=value";
    },
  ],
  [
    "fragment",
    (input) => {
      input.endpoint += "#value";
    },
  ],
  [
    "dot segment",
    (input) => {
      input.endpoint = "https://example.test/a/../v1";
    },
  ],
  [
    "encoded dot segment",
    (input) => {
      input.endpoint = "https://example.test/%2e%2e/v1";
    },
  ],
  [
    "noncanonical host",
    (input) => {
      input.endpoint = "https://EXAMPLE.test/v1";
    },
  ],
  [
    "trailing slash",
    (input) => {
      input.endpoint += "/";
    },
  ],
  [
    "keep without revision",
    (input) => {
      input.credentialKind = "keep";
    },
  ],
  [
    "invalid credential mode",
    (input) => {
      input.credentialKind = "ambient";
    },
  ],
  [
    "wrong CAS token",
    (input) => {
      input.expectedConnectionRevision = "p1";
    },
  ],
  [
    "legacy CAS token",
    (input) => {
      input.expectedProfileRevision = "cfg-0";
    },
  ],
  [
    "leading zero",
    (input) => {
      input.expectedEndpointRevision = "r01";
    },
  ],
  [
    "CAS overflow",
    (input) => {
      input.expectedConnectionRevision = "c9007199254740991";
    },
  ],
  [
    "unknown chat field",
    (input) => {
      input.chat.secret = "synthetic-private-value";
    },
  ],
  [
    "empty model",
    (input) => {
      input.chat.modelId = "";
    },
  ],
  [
    "model format character",
    (input) => {
      input.chat.modelId = "vendor/\u200bmodel";
    },
  ],
  [
    "model whitespace",
    (input) => {
      input.chat.modelId = "vendor/model name";
    },
  ],
  [
    "oversized model",
    (input) => {
      input.chat.modelId = "x".repeat(257);
    },
  ],
  [
    "oversized ID",
    (input) => {
      input.requestId = "x".repeat(129);
    },
  ],
  [
    "ID slash",
    (input) => {
      input.profileId = "a/b";
    },
  ],
  [
    "ID control",
    (input) => {
      input.workspaceId = "a\0b";
    },
  ],
]) {
  test(`private provider metadata rejects ${name} before Store writes`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "splyce-setup-negative-"));
    const host = createNativeHost(directory);
    t.after(() => {
      host.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const expectedFiles = [
      "snapshots",
      "store.db",
      "store.db-shm",
      "store.db-wal",
      "store.db.restore-lock",
    ];
    assert.deepEqual(
      readdirSync(join(directory, "splyce")).sort(),
      expectedFiles,
    );
    const input = valid();
    change(input);
    assert.throws(() => validateProviderSetup(input), code("SETUP_INVALID"));
    assert.throws(
      () => host.prepareProviderSetup(input),
      code("SETUP_INVALID"),
    );
    const independent = Store.open(join(directory, "splyce", "store.db"));
    try {
      assert.equal(independent.cursor(), 0);
    } finally {
      independent.close();
    }
    assert.deepEqual(
      readdirSync(join(directory, "splyce")).sort(),
      expectedFiles,
    );
  });
}

const frame = (value) => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
};
function decode(bytes) {
  const output = [];
  for (let index = 0; index < bytes.length;) {
    const length = bytes.readUInt32BE(index);
    output.push(
      JSON.parse(
        bytes.subarray(index + 4, index + 4 + length).toString("utf8"),
      ),
    );
    index += 4 + length;
  }
  return output;
}
test("loaded source host denies raw/public setup and rejects private secret fields without echo", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "splyce-setup-pipe-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secret = "synthetic-private-pipe-value";
  const result = spawnSync(
    process.execPath,
    [join(root, "packages/splyce-pi/src/engine-host.mjs")],
    {
      windowsHide: true,
      timeout: 15000,
      input: Buffer.concat([
        frame({
          id: "native-bootstrap",
          method: "native.bootstrap",
          params: { appDataDir: directory },
        }),
        frame({
          id: "public",
          method: "send",
          params: {
            frame: "setup",
            command: "provider.configure",
            requestId: "request1",
            payload: { ...valid(), secret },
          },
        }),
        frame({
          id: "private",
          method: "native.provider.prepare",
          params: { ...valid(), secret },
        }),
        frame({ id: "stop", method: "shutdown", params: {} }),
      ]),
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.includes(Buffer.from(secret)), false);
  assert.equal(result.stderr.includes(Buffer.from(secret)), false);
  const replies = decode(result.stdout);
  assert.equal(replies[1].error.code, "POLICY_DENIED");
  assert.equal(replies[2].error.code, "SETUP_INVALID");
  const independent = Store.open(join(directory, "splyce", "store.db"));
  try {
    assert.equal(independent.cursor(), 0);
  } finally {
    independent.close();
  }
});

function admittedFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "splyce-setup-preflight-"));
  const workspacePath = join(directory, "workspace");
  mkdirSync(workspacePath);
  const host = createNativeHost(directory);
  const writer = Store.open(join(directory, "splyce", "store.db"));
  t.after(() => {
    host.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const workspace = host.admitWorkspace({
    canonicalPath: workspacePath,
    volumeSerial: "1",
    fileId: "2",
  });
  return {
    directory,
    host,
    writer,
    metadata: { ...valid(), workspaceId: workspace.workspaceId },
  };
}

test("real Store prepare reserves only owned nonsecret descriptors and survives reopen", (t) => {
  const { directory, host, writer, metadata } = admittedFixture(t);
  assert.equal(
    typeof writer.readSetupState,
    "function",
    "requires the real coherent Store API",
  );
  const first = host.prepareProviderSetup(metadata);
  assert.equal(first.state, "prepared");
  assert.match(first.credentialRef, /^splyce-credential:v1:[a-f0-9]{64}$/u);
  assert.equal(first.reservation.created, true);
  const observation = writer.readSetupState(metadata.workspaceId);
  assert.deepEqual(
    observation.records.map(({ kind }) => kind),
    [
      "admittedWorkspace",
      "artifact",
      "artifact",
      "artifact",
      "artifact",
      "artifact",
    ],
  );
  const descriptorPath = join(directory, "splyce", "setup-descriptors");
  const definitions = readdirSync(descriptorPath).map((name) =>
    JSON.parse(readFileSync(join(descriptorPath, name), "utf8")),
  );
  assert.equal(definitions.length, 4);
  assert.ok(
    definitions.every(({ scopeId }) => scopeId === metadata.workspaceId),
  );
  assert.deepEqual(
    definitions.find(({ kind }) => kind === "provider-egress"),
    {
      schemaVersion: 1,
      scopeId: metadata.workspaceId,
      kind: "provider-egress",
      origin: "https://example.test:443",
      requiresNativeGrant: true,
      grants: [],
    },
  );
  assert.equal(
    definitions.find(({ kind }) => kind === "provider-transport-limits")
      .maxRetries,
    0,
  );
  const cursor = writer.cursor();
  const {
    reasoning: _reasoning,
    input: _input,
    ...limits
  } = metadata.chat.model;
  assert.deepEqual(
    host.prepareProviderSetup({
      ...metadata,
      chat: { modelId: metadata.chat.modelId, model: limits },
    }),
    { ...first, reservation: { ...first.reservation, created: false } },
  );
  assert.equal(
    writer.cursor(),
    cursor,
    "omitted conservative defaults preserve the same immutable request intent",
  );
  host.close();
  const reopened = createNativeHost(directory);
  try {
    assert.deepEqual(reopened.prepareProviderSetup(metadata), {
      ...first,
      reservation: { ...first.reservation, created: false },
    });
    assert.equal(writer.cursor(), cursor);
    assert.equal(reopened.handshakeReadiness.ports.generation, false);
  } finally {
    reopened.close();
  }
});

test("real Store preflight rejects unadmitted workspace and stale CAS before descriptor reservation", (t) => {
  const { directory, host, writer, metadata } = admittedFixture(t);
  const cursor = writer.cursor();
  assert.throws(
    () => host.prepareProviderSetup({ ...metadata, workspaceId: "unadmitted" }),
    code("SETUP_WORKSPACE_UNAVAILABLE"),
  );
  assert.throws(
    () =>
      host.prepareProviderSetup({
        ...metadata,
        expectedConnectionRevision: "c1",
      }),
    code("SETUP_STALE_REVISION"),
  );
  assert.equal(writer.cursor(), cursor);
  assert.equal(
    readdirSync(join(directory, "splyce")).includes("setup-descriptors"),
    false,
  );
});

test("missing explicit model settings fail before any reservation without a qualified catalog match", (t) => {
  const { directory, host, writer, metadata } = admittedFixture(t);
  const cursor = writer.cursor();
  assert.throws(
    () =>
      host.prepareProviderSetup({
        ...metadata,
        chat: { modelId: "unknown/custom" },
      }),
    code("SETUP_MODEL_METADATA_REQUIRED"),
  );
  assert.equal(writer.cursor(), cursor);
  assert.equal(
    readdirSync(join(directory, "splyce")).includes("setup-descriptors"),
    false,
  );
});

test("omitted model settings resolve only an exact pinned catalog tuple and bind its native provenance", (t) => {
  const { directory, host, writer, metadata } = admittedFixture(t);
  const selected = {
    ...metadata,
    apiFamily: "openai-responses",
    endpoint: "https://api.openai.com/v1",
    chat: { modelId: "gpt-4" },
  };
  const first = host.prepareProviderSetup(selected);
  assert.equal(first.reservation.created, true);
  const descriptorPath = join(directory, "splyce", "setup-descriptors");
  const intent = readdirSync(descriptorPath)
    .map((name) => JSON.parse(readFileSync(join(descriptorPath, name), "utf8")))
    .find(({ kind }) => kind === "provider-setup-request");
  assert.deepEqual(intent.metadata.chat, { modelId: "gpt-4" });
  const { catalogVersion, ...descriptor } = intent.modelDescriptor;
  assert.match(catalogVersion, /^openai-v1-[a-f0-9]{64}$/u);
  assert.deepEqual(descriptor, {
    source: "catalog",
    contextWindow: 8192,
    maxOutputTokens: 8192,
    reasoning: false,
    input: ["text"],
    costKnown: false,
  });
  const cursor = writer.cursor();
  assert.deepEqual(host.prepareProviderSetup(selected), {
    ...first,
    reservation: { ...first.reservation, created: false },
  });
  assert.throws(
    () =>
      host.prepareProviderSetup({
        ...selected,
        chat: {
          modelId: "gpt-4",
          model: { contextWindow: 8192, maxOutputTokens: 8192 },
        },
      }),
    code("SETUP_REQUEST_CONFLICT"),
  );
  assert.equal(writer.cursor(), cursor);
});

test("catalog misses cannot inherit a model from another endpoint, API or model name", (t) => {
  const { directory, host, writer, metadata } = admittedFixture(t);
  const selected = {
    ...metadata,
    apiFamily: "openai-responses",
    endpoint: "https://api.openai.com/v1",
    chat: { modelId: "gpt-4" },
  };
  const cursor = writer.cursor();
  for (const overrides of [
    { endpoint: "https://other.example.test/v1" },
    { endpoint: "https://api.openai.com/v1/other" },
    { apiFamily: "openai-completions" },
    { chat: { modelId: "GPT-4" } },
    { chat: { modelId: "unknown/custom" } },
  ])
    assert.throws(
      () => host.prepareProviderSetup({ ...selected, ...overrides }),
      code("SETUP_MODEL_METADATA_REQUIRED"),
    );
  assert.equal(writer.cursor(), cursor);
  assert.equal(
    readdirSync(join(directory, "splyce")).includes("setup-descriptors"),
    false,
  );
});

test("shared metadata preflight supports 128-byte opaque request IDs and blocks credential-shaped IDs", (t) => {
  const { host, writer, metadata } = admittedFixture(t);
  const input = { ...metadata, requestId: "q".repeat(128) };
  assert.equal(host.prepareProviderSetup(input).reservation.created, true);
  assert.ok(
    writer
      .readSetupState(metadata.workspaceId)
      .records.every(({ record }) => record.recordId.length <= 128),
  );
  const cursor = writer.cursor();
  assert.throws(
    () =>
      host.prepareProviderSetup({
        ...metadata,
        requestId: "sk-syntheticrequestid",
      }),
    (error) => error.code === "SETUP_INVALID",
  );
  assert.equal(writer.cursor(), cursor);
});

test("real Store immutable intent rejects reused request metadata and altered owned bytes", (t) => {
  const { directory, host, writer, metadata } = admittedFixture(t);
  host.prepareProviderSetup(metadata);
  const cursor = writer.cursor();
  assert.throws(
    () =>
      host.prepareProviderSetup({
        ...metadata,
        chat: { ...metadata.chat, modelId: "different/model" },
      }),
    code("SETUP_REQUEST_CONFLICT"),
  );
  assert.throws(
    () =>
      host.prepareProviderSetup({
        ...metadata,
        endpoint: "https://different.example.test/v1",
      }),
    code("SETUP_REQUEST_CONFLICT"),
  );
  assert.throws(
    () =>
      host.prepareProviderSetup({
        ...metadata,
        chat: {
          ...metadata.chat,
          model: { ...metadata.chat.model, maxOutputTokens: 512 },
        },
      }),
    code("SETUP_REQUEST_CONFLICT"),
  );
  assert.equal(writer.cursor(), cursor);
  const descriptorPath = join(directory, "splyce", "setup-descriptors");
  const account = readdirSync(descriptorPath).find(
    (name) =>
      JSON.parse(readFileSync(join(descriptorPath, name), "utf8")).kind ===
      "provider-account",
  );
  writeFileSync(join(descriptorPath, account), "{}");
  assert.throws(
    () => host.prepareProviderSetup(metadata),
    code("SETUP_REQUEST_CONFLICT"),
  );
  assert.equal(writer.cursor(), cursor);
});

test("descriptor deletion between observation and commit cannot append or replay setup", (t) => {
  for (const replay of [false, true]) {
    const { directory, writer, metadata } = admittedFixture(t);
    const other = Store.open(join(directory, "splyce", "store.db"));
    const setup = createNativeProviderSetup(writer, join(directory, "splyce"));
    const input = {
      metadata,
      credentialRef: setup.prepare(metadata).credentialRef,
    };
    if (replay) {
      const committed = setup.commit(input);
      assert.deepEqual(setup.commit(input), committed);
    }
    const descriptor = writer
      .readSetupState(metadata.workspaceId)
      .records.find(
        ({ kind, record }) =>
          kind === "artifact" && record.artifactId === "provider-default",
      );
    assert.ok(descriptor);
    const before = writer.cursor();
    const original = writer.commitSetup.bind(writer);
    writer.commitSetup = (...args) => {
      other.noteDeletion(descriptor.record.recordId);
      return original(...args);
    };
    assert.throws(
      () => setup.commit(input),
      (error) => error.code === "SETUP_INVALID",
    );
    assert.equal(writer.cursor(), before);
    const rows = writer.readSetupState(metadata.workspaceId).records;
    for (const kind of [
      "providerEndpoint",
      "providerConnection",
      "profileSnapshot",
    ])
      assert.equal(
        rows.filter((row) => row.kind === kind).length,
        replay ? 1 : 0,
      );
    other.close();
  }
});

test("reservation survives reopen and backup, refuses rollback and changed backup", (t) => {
  const { directory, host, writer, metadata } = admittedFixture(t);
  host.close();
  const rootDir = join(directory, "splyce");
  const old = join(directory, "before.db");
  writer.backup(old);
  const setup = createNativeProviderSetup(writer, rootDir);
  const first = setup.prepare(metadata);
  const fresh = join(directory, "after.db");
  writer.backup(fresh);
  assert.throws(
    () => writer.restore(old),
    (error) => error.code === "RESTORE_RESERVATION_MISMATCH",
  );
  const changed = join(directory, "changed.db");
  writer.backup(changed);
  const db = new DatabaseSync(changed);
  db.prepare(
    "UPDATE records SET payload = replace(payload, ?, ?) WHERE record_id = ?",
  ).run(
    first.reservation.digest,
    `sha256:${"0".repeat(64)}`,
    first.reservation.recordId,
  );
  db.close();
  assert.throws(
    () => writer.restore(changed),
    (error) => error.code === "RESTORE_RESERVATION_MISMATCH",
  );
  writer.restore(fresh);
  assert.deepEqual(setup.prepare(metadata), {
    ...first,
    reservation: { ...first.reservation, created: false },
  });
  const stored = writer.get(first.reservation.recordId).record;
  assert.equal(stored.reservation.credentialRef, first.credentialRef);
  assert.equal(JSON.stringify(stored).includes("secret"), false);
});

test("two Store handles reuse an immutable reservation and deletion prevents reuse", (t) => {
  const { directory, writer, metadata } = admittedFixture(t);
  const rootDir = join(directory, "splyce");
  const other = Store.open(join(rootDir, "store.db"));
  const firstSetup = createNativeProviderSetup(writer, rootDir);
  const secondSetup = createNativeProviderSetup(other, rootDir);
  const first = firstSetup.prepare(metadata);
  assert.deepEqual(secondSetup.prepare(metadata), {
    ...first,
    reservation: { ...first.reservation, created: false },
  });
  assert.throws(
    () =>
      secondSetup.prepare({ ...metadata, endpoint: "https://other.test/v1" }),
    (error) => error.code === "SETUP_REQUEST_CONFLICT",
  );
  assert.throws(
    () =>
      secondSetup.prepare({
        ...metadata,
        credentialKind: "keep",
        expectedConnectionRevision: "c1",
      }),
    (error) => error.code === "SETUP_REQUEST_CONFLICT",
  );
  writer.noteDeletion(first.reservation.recordId);
  assert.throws(
    () => secondSetup.prepare(metadata),
    (error) => error.code === "SETUP_DELETED",
  );
  other.close();
});

test("reservation is rechecked under commit lock and linked to connection", (t) => {
  const { directory, writer, metadata } = admittedFixture(t);
  const rootDir = join(directory, "splyce");
  const other = Store.open(join(rootDir, "store.db"));
  const setup = createNativeProviderSetup(writer, rootDir);
  const first = setup.prepare(metadata);
  const original = writer.commitSetup.bind(writer);
  writer.commitSetup = (...args) => {
    other.noteDeletion(first.reservation.recordId);
    return original(...args);
  };
  assert.throws(
    () => setup.commit({ metadata, credentialRef: first.credentialRef }),
    (error) => ["SETUP_INVALID", "SETUP_DELETED"].includes(error.code),
  );
  assert.equal(
    writer
      .readSetupState(metadata.workspaceId)
      .records.some(({ kind }) => kind === "providerConnection"),
    false,
  );
  other.close();
});

test("concurrent processes reserve one reference for the same intent", async (t) => {
  const { directory, writer, metadata } = admittedFixture(t);
  const rootDir = join(directory, "splyce");
  const setup = createNativeProviderSetup(writer, rootDir);
  const original = writer.reserveSetupCredential;
  writer.reserveSetupCredential = () => {
    throw new Error("pause before reservation");
  };
  assert.throws(() => setup.prepare(metadata), /pause before reservation/u);
  writer.reserveSetupCredential = original;
  const code = `import { Store } from './packages/splyce-pi/dist/store.js'; import { createNativeProviderSetup } from './packages/splyce-pi/src/native-provider-setup.mjs'; import { join } from 'node:path'; const [dir, json] = process.argv.slice(1); const store = Store.open(join(dir, 'store.db')); try { console.log(JSON.stringify(createNativeProviderSetup(store, dir).prepare(JSON.parse(json)))); } finally { store.close(); }`;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", code, rootDir, JSON.stringify(metadata)],
        { cwd: root },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (part) => {
        out += part;
      });
      child.stderr.on("data", (part) => {
        err += part;
      });
      child.on("error", reject);
      child.on("exit", (status) =>
        status === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)),
      );
    });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.credentialRef, b.credentialRef);
  assert.equal(a.reservation.digest, b.reservation.digest);
  assert.deepEqual([a.reservation.created, b.reservation.created].sort(), [
    false,
    true,
  ]);
});

test("committed connection links reservation and replay rejects a deleted reservation", (t) => {
  const { directory, writer, metadata } = admittedFixture(t);
  const setup = createNativeProviderSetup(writer, join(directory, "splyce"));
  const first = setup.prepare(metadata);
  const input = { metadata, credentialRef: first.credentialRef };
  assert.equal(setup.commit(input).state, "committed");
  const connection = writer
    .readSetupState(metadata.workspaceId)
    .records.find(({ kind }) => kind === "providerConnection").record;
  assert.ok(connection.sourceIds.includes(first.reservation.recordId));
  writer.noteDeletion(first.reservation.recordId);
  assert.throws(
    () => setup.commit(input),
    (error) => ["SETUP_DELETED", "SETUP_REQUEST_CONFLICT"].includes(error.code),
  );
});

test("pre-change Store can read and export a committed reservation record", (t) => {
  const { directory, host, writer, metadata } = admittedFixture(t);
  const setup = createNativeProviderSetup(writer, join(directory, "splyce"));
  const prepared = setup.prepare(metadata);
  setup.commit({ metadata, credentialRef: prepared.credentialRef });
  host.close();
  writer.close();
  const oldSource = spawnSync(
    "git",
    [
      "show",
      "f8ac9bddd8b14336ba28c5e2ffc5f89816657d40:packages/splyce-pi/src/store.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(oldSource.status, 0, oldSource.stderr);
  const fixture = join(directory, "old-reader");
  mkdirSync(fixture);
  writeFileSync(join(fixture, "package.json"), '{"type":"module"}');
  for (const name of ["contracts.js", "setup-metadata.js"])
    copyFileSync(
      join(root, "packages/splyce-pi/dist", name),
      join(fixture, name),
    );
  writeFileSync(join(fixture, "store.ts"), oldSource.stdout);
  const compile = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import ts from 'typescript'; import {readFileSync,writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], ts.transpileModule(readFileSync(process.argv[1], 'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);`,
      join(fixture, "store.ts"),
      join(fixture, "store.js"),
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(compile.status, 0, compile.stderr);
  const runner = `import { Store } from ${JSON.stringify(new URL("file:///" + join(fixture, "store.js").replaceAll("\\", "/")).href)}; const s = Store.open(process.argv[1], {readOnly:true}); try { const row=s.get(process.argv[2]); if (row.record.recordId !== process.argv[2]) process.exitCode=2; s.exportJSONL(process.argv[3]); } finally { s.close(); }`;
  const output = join(fixture, "old-export.jsonl");
  const read = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      runner,
      join(directory, "splyce", "store.db"),
      prepared.reservation.recordId,
      output,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(read.status, 0, read.stderr);
  assert.ok(
    readFileSync(output, "utf8").includes(prepared.reservation.recordId),
  );
});

test("intent and reservation commit atomically and can retry after a failed transaction", (t) => {
  const { directory, writer, metadata } = admittedFixture(t);
  const rootDir = join(directory, "splyce");
  const db = new DatabaseSync(join(rootDir, "store.db"));
  db.exec(
    "CREATE TRIGGER fail_reservation BEFORE INSERT ON records WHEN NEW.record_id GLOB 'setup:*:credres' BEGIN SELECT RAISE(ABORT, 'injected reservation failure'); END",
  );
  const setup = createNativeProviderSetup(writer, rootDir);
  assert.throws(() => setup.prepare(metadata));
  const rows = writer.readSetupState(metadata.workspaceId).records;
  assert.equal(
    rows.some(({ record }) =>
      record.artifactId?.startsWith("native-setup:request:"),
    ),
    false,
  );
  assert.equal(
    rows.some(({ record }) => record.recordId.endsWith(":credres")),
    false,
  );
  db.exec("DROP TRIGGER fail_reservation");
  db.close();
  assert.equal(setup.prepare(metadata).reservation.created, true);
});

test("a surviving intent with a physically missing reservation fails closed", (t) => {
  const { directory, host, writer, metadata } = admittedFixture(t);
  const rootDir = join(directory, "splyce");
  const setup = createNativeProviderSetup(writer, rootDir);
  const first = setup.prepare(metadata);
  host.close();
  writer.close();
  const db = new DatabaseSync(join(rootDir, "store.db"));
  db.prepare("DELETE FROM records WHERE record_id = ?").run(
    first.reservation.recordId,
  );
  db.close();
  const reopened = Store.open(join(rootDir, "store.db"));
  const retry = createNativeProviderSetup(reopened, rootDir);
  const cursor = reopened.cursor();
  assert.throws(
    () => retry.prepare(metadata),
    (error) => error.code === "SETUP_REQUEST_CONFLICT",
  );
  assert.equal(reopened.cursor(), cursor);
  reopened.close();
});

test("keep reserves the actual current connection reference", (t) => {
  const { directory, writer, metadata } = admittedFixture(t);
  const setup = createNativeProviderSetup(writer, join(directory, "splyce"));
  const first = setup.prepare(metadata);
  setup.commit({ metadata, credentialRef: first.credentialRef });
  const next = {
    ...metadata,
    requestId: "request2",
    credentialKind: "keep",
    expectedConnectionRevision: "c1",
    expectedEndpointRevision: "r1",
    expectedProfileRevision: "p1",
  };
  const kept = setup.prepare(next);
  assert.equal(kept.credentialRef, first.credentialRef);
  assert.equal(kept.reservation.created, true);
  assert.equal(
    setup.commit({ metadata: next, credentialRef: kept.credentialRef }).state,
    "committed",
  );
});
