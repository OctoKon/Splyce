import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { runNativeOpenAIChat } from "../vendor/pi/packages/ai/dist/api/native-openai-chat.js";
import { NativeProviderRequests } from "../packages/splyce-pi/dist/native-provider.js";
import { NativeCredentialResolver } from "../packages/splyce-pi/dist/credential-resolver.js";
import {
  NativePolicy,
  actionArgumentsDigest,
} from "../packages/splyce-pi/dist/policy.js";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { createNativeModelProvider } from "../packages/splyce-pi/src/native-model-provider.mjs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSplyceOwner } from "../vendor/pi/packages/agent/dist/splyce-readiness.js";
import { AuthStorage } from "../vendor/pi/packages/coding-agent/dist/core/auth-storage.js";
import { InMemoryCodingAgentModelsStore } from "../vendor/pi/packages/coding-agent/dist/core/models-store.js";
const records = JSON.parse(
  await readFile(
    new URL("./fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const secret = `fixture-${crypto.randomUUID()}+/"`;
const target = `splyce-credential:v1:${"a".repeat(64)}`;
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "splyce-provider-"));
  const path = join(dir, "store.db");
  const store = Store.open(path);
  const caller = {
    sessionId: "s1",
    configRevision: "cfg1",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference: () => true,
  };
  const args = { model: "fixture-model", stream: true, messages: [] };
  const semantic = {
    schema: "splyce-provider-request-v1",
    apiFamily: "openai-completions",
    endpointRef: "endpoint",
    model: "fixture-model",
    context: {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
      tools: [],
    },
    options: {
      model: { maxTokens: 1024, compat: { maxTokensField: "max_tokens" } },
    },
  };
  if (options.model) semantic.options.model = options.model;
  if (options.context) semantic.context = options.context;
  const controller = new AbortController();
  let connection = {
    ...records.providerConnection,
    providerConnectionId: "connection",
    apiFamily: "openai-completions",
    revision: "revision1",
    endpointRef: "endpoint",
  };
  let received = 0;
  const history = [];
  const bodies = [];
  const server = createServer((req, res) => {
    received++;
    const independent = Store.open(path);
    history.push(
      independent
        .list("w-demo")
        .records.map(({ kind, record }) => [
          kind,
          record.state ?? record.effectState,
        ]),
    );
    independent.close();
    assert.equal(
      req.headers.authorization === `Bearer ${secret}`,
      true,
      "native credential attached",
    );
    assert.equal(req.headers["x-api-key"], undefined);
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      options.received?.(req, res);
      if (options.withholdHeaders) return;
      if (options.redirect) {
        res.writeHead(302, { location: "/elsewhere" });
        res.end();
      } else {
        res.writeHead(options.status ?? 200, {
          "content-type": options.contentType ?? "text/event-stream",
        });
        res.write(
          options.raw ?? sse(options.text ?? "hello", !options.noTerminal),
        );
        if (options.finish) options.finish(res);
        else res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/chat/completions`;
  if (options.model)
    options.model.baseUrl = url.slice(0, -"/chat/completions".length);
  const observeIdentity = () => {
    const stat = statSync(dir, { bigint: true });
    assert.ok(stat.isDirectory());
    return { volumeSerial: String(stat.dev), fileId: String(stat.ino) };
  };
  const workspace = store.admitWorkspace(
    { canonicalPath: dir, ...observeIdentity() },
    caller,
  );
  const origin = new URL(url).origin;
  const grant = store.mintGrant(
    {
      workspaceId: workspace.workspaceId,
      sessionId: caller.sessionId,
      capability: "net.provider",
      scope: "session",
      origin: options.grantOrigin ?? origin,
    },
    caller,
  );
  store.append(
    {
      kind: "run",
      record: {
        ...records.run,
        workspaceId: workspace.workspaceId,
        grantIds: [grant.grantId],
      },
    },
    caller,
  );
  const active = { ...caller, grantIds: [grant.grantId], planMode: false };
  const identity = {
    observe(workspaceId) {
      assert.equal(workspaceId, workspace.workspaceId);
      return observeIdentity();
    },
  };
  const policy = new NativePolicy(store, caller, () => active, identity);
  const permit = {
    toolCallId: "call-1",
    toolName: "provider_request",
    actionId: "a1",
    runRecordId: "rec-run",
    grantId: grant.grantId,
    parentActionId: null,
    capabilityId: "cap1",
    capabilityVersion: "1",
    argumentsArtifactId: "args1",
    argumentsDigest: actionArgumentsDigest(semantic),
    targetScopeId: "w-demo",
    idempotencyKey: "request-1",
    ownership: store.acquireWorkspace(workspace.workspaceId, caller.sessionId),
    capability: "net.provider",
    origin,
  };
  policy.authorize(permit);
  const frames = [];
  let control;
  control = new NativeControl(async (frame) => {
    frames.push(frame.native.method);
    if (frame.native.method === "credential.read") await options.read?.();
    if (frame.native.method === "credential.scope.close") {
      assert.equal(
        store.list("w-demo").records.filter((r) => r.kind === "outcome").length,
        0,
      );
      await options.close?.();
    }
    if (frame.native.method === "credential.scope.close" && options.failClose) {
      control.accept({
        native: {
          id: frame.native.id,
          ok: false,
          error: { code: "CREDENTIAL_UNAVAILABLE" },
        },
      });
      return;
    }
    control.accept({
      native: {
        id: frame.native.id,
        ok: true,
        value:
          frame.native.method === "credential.read"
            ? { secret }
            : frame.native.method === "credential.status"
              ? { present: options.present ?? false }
              : {},
      },
    });
  });
  let owner;
  const resolver = new NativeCredentialResolver({
    env: {},
    readCredentialStore: (target, request) =>
      owner.readCredentialStore(target, request),
  });
  resolver.register({
    providerConnectionId: "connection",
    connectionRevision: "revision1",
    endpointRef: "endpoint",
    egressPolicyRef: "egress",
    source: { kind: "credentialStore", target },
  });
  owner = new NativeProviderRequests(policy, resolver, control);
  const binding = {
    permit,
    args: semantic,
    request: {
      providerConnectionId: "connection",
      connectionRevision: "revision1",
      endpointRef: "endpoint",
      egressPolicyRef: "egress",
      actionId: "a1",
      signal: controller.signal,
    },
    connection,
    currentConnection: () => connection,
    admittedUrl: url,
    modelId: "fixture-model",
    api: "openai-completions",
    maxRequestBytes: 4096,
    headersTimeoutMs: options.headersTimeoutMs ?? 1000,
    profileRevision: "profile1",
    credentialTarget: target,
    allowLocalLoopback: true,
  };
  t.after(async () => {
    control.shutdown();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const scope = options.deferScope ? undefined : owner.createScope(binding);
  return {
    owner,
    control,
    resolver,
    store,
    scope,
    binding,
    frames,
    history,
    bodies,
    controller,
    url,
    args,
    semantic,
    get received() {
      return received;
    },
    revoke() {
      store.revokeGrant(grant.grantId, caller);
      assert.deepEqual(active.grantIds, [grant.grantId]);
    },
    change() {
      connection = { ...connection, revision: "revision2" };
    },
    fetch: (request) =>
      request.fetch(url, {
        method: "POST",
        body: JSON.stringify(args),
        headers: { "x-api-key": "untrusted" },
      }),
  };
}

function sse(text, terminal = true) {
  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({
      id: "chat-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  return (
    (Array.isArray(text) ? text : [text])
      .map((content, index) =>
        chunk({ ...(index === 0 ? { role: "assistant" } : {}), content }),
      )
      .join("") + (terminal ? chunk({}, "stop") + "data: [DONE]\n\n" : "")
  );
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function run(f, events, onEvent = () => {}) {
  const snapshot = f.owner.semantic(f.scope);
  assert.ok(Object.isFrozen(snapshot.context.messages));
  return runNativeOpenAIChat({
    port: f.owner.port,
    scope: f.scope,
    model: {
      api: snapshot.apiFamily,
      id: snapshot.model,
      name: "Fixture model",
      provider: "openai",
      baseUrl: f.url.slice(0, -"/chat/completions".length),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
      ...snapshot.options.model,
    },
    context: snapshot.context,
    onEvent: async (event) => {
      // This private owner bridge receives the actual SDK event before publication.
      f.owner.observe(f.scope, event);
      assert.equal(
        f.store.list("w-demo").records.filter((r) => r.kind === "outcome")
          .length,
        0,
      );
      assert.equal(f.resolver.redact(secret).includes(secret), false);
      events.push(structuredClone(event));
      await onEvent(event);
    },
  });
}
const outcomes = (f) =>
  f.store.list("w-demo").records.filter((r) => r.kind === "outcome");

test("actual SDK terminal and reader cancel precede native credential close and durable success", async (t) => {
  const closing = deferred(),
    release = deferred(),
    disconnected = deferred(),
    cancelEntered = deferred(),
    cancelRelease = deferred();
  let cancelCompleted = false;
  const physicalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await physicalFetch(...args);
    const body = response.body;
    const observedBody = new Proxy(body, {
      get(target, property) {
        if (property === "getReader")
          return (...args) => {
            const reader = target.getReader(...args);
            return new Proxy(reader, {
              get(active, key) {
                if (key === "cancel")
                  return async (...args) => {
                    cancelEntered.resolve();
                    await cancelRelease.promise;
                    const result = await active.cancel(...args);
                    cancelCompleted = true;
                    return result;
                  };
                const value = Reflect.get(active, key, active);
                return typeof value === "function" ? value.bind(active) : value;
              },
            });
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(response, {
      get(target, property) {
        if (property === "body") return observedBody;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  t.after(() => {
    globalThis.fetch = physicalFetch;
    cancelRelease.resolve();
    release.resolve();
  });
  const f = await fixture(t, {
    finish: (res) => {
      res.once("close", disconnected.resolve);
    },
    close: async () => {
      assert.equal(
        cancelCompleted,
        true,
        "physical reader cancellation must settle before credential close",
      );
      closing.resolve();
      await release.promise;
    },
  });
  const events = [];
  const operation = run(f, events);
  await cancelEntered.promise;
  assert.equal(cancelCompleted, false);
  assert.equal(f.frames.includes("credential.scope.close"), false);
  assert.equal(outcomes(f).length, 0);
  cancelRelease.resolve();
  await closing.promise;
  assert.equal(events.filter((e) => e.type === "done").length, 1);
  assert.equal(outcomes(f).length, 0);
  release.resolve();
  const result = await operation;
  await disconnected.promise;
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(
    result.content.map((p) => p.text),
    ["hello"],
  );
  assert.equal(f.received, 1);
  assert.deepEqual(JSON.parse(f.bodies[0]).messages, [
    { role: "user", content: "hello" },
  ]);
  assert.deepEqual(f.history[0].slice(-3), [
    ["action", "proposed"],
    ["action", "approved"],
    ["action", "running"],
  ]);
  assert.deepEqual(f.frames, [
    "credential.scope.open",
    "credential.read",
    "credential.scope.close",
  ]);
  assert.equal(outcomes(f)[0].record.effectState, "observed-success");
  assert.equal(f.resolver.redact(secret).includes(secret), true);
});

test("actual SDK uses the original native semantic snapshot after caller mutation", async (t) => {
  const f = await fixture(t);
  f.semantic.context.messages[0].content = "changed by caller";
  f.semantic.context.messages[0].timestamp = 999;
  f.semantic.options.model.maxTokens = 7;
  f.semantic.options.model.compat.maxTokensField = "max_completion_tokens";
  f.semantic.model = "changed-model";
  const snapshot = f.owner.semantic(f.scope);
  assert.deepEqual(snapshot.context.messages, [
    { role: "user", content: "hello", timestamp: 0 },
  ]);
  assert.deepEqual(snapshot.options, {
    model: { maxTokens: 1024, compat: { maxTokensField: "max_tokens" } },
  });
  assert.equal(snapshot.model, "fixture-model");
  const events = [];
  const result = await run(f, events);
  const wire = JSON.parse(f.bodies[0]);
  assert.deepEqual(wire.messages, [{ role: "user", content: "hello" }]);
  assert.equal(wire.model, "fixture-model");
  assert.equal(wire.max_tokens, 1024);
  assert.equal(wire.max_completion_tokens, undefined);
  assert.equal(wire.stream, true);
  assert.equal(result.content[0].text, "hello");
  assert.equal(outcomes(f)[0].record.effectState, "observed-success");
});

test("actual SDK stream abort without provider terminal cannot record success", async (t) => {
  const f = await fixture(t, { noTerminal: true, finish: () => {} });
  const events = [];
  await assert.rejects(
    run(f, events, (event) => {
      if (event.type === "text_delta") f.controller.abort();
    }),
    { message: "Native OpenAI request failed" },
  );
  assert.equal(f.received, 1);
  assert.equal(
    events.some((e) => e.type === "done"),
    false,
  );
  assert.ok(outcomes(f).length > 0);
  assert.equal(
    outcomes(f).some((r) => r.record.effectState === "observed-success"),
    false,
  );
  assert.equal(f.frames.at(-1), "credential.scope.close");
});

const encodings = {
  raw: { encode: (s) => s, decode: (s) => s },
  base64: {
    encode: (s) => Buffer.from(s).toString("base64"),
    decode: (s) => Buffer.from(s, "base64").toString(),
  },
  base64url: {
    encode: (s) => Buffer.from(s).toString("base64url"),
    decode: (s) => Buffer.from(s, "base64url").toString(),
  },
  url: { encode: encodeURIComponent, decode: decodeURIComponent },
  json: {
    encode: (s) => JSON.stringify(s).slice(1, -1),
    decode: (s) => JSON.parse(`"${s}"`),
  },
};
for (const [name, encoding] of Object.entries(encodings)) {
  test(`genuine resolver and actual SDK keep ${name} credential fixture unrecoverable`, async (t) => {
    const encoded = encoding.encode(secret);
    const sentinel = "harmless sentinel";
    const midpoint = Math.floor(encoded.length / 2);
    const f = await fixture(t, {
      text: [
        sentinel + " ",
        encoded.slice(0, midpoint),
        encoded.slice(midpoint),
        " end sentinel",
      ],
    });
    const events = [];
    let rawProbe, variantProbe;
    const result = await run(f, events, () => {
      rawProbe = f.resolver.redact(secret) !== secret;
      variantProbe = f.resolver.redact(encoded) !== encoded;
    });
    assert.equal(
      rawProbe,
      true,
      "genuine resolver must redact the raw fixture while leased",
    );
    if (name !== "raw")
      assert.equal(
        variantProbe,
        true,
        "genuine resolver must redact the encoded fixture while leased",
      );
    const outputs = events.flatMap((value) => {
      const strings = [];
      const visit = (item) => {
        if (typeof item === "string") strings.push(item);
        else if (item && typeof item === "object")
          Object.values(item).forEach(visit);
      };
      visit(value);
      return strings;
    });
    const recovered = outputs.some((output) => {
      try {
        return encoding.decode(output).includes(secret);
      } catch {
        return false;
      }
    });
    assert.equal(
      recovered,
      false,
      "encoded fixture recovered from observer output",
    );
    const observedText = events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.delta)
      .join("");
    const finalText = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    for (const text of [observedText, finalText]) {
      assert.equal(
        text.startsWith(sentinel),
        true,
        "harmless prefix must survive",
      );
      assert.equal(
        text.endsWith("end sentinel"),
        true,
        "harmless suffix must survive",
      );
      assert.equal(
        text.includes(encoded),
        false,
        "encoded fixture recovered from ordered text",
      );
      let reconstructed = text;
      try {
        reconstructed = encoding.decode(
          text.slice(sentinel.length + 1, -" end sentinel".length),
        );
      } catch {}
      assert.equal(
        reconstructed.includes(secret),
        false,
        "encoded fixture recovered after ordered decoding",
      );
    }
    const resultRecovered = result.content.some((part) => {
      try {
        return (
          typeof part.text === "string" &&
          encoding.decode(part.text).includes(secret)
        );
      } catch {
        return false;
      }
    });
    assert.equal(
      resultRecovered,
      false,
      "encoded fixture recovered from result",
    );
    assert.equal(outcomes(f)[0].record.effectState, "observed-success");
  });
}

test("native provider publishes terminal only after credential close and durable outcome", async (t) => {
  const closing = deferred(),
    release = deferred();
  const model = {
    api: "openai-completions",
    id: "fixture-model",
    name: "Fixture",
    provider: "openai",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const f = await fixture(t, {
    model,
    close: async () => {
      closing.resolve();
      await release.promise;
    },
  });
  t.after(() => release.resolve());
  const provider = createNativeModelProvider({
    model,
    credentialRef: target,
    control: f.control,
    requests: f.owner,
    admit: async () => f.scope,
    assertCurrent() {},
  });
  const stream = provider.stream(model, f.semantic.context, {
    signal: f.controller.signal,
  });
  const events = [];
  const reading = (async () => {
    for await (const event of stream) events.push(event);
  })();
  await closing.promise;
  assert.equal(
    events.some((e) => e.type === "done"),
    false,
  );
  assert.equal(outcomes(f).length, 0);
  release.resolve();
  await reading;
  assert.equal(events.at(-1).type, "done");
  assert.equal(outcomes(f)[0].record.effectState, "observed-success");
  assert.equal(JSON.parse(f.bodies[0]).messages[0].content, "hello");
});

test("native provider rejects forged scope and failed credential close", async (t) => {
  const model = {
    api: "openai-completions",
    id: "fixture-model",
    name: "Fixture",
    provider: "openai",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const f = await fixture(t, { model, failClose: true });
  const make = (admit) =>
    createNativeModelProvider({
      model,
      credentialRef: target,
      control: f.control,
      requests: f.owner,
      admit,
      assertCurrent() {},
    });
  const forged = await make(async () => ({}))
    .stream(model, f.semantic.context)
    .result();
  assert.equal(forged.stopReason, "error");
  assert.equal(f.received, 0);
  const result = await make(async () => f.scope)
    .stream(model, f.semantic.context)
    .result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "Native OpenAI request failed");
  assert.equal(
    outcomes(f).some((r) => r.record.effectState === "observed-success"),
    false,
  );
});

test("native adapter rejects hidden and inherited options before admission", async (t) => {
  const model = {
    api: "openai-completions",
    id: "fixture-model",
    name: "Fixture",
    provider: "openai",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const f = await fixture(t, { model });
  let admissions = 0,
    getters = 0;
  const provider = createNativeModelProvider({
    model,
    credentialRef: target,
    control: f.control,
    requests: f.owner,
    admit: async () => {
      admissions++;
      return f.scope;
    },
    assertCurrent() {},
  });
  const accessor = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      getters++;
      return undefined;
    },
  });
  for (const options of [
    Object.create({ temperature: 0.5 }),
    Object.defineProperty({}, "temperature", { value: 0.5 }),
    { [Symbol("semantic")]: true },
    accessor,
    [],
  ]) {
    assert.equal(
      (await provider.stream(model, f.semantic.context, options).result())
        .stopReason,
      "error",
    );
  }
  assert.equal(admissions, 0);
  assert.equal(getters, 0);
  assert.equal(f.received, 0);
  assert.equal(f.frames.includes("credential.read"), false);
  const options = Object.assign(Object.create(null), {
    signal: f.controller.signal,
  });
  assert.equal(
    (await provider.stream(model, f.semantic.context, options).result())
      .stopReason,
    "stop",
  );
  assert.equal(admissions, 1);
  assert.equal(f.received, 1);
});

test("native provider status uses private control and cancellation prevents admission", async (t) => {
  const model = {
    api: "openai-completions",
    id: "fixture-model",
    name: "Fixture",
    provider: "openai",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const f = await fixture(t, { model, present: true });
  let admitted = false;
  const provider = createNativeModelProvider({
    model,
    credentialRef: target,
    control: f.control,
    requests: f.owner,
    admit: async () => {
      admitted = true;
      return f.scope;
    },
    assertCurrent() {},
  });
  assert.deepEqual(
    await provider.auth.apiKey.check({ signal: f.controller.signal }),
    { type: "api_key", source: "Windows Credential Manager" },
  );
  f.controller.abort();
  assert.equal(
    (
      await provider
        .stream(model, f.semantic.context, { signal: f.controller.signal })
        .result()
    ).stopReason,
    "error",
  );
  assert.equal(admitted, false);
  assert.equal(f.received, 0);
  await assert.rejects(
    provider.auth.apiKey.check({ signal: f.controller.signal }),
    { message: "Native OpenAI request failed" },
  );
});

test("sealed ModelRuntime composes the native provider with real policy, credentials and HTTP", async (t) => {
  const model = {
    api: "openai-completions",
    id: "fixture-model",
    name: "Fixture",
    provider: "openai",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const messages = [
    { role: "system", content: "fixture instruction", timestamp: 0 },
    { role: "user", content: "hello", timestamp: 0 },
  ];
  const f = await fixture(t, {
    model,
    present: true,
    context: { messages, tools: [] },
  });
  const owner = createSplyceOwner(() => {});
  t.after(() => owner.dispose());
  const options = {
    credentials: AuthStorage.inMemory(),
    modelsStore: new InMemoryCodingAgentModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  };
  owner.bind(options, "model-runtime-options");
  const runtime = await ModelRuntime.create(options);
  let admissions = 0,
    getters = 0;
  const provider = createNativeModelProvider({
    model,
    credentialRef: target,
    control: f.control,
    requests: f.owner,
    admit: async () => {
      admissions++;
      return f.scope;
    },
    assertCurrent() {},
  });
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "ambient-unrelated";
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  });
  await runtime.registerNativeProvider(provider);
  assert.deepEqual(await runtime.checkAuth("openai"), {
    type: "api_key",
    source: "Windows Credential Manager",
  });
  assert.deepEqual(await runtime.getAvailable(), [model]);
  const context = {
    systemPrompt: "fixture instruction",
    tools: [],
    messages: [messages[1]],
  };
  for (const candidate of [
    { ...model, id: "another-model" },
    { ...model, api: "openai-responses" },
    { ...model, baseUrl: "http://127.0.0.1:1" },
  ]) {
    assert.equal(
      (
        await runtime
          .streamSimple(candidate, context, { signal: f.controller.signal })
          .result()
      ).stopReason,
      "error",
    );
    assert.equal(f.received, 0);
  }
  const aborted = new AbortController();
  aborted.abort();
  const accessor = Object.defineProperty({}, "signal", {
    enumerable: true,
    get() {
      getters++;
      return f.controller.signal;
    },
  });
  const framesBefore = f.frames.length;
  for (const requestOptions of [
    Object.create({ signal: aborted.signal }),
    Object.create({ temperature: 0.5 }),
    Object.defineProperty({}, "temperature", { value: 0.5 }),
    accessor,
    { [Symbol("semantic")]: true },
    [],
  ]) {
    assert.equal(
      (await runtime.streamSimple(model, context, requestOptions).result())
        .stopReason,
      "error",
    );
    assert.equal(admissions, 0);
    assert.equal(getters, 0);
    assert.equal(f.received, 0);
    assert.equal(f.frames.length, framesBefore);
  }
  const requestOptions = Object.assign(Object.create(null), {
    signal: f.controller.signal,
  });
  const stream = runtime.streamSimple(model, context, requestOptions);
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.at(-1).type, "done");
  assert.equal((await stream.result()).content[0].text, "hello");
  assert.deepEqual(JSON.parse(f.bodies[0]).messages, [
    { role: "system", content: "fixture instruction" },
    { role: "user", content: "hello" },
  ]);
  assert.equal(f.received, 1);
  assert.equal(admissions, 1);
  assert.equal(
    f.frames.filter((frame) => frame === "credential.scope.close").length,
    1,
  );
  assert.equal(outcomes(f)[0].record.effectState, "observed-success");
});

test("native provider bounds each raw SSE event and preserves larger valid streams", async (t) => {
  const model = {
    api: "openai-completions",
    id: "fixture-model",
    name: "Fixture",
    provider: "openai",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const oversized = "data: " + "x".repeat(1048576);
  let cancelled = false;
  const physicalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await physicalFetch(...args);
    return new Proxy(response, {
      get(target, property) {
        if (property === "body")
          return new Proxy(target.body, {
            get(body, key) {
              if (key === "getReader")
                return (...args) => {
                  const reader = body.getReader(...args);
                  return new Proxy(reader, {
                    get(active, name) {
                      if (name === "cancel")
                        return async (...args) => {
                          await active.cancel(...args);
                          cancelled = true;
                        };
                      const value = Reflect.get(active, name, active);
                      return typeof value === "function"
                        ? value.bind(active)
                        : value;
                    },
                  });
                };
              const value = Reflect.get(body, key, body);
              return typeof value === "function" ? value.bind(body) : value;
            },
          });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  t.after(() => {
    globalThis.fetch = physicalFetch;
  });
  const f = await fixture(t, {
    model,
    raw: oversized,
    finish: () => {},
    close: () =>
      assert.equal(
        cancelled,
        true,
        "physical cancel precedes credential close",
      ),
  });
  const provider = createNativeModelProvider({
    model,
    credentialRef: target,
    control: f.control,
    requests: f.owner,
    admit: async () => f.scope,
    assertCurrent() {},
  });
  const stream = provider.stream(model, f.semantic.context);
  const events = [];
  const reading = (async () => {
    for await (const event of stream) events.push(event);
  })();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    f.controller.abort();
  }, 1000);
  try {
    await reading;
  } finally {
    clearTimeout(timer);
  }
  assert.equal(timedOut, false, "oversized event must fail before timeout");
  assert.equal(
    cancelled,
    true,
    "oversized event must physically cancel before timeout",
  );
  assert.equal((await stream.result()).stopReason, "error");
  assert.equal(
    events.some((event) => event.type === "done"),
    false,
  );
  assert.equal(
    outcomes(f).some((r) => r.record.effectState === "observed-success"),
    false,
  );
});

test("native provider accepts CRLF multi-line events and total streams over the event limit", async (t) => {
  const model = {
    api: "openai-completions",
    id: "fixture-model",
    name: "Fixture",
    provider: "openai",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const frame = sse("ok").split("\n\n")[0];
  const raw =
    (
      ":" +
      "c".repeat(2000) +
      "\r\n" +
      frame.replace("data: ", "data: \r\ndata: ") +
      "\r\n\r\n"
    ).repeat(550) + sse([], true).replaceAll("\n", "\r\n");
  assert.ok(Buffer.byteLength(raw) > 1048576);
  const f = await fixture(t, { model, raw });
  const provider = createNativeModelProvider({
    model,
    credentialRef: target,
    control: f.control,
    requests: f.owner,
    admit: async () => f.scope,
    assertCurrent() {},
  });
  const result = await provider.stream(model, f.semantic.context).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(outcomes(f)[0].record.effectState, "observed-success");
});

for (const [name, response] of [
  [
    "CRLF multi-line event",
    {
      raw:
        ": fixture\r\ndata: " +
        "x".repeat(600000) +
        "\r\ndata: " +
        "y".repeat(500000),
    },
  ],
  [
    "non-SSE error body",
    {
      status: 400,
      contentType: "application/json",
      raw: "{" + "x".repeat(1100000),
    },
  ],
  [
    "SSE error body with many small events",
    { status: 400, raw: "x\n\n".repeat(400000) },
  ],
]) {
  test(`native provider rejects oversized ${name} before credential close`, async (t) => {
    const model = {
      api: "openai-completions",
      id: "fixture-model",
      name: "Fixture",
      provider: "openai",
      baseUrl: "http://127.0.0.1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    };
    let cancelled = false;
    const physicalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const original = await physicalFetch(...args);
      return new Proxy(original, {
        get(target, property) {
          if (property === "body")
            return new Proxy(target.body, {
              get(body, key) {
                if (key === "cancel")
                  return async (...args) => {
                    await body.cancel(...args);
                    cancelled = true;
                  };
                if (key === "getReader")
                  return (...args) => {
                    const reader = body.getReader(...args);
                    return new Proxy(reader, {
                      get(active, name) {
                        if (name === "cancel")
                          return async (...args) => {
                            await active.cancel(...args);
                            cancelled = true;
                          };
                        const value = Reflect.get(active, name, active);
                        return typeof value === "function"
                          ? value.bind(active)
                          : value;
                      },
                    });
                  };
                const value = Reflect.get(body, key, body);
                return typeof value === "function" ? value.bind(body) : value;
              },
            });
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    t.after(() => {
      globalThis.fetch = physicalFetch;
    });
    const f = await fixture(t, {
      ...response,
      model,
      finish: () => {},
      close: () =>
        assert.equal(
          cancelled,
          true,
          "physical cancellation precedes credential close",
        ),
    });
    const provider = createNativeModelProvider({
      model,
      credentialRef: target,
      control: f.control,
      requests: f.owner,
      admit: async () => f.scope,
      assertCurrent() {},
    });
    const stream = provider.stream(model, f.semantic.context);
    const events = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      f.controller.abort();
    }, 1000);
    try {
      for await (const event of stream) events.push(event);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(timedOut, false, "rejection must precede the test timeout");
    assert.equal(cancelled, true);
    assert.equal((await stream.result()).stopReason, "error");
    assert.equal(
      events.some((event) => event.type === "done"),
      false,
    );
    assert.equal(
      outcomes(f).some((r) => r.record.effectState === "observed-success"),
      false,
    );
  });
}

test("native provider closes credential after rejected upstream cancellation without success", async (t) => {
  const model = {
    api: "openai-completions",
    id: "fixture-model",
    name: "Fixture",
    provider: "openai",
    baseUrl: "http://127.0.0.1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  let cancelRejected = false;
  const physicalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const original = await physicalFetch(...args);
    return new Proxy(original, {
      get(target, property) {
        if (property === "body")
          return new Proxy(target.body, {
            get(body, key) {
              if (key === "getReader")
                return (...args) => {
                  const reader = body.getReader(...args);
                  return new Proxy(reader, {
                    get(active, name) {
                      if (name === "cancel")
                        return async () => {
                          cancelRejected = true;
                          throw new Error("fixture cancellation failure");
                        };
                      const value = Reflect.get(active, name, active);
                      return typeof value === "function"
                        ? value.bind(active)
                        : value;
                    },
                  });
                };
              const value = Reflect.get(body, key, body);
              return typeof value === "function" ? value.bind(body) : value;
            },
          });
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  t.after(() => {
    globalThis.fetch = physicalFetch;
  });
  const f = await fixture(t, {
    model,
    raw: "data: " + "x".repeat(1100000),
    finish: () => {},
    close: () =>
      assert.equal(
        cancelRejected,
        true,
        "cancel rejection precedes credential close",
      ),
  });
  const provider = createNativeModelProvider({
    model,
    credentialRef: target,
    control: f.control,
    requests: f.owner,
    admit: async () => f.scope,
    assertCurrent() {},
  });
  const stream = provider.stream(model, f.semantic.context);
  const events = [];
  const timer = setTimeout(() => f.controller.abort(), 1000);
  try {
    for await (const event of stream) events.push(event);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(cancelRejected, true);
  assert.equal(f.frames.at(-1), "credential.scope.close");
  assert.equal((await stream.result()).stopReason, "error");
  assert.equal(
    events.some((event) => event.type === "done"),
    false,
  );
  assert.equal(
    outcomes(f).some((r) => r.record.effectState === "observed-success"),
    false,
  );
});
