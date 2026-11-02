import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { projectLiveModels } from "../packages/splyce-pi/src/native-live-catalog.mjs";
import {
  encodeFrame,
  runHost,
} from "../packages/splyce-pi/src/engine-host.mjs";
import { ModelsListError } from "../packages/splyce-pi/dist/model-data.js";
import { TRANSPORT_LIMITS } from "../packages/splyce-pi/dist/contracts.js";
const secret = "synthetic-fixture-secret";
test("live catalog uses saved profile, real policy and HTTP with fenced authority", async (t) => {
  const dir = realpathSync.native(
    mkdtempSync(join(tmpdir(), "splyce-catalog-")),
  );
  const project = join(dir, "project");
  mkdirSync(project);
  let data = [
    { id: "first", title: "First", context_length: 8192, tools: true },
  ];
  let requests = 0,
    auth;
  const server = createServer((req, res) => {
    requests++;
    auth = req.headers.authorization;
    assert.equal(req.url, "/v1/models");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const control = new NativeControl(async (frame) => {
    const method = frame.native.method;
    const value =
      method === "credential.read"
        ? { secret }
        : method === "credential.status"
          ? { present: true }
          : method === "credential.redact"
            ? {
                text: frame.native.params.text.replaceAll(secret, "[REDACTED]"),
                redactedCount: frame.native.params.text.includes(secret)
                  ? 1
                  : 0,
              }
            : {};
    control.accept({ native: { id: frame.native.id, ok: true, value } });
  });
  const host = createNativeHost(join(dir, "data"), control);
  t.after(async () => {
    await host.shutdown();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const stat = statSync(project, { bigint: true });
  const { workspaceId } = host.admitWorkspace({
    canonicalPath: project,
    volumeSerial: String(stat.dev),
    fileId: String(stat.ino),
  });
  const metadata = {
    requestId: "setup1",
    workspaceId,
    providerConnectionId: "connection1",
    profileId: "profile1",
    apiFamily: "openai-completions",
    endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    locality: "loopback",
    chat: {
      modelId: "first",
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
  const prepared = host.prepareProviderSetup(metadata);
  host.commitProviderSetup({ metadata, credentialRef: prepared.credentialRef });
  const selection = {
    requestId: "select1",
    workspaceId,
    profileId: "profile1",
    expectedProfileRevision: "p1",
    expectedConfigRevision: "cfg-0",
  };
  const selected = await host.selectProfile(selection, selection.requestId);
  const start = {
    requestId: "start1",
    workspaceId,
    profileId: "profile1",
    expectedConfigRevision: selected.configRevision,
  };
  await host.startSession(start, start.requestId);
  const input = { requestId: "list1", workspaceId, profileId: "profile1" };
  assert.deepEqual(await host.listModels(input), {
    models: [
      { modelId: "first", title: "First", contextWindow: 8192, tools: true },
    ],
    truncated: false,
  });
  assert.equal(auth, `Bearer ${secret}`);
  data = [{ id: "second", credential: secret }];
  const refreshed = await host.listModels({ ...input, requestId: "list2" });
  assert.deepEqual(refreshed, {
    models: [{ modelId: "second" }],
    truncated: false,
  });
  assert.equal(JSON.stringify(refreshed).includes(secret), false);
  data = [{ id: "safe", title: secret }];
  try {
    const echoed = await host.listModels({ ...input, requestId: "echo" });
    assert.equal(JSON.stringify(echoed).includes(secret), false);
  } catch (error) {
    assert.ok(
      [
        "MODEL_CATALOG_INVALID",
        "MODEL_CATALOG_DENIED",
        "MODEL_CATALOG_UNAVAILABLE",
      ].includes(error.code),
    );
    assert.equal(JSON.stringify(error).includes(secret), false);
  }
  data = [];
  assert.deepEqual(await host.listModels({ ...input, requestId: "empty" }), {
    models: [],
    truncated: false,
  });
  data = Array.from({ length: 501 }, (_, i) => ({ id: `model-${i}` }));
  const bounded = await host.listModels({ ...input, requestId: "bounded" });
  assert.equal(bounded.models.length, 500);
  assert.equal(bounded.truncated, true);
  data = [{ id: "bad\u200b" }];
  await assert.rejects(host.listModels({ ...input, requestId: "bad" }), {
    code: "MODEL_CATALOG_INVALID",
  });
  const before = requests;
  await assert.rejects(host.listModels({ ...input, profileId: "other" }), {
    code: "MODEL_CATALOG_DENIED",
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(host.listModels(input, abort.signal), {
    code: "MODEL_CATALOG_DENIED",
  });
  assert.equal(requests, before);
  const writer = Store.open(join(dir, "data", "splyce", "store.db"));
  const grant = writer
    .list(workspaceId)
    .records.find(
      ({ kind, record }) =>
        kind === "grant" && record.capability === "net.provider",
    );
  writer.noteDeletion(grant.record.recordId);
  writer.close();
  await assert.rejects(host.listModels(input), {
    code: "MODEL_CATALOG_DENIED",
  });
  assert.equal(requests, before);
});

test("catalog projection filters API support, bounds UTF-8 output and rejects malformed data", () => {
  const result = projectLiveModels(
    {
      data: [
        { id: "same", supported_endpoints: ["responses"] },
        {
          id: "same",
          supported_endpoints: ["/v1/chat/completions"],
          description: "Description",
          context_length: 4096,
          tools: true,
          paid_only: false,
        },
        { id: "title", title: "Title", description: "ignored" },
      ],
    },
    "openai-completions",
  );
  assert.deepEqual(result, {
    models: [
      {
        modelId: "same",
        title: "Description",
        contextWindow: 4096,
        tools: true,
        paidOnly: false,
      },
      { modelId: "title", title: "Title" },
    ],
    truncated: false,
  });
  const rows = Array.from({ length: 500 }, (_, i) => ({
    id: `m${i}`,
    title: "\u6f22".repeat(256),
  }));
  const bounded = projectLiveModels({ data: rows }, "openai-completions");
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.models.length < 500);
  assert.ok(
    Buffer.byteLength(JSON.stringify(bounded)) <
      TRANSPORT_LIMITS.maxEncodedFrameBytes - 4096,
  );
  for (const raw of [
    null,
    {},
    { data: [null] },
    { data: [{ id: "a", supported_endpoints: "responses" }] },
    { data: [{ id: "a", context_length: 0 }] },
    { data: [{ id: "x" }, { id: "x" }] },
  ])
    assert.throws(() => projectLiveModels(raw, "openai-completions"), {
      code: "MODEL_CATALOG_INVALID",
    });
});

test("framed models.list enforces request and result boundaries and fixed errors", async (t) => {
  const input = new PassThrough(),
    pending = new Map();
  let buffered = Buffer.alloc(0),
    outcome = { models: [], truncated: false },
    calls = 0;
  const output = new Writable({
    write(chunk, _encoding, done) {
      buffered = Buffer.concat([buffered, chunk]);
      while (
        buffered.length >= 4 &&
        buffered.length >= buffered.readUInt32BE(0) + 4
      ) {
        const length = buffered.readUInt32BE(0),
          frame = JSON.parse(buffered.subarray(4, length + 4));
        buffered = buffered.subarray(length + 4);
        const resolve = pending.get(frame.id);
        pending.delete(frame.id);
        resolve(frame);
      }
      done();
    },
  });
  const job = runHost(input, output, () => ({
    listModels: async () => {
      calls++;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    shutdown: async () => {},
  }));
  t.after(() => {
    input.destroy();
    output.destroy();
  });
  const rpc = (id, method, params) => {
    const reply = new Promise((resolve) => pending.set(id, resolve));
    input.write(encodeFrame({ id, method, params }));
    return reply;
  };
  await rpc("native-bootstrap", "native.bootstrap", { appDataDir: "fixture" });
  const request = {
    frame: "setup",
    command: "models.list",
    requestId: "req",
    payload: {
      requestId: "req",
      workspaceId: "workspace",
      profileId: "profile",
    },
  };
  assert.deepEqual((await rpc("ok", "send", request)).value, {
    models: [],
    truncated: false,
  });
  let n = 0;
  for (const payload of [
    { ...request.payload, requestId: "different" },
    { requestId: "req", workspaceId: "workspace" },
    { ...request.payload, endpoint: "http://example.test" },
    { ...request.payload, apiKey: "secret" },
  ]) {
    const reply = await rpc(`bad${n++}`, "send", { ...request, payload });
    assert.equal(reply.error.code, "MODEL_CATALOG_INVALID");
    assert.equal(reply.error.message, "Model catalog unavailable");
  }
  assert.equal(calls, 1);
  outcome = {
    models: [{ modelId: "ok", credentialRef: "secret" }],
    truncated: false,
  };
  assert.equal(
    (await rpc("private", "send", request)).error.code,
    "MODEL_CATALOG_INVALID",
  );
  outcome = new ModelsListError("MODEL_CATALOG_DENIED");
  outcome.message = "private error";
  const denied = await rpc("denied", "send", request);
  assert.deepEqual(denied.error, {
    code: "MODEL_CATALOG_DENIED",
    message: "Model catalog unavailable",
    correlationId: "req",
    retryable: false,
  });
  outcome = new Error("private error");
  assert.equal(
    (await rpc("unknown", "send", request)).error.code,
    "MODEL_CATALOG_UNAVAILABLE",
  );
  await rpc("shutdown", "shutdown", {});
  await job;
});
