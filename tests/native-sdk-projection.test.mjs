import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import * as agentApi from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createSplyceOwner } from "../vendor/pi/packages/agent/dist/splyce-readiness.js";
import { AuthStorage } from "../vendor/pi/packages/coding-agent/dist/core/auth-storage.js";
import { loadExtensionFromFactory } from "../vendor/pi/packages/coding-agent/dist/core/extensions/loader.js";
import { InMemoryCodingAgentModelsStore } from "../vendor/pi/packages/coding-agent/dist/core/models-store.js";
import { NativeCredentialResolver } from "../packages/splyce-pi/dist/credential-resolver.js";
import { NativeProviderRequests } from "../packages/splyce-pi/dist/native-provider.js";
import {
  actionArgumentsDigest,
  NativePolicy,
} from "../packages/splyce-pi/dist/policy.js";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";
import { createNativeModelProvider } from "../packages/splyce-pi/src/native-model-provider.mjs";

const records = JSON.parse(
  await readFile(
    new URL("./fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const unsupported = {
  code: "PROVIDER_OPTIONS_UNSUPPORTED",
  message: "PROVIDER_OPTIONS_UNSUPPORTED",
};
const credentialTarget = `splyce-credential:v1:${"a".repeat(64)}`;

function sse(text) {
  const chunk = (delta, finish_reason = null) =>
    `data: ${JSON.stringify({
      id: "chat-sdk-projection",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
  return (
    chunk({ role: "assistant", content: text }) +
    chunk({}, "stop") +
    "data: [DONE]\n\n"
  );
}

function messageText(message) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}

async function fixture(t, { hook, settings: explicitSettings = {} } = {}) {
  const tempRoot = resolve(tmpdir());
  const dir = await mkdtemp(join(tempRoot, "splyce-sdk-projection-"));
  let store;
  let server;
  let control;
  let session;
  const owner = createSplyceOwner(() => {});
  t.after(async () => {
    session?.dispose();
    owner.dispose();
    control?.shutdown();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    store?.close();
    const child = relative(tempRoot, resolve(dir));
    assert.ok(child && !isAbsolute(child) && !child.startsWith(".."));
    await rm(dir, { recursive: true, force: true });
  });
  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const manager = await SessionManager.createOwned(
    cwd,
    (value) => owner.bindPersistence(value, async (serialized) => serialized),
    join(dir, "sessions"),
  );
  store = Store.open(join(dir, "store.db"));
  const caller = {
    sessionId: manager.getSessionId(),
    configRevision: "cfg1",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference: () => true,
  };
  const secret = `synthetic-sdk-projection-${crypto.randomUUID()}`;
  const bodies = [];
  const histories = [];
  let received = 0;
  server = createServer((request, response) => {
    received++;
    assert.equal(request.headers.authorization === `Bearer ${secret}`, true);
    assert.equal(request.headers["x-api-key"], undefined);
    const observer = Store.open(join(dir, "store.db"));
    try {
      histories.push(observer.list("w-demo").records);
    } finally {
      observer.close();
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse("native SDK reply"));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const url = `${baseUrl}/chat/completions`;
  const model = {
    api: "openai-completions",
    id: "fixture-model",
    name: "Native SDK fixture",
    provider: "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const observe = () => {
    const stat = statSync(cwd, { bigint: true });
    assert.ok(stat.isDirectory());
    return { volumeSerial: String(stat.dev), fileId: String(stat.ino) };
  };
  const workspace = store.admitWorkspace(
    { canonicalPath: cwd, ...observe() },
    caller,
  );
  const grant = store.mintGrant(
    {
      workspaceId: workspace.workspaceId,
      sessionId: caller.sessionId,
      capability: "net.provider",
      scope: "session",
      origin: baseUrl,
    },
    caller,
  );
  store.append(
    {
      kind: "run",
      record: {
        ...records.run,
        piSessionId: caller.sessionId,
        workspaceId: workspace.workspaceId,
        grantIds: [grant.grantId],
      },
    },
    caller,
  );
  const active = { ...caller, grantIds: [grant.grantId], planMode: false };
  const policy = new NativePolicy(store, caller, () => active, {
    observe(workspaceId) {
      assert.equal(workspaceId, workspace.workspaceId);
      return observe();
    },
  });
  const ownership = store.acquireWorkspace(
    workspace.workspaceId,
    caller.sessionId,
  );
  const frames = [];
  control = new NativeControl(async (frame) => {
    frames.push(frame.native.method);
    control.accept({
      native: {
        id: frame.native.id,
        ok: true,
        value:
          frame.native.method === "credential.read"
            ? { secret }
            : frame.native.method === "credential.status"
              ? { present: true }
              : {},
      },
    });
  });
  let requests;
  const resolver = new NativeCredentialResolver({
    env: {},
    readCredentialStore: (target, request) =>
      requests.readCredentialStore(target, request),
  });
  resolver.register({
    providerConnectionId: "connection",
    connectionRevision: "revision1",
    endpointRef: "endpoint",
    egressPolicyRef: "egress",
    source: { kind: "credentialStore", target: credentialTarget },
  });
  requests = new NativeProviderRequests(policy, resolver, control);
  const connection = {
    ...records.providerConnection,
    providerConnectionId: "connection",
    apiFamily: model.api,
    revision: "revision1",
    endpointRef: "endpoint",
  };
  const admitted = [];
  const provider = createNativeModelProvider({
    model,
    credentialRef: credentialTarget,
    control,
    requests,
    assertCurrent() {},
    admit: async (input) => {
      const semantic = {
        schema: "splyce-provider-request-v1",
        apiFamily: input.model.api,
        endpointRef: "endpoint",
        model: input.model.id,
        context: { ...input.context, tools: input.context.tools ?? [] },
        options: { model: input.model },
      };
      const n = admitted.length + 1;
      const permit = {
        toolCallId: `sdk-request-${n}`,
        toolName: "provider_request",
        actionId: `sdk-action-${n}`,
        runRecordId: "rec-run",
        grantId: grant.grantId,
        parentActionId: null,
        capabilityId: "cap1",
        capabilityVersion: "1",
        argumentsArtifactId: `sdk-args-${n}`,
        argumentsDigest: actionArgumentsDigest(semantic),
        targetScopeId: "w-demo",
        idempotencyKey: `sdk-effect-${n}`,
        ownership,
        capability: "net.provider",
        origin: baseUrl,
      };
      policy.authorize(permit);
      const scope = requests.createScope({
        permit,
        args: semantic,
        request: {
          providerConnectionId: "connection",
          connectionRevision: "revision1",
          endpointRef: "endpoint",
          egressPolicyRef: "egress",
          actionId: permit.actionId,
          signal: input.signal ?? new AbortController().signal,
        },
        connection,
        currentConnection: () => connection,
        admittedUrl: url,
        modelId: model.id,
        api: model.api,
        maxRequestBytes: 4 * 1024 * 1024,
        headersTimeoutMs: 10_000,
        profileRevision: caller.profileRevision,
        credentialTarget,
        allowLocalLoopback: true,
      });
      admitted.push(structuredClone(semantic));
      return scope;
    },
  });
  const runtimeOptions = {
    credentials: AuthStorage.inMemory(),
    modelsStore: new InMemoryCodingAgentModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  };
  owner.bind(runtimeOptions, "model-runtime-options");
  const runtime = await ModelRuntime.create(runtimeOptions);
  await runtime.registerNativeProvider(provider);
  assert.equal(runtime.getRegisteredNativeProvider(model.provider), provider);
  assert.deepEqual(await runtime.checkAuth(model.provider), {
    type: "api_key",
    source: "Windows Credential Manager",
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
    ...explicitSettings,
  });
  const eventBus = createEventBus();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    eventBus,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  let hookCalls = 0;
  if (hook) {
    const loaded = resourceLoader.getExtensions();
    loaded.extensions.push(
      await loadExtensionFromFactory(
        (pi) =>
          pi.on(hook, () => {
            hookCalls++;
          }),
        cwd,
        eventBus,
        loaded.runtime,
        `<fixture:${hook}>`,
      ),
    );
  }
  for (const [value, role] of [
    [settings, "settings-manager"],
    [resourceLoader, "resource-loader"],
    [model, "model"],
  ])
    owner.bind(value, role);
  const options = {
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader,
    thinkingLevel: "off",
    tools: [],
  };
  owner.bind(options, "sdk-options");
  ({ session } = await createAgentSession(options));
  assert.equal(session.agent.state.model.provider, model.provider);
  assert.equal(resourceLoader.getExtensions().errors.length, 0);
  assert.equal(resourceLoader.getExtensions().extensions.length, hook ? 1 : 0);
  const events = [];
  session.subscribe((event) => events.push(event));
  return {
    session,
    manager,
    model,
    runtime,
    provider,
    owner,
    store,
    settings,
    frames,
    bodies,
    histories,
    admitted,
    events,
    get received() {
      return received;
    },
    get hookCalls() {
      return hookCalls;
    },
  };
}

async function persistedMessages(f) {
  return (await readFile(f.manager.getSessionFile(), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((row) => row.type === "message")
    .map((row) => row.message);
}

function assertNoProviderEffect(f) {
  assert.equal(f.received, 0);
  assert.equal(f.admitted.length, 0);
  assert.equal(
    f.store
      .list("w-demo")
      .records.some(({ kind }) => kind === "action" || kind === "outcome"),
    false,
  );
  assert.equal(f.frames.filter((name) => name === "credential.read").length, 0);
  assert.equal(
    f.events.some(
      (event) =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "stop",
    ),
    false,
  );
}

test("native SDK projection public prompt reaches HTTP and persists user and assistant", async (t) => {
  const f = await fixture(t);
  await f.session.prompt("native SDK question");
  assert.equal(
    f.received,
    1,
    `actual SDK prompt must dispatch the admitted native HTTP request: ${JSON.stringify(
      {
        admitted: f.admitted.length,
        frames: f.frames,
        errors: f.session.messages
          .filter((entry) => entry.role === "assistant")
          .map((entry) => entry.errorMessage),
        context: f.admitted.map((entry) => ({
          bytes: Buffer.byteLength(JSON.stringify(entry.context)),
          roles: entry.context.messages.map((message) => message.role),
          tools: entry.context.tools.length,
        })),
        effects: f.store
          .list("w-demo")
          .records.filter(({ kind }) => kind === "action" || kind === "outcome")
          .map(({ kind, record }) => ({
            kind,
            state: record.state,
            effectState: record.effectState,
          })),
      },
    )}`,
  );
  assert.equal(f.admitted.length, 1);
  assert.equal(
    f.bodies[0].messages.some(
      (message) =>
        message.role === "user" &&
        messageText(message) === "native SDK question",
    ),
    true,
  );
  assert.equal(
    f.histories[0].some(
      ({ kind, record }) => kind === "action" && record.state === "running",
    ),
    true,
    "durable running receipt must precede physical HTTP",
  );
  const messages = await persistedMessages(f);
  assert.equal(
    messages.some(
      (message) =>
        message.role === "user" &&
        messageText(message) === "native SDK question",
    ),
    true,
  );
  assert.equal(
    messages.some(
      (message) =>
        message.role === "assistant" &&
        message.stopReason === "stop" &&
        messageText(message) === "native SDK reply",
    ),
    true,
    `persisted native terminal: ${JSON.stringify({
      assistant: messages
        .filter((message) => message.role === "assistant")
        .map((message) => ({
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
          text: messageText(message),
        })),
      frames: f.frames,
      effects: f.store
        .list("w-demo")
        .records.filter(({ kind }) => kind === "outcome")
        .map(({ record }) => record.effectState),
    })}`,
  );
  assert.equal(f.session.messages.at(-1).stopReason, "stop");
  assert.equal(
    f.events.some(
      (event) =>
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "stop",
    ),
    true,
  );
  assert.equal(
    f.store
      .list("w-demo")
      .records.filter(
        ({ kind, record }) =>
          kind === "outcome" && record.effectState === "observed-success",
      ).length,
    1,
  );
  assert.equal(
    f.frames.filter((name) => name === "credential.scope.close").length,
    1,
  );
});

test("native SDK projection omits undefined direct request options", async (t) => {
  const f = await fixture(t);
  const stream = await f.session.agent.streamFunction(
    f.model,
    {
      messages: [{ role: "user", content: "undefined options", timestamp: 0 }],
    },
    {
      signal: new AbortController().signal,
      onPayload: undefined,
      onResponse: undefined,
      onProviderStreamEvent: undefined,
      timeoutMs: undefined,
      maxRetries: undefined,
      transport: undefined,
      identity: undefined,
    },
  );
  assert.equal((await stream.result()).stopReason, "stop");
  assert.equal(f.received, 1);
  assert.equal(f.admitted.length, 1);
  const nullPrototype = Object.assign(Object.create(null), {
    signal: new AbortController().signal,
    temperature: undefined,
  });
  const nullStream = await f.session.agent.streamFunction(
    f.model,
    {
      messages: [
        { role: "user", content: "null prototype options", timestamp: 0 },
      ],
    },
    nullPrototype,
  );
  assert.equal((await nullStream.result()).stopReason, "stop");
  assert.equal(f.received, 2);
  assert.equal(f.admitted.length, 2);
  const beforeAbort = f.store.list("w-demo").records;
  const abortedStream = await f.session.agent.streamFunction(
    f.model,
    {
      messages: [
        { role: "user", content: "owned aborted signal", timestamp: 0 },
      ],
    },
    { signal: AbortSignal.abort() },
  );
  assert.equal((await abortedStream.result()).stopReason, "error");
  assert.equal(
    f.received,
    2,
    "an own aborted signal must prevent another HTTP request",
  );
  assert.equal(f.admitted.length, 2);
  assert.deepEqual(f.store.list("w-demo").records, beforeAbort);
});

test("native SDK projection rejects inherited semantics and aborted signals before admission", async (t) => {
  const observations = [];
  for (const [variant, inherited] of [
    ["temperature", { temperature: 0 }],
    ["already-aborted signal", { signal: AbortSignal.abort() }],
  ]) {
    const f = await fixture(t);
    const options = Object.create(inherited);
    assert.deepEqual(
      Reflect.ownKeys(options),
      [],
      "positive inherited-only precondition",
    );
    if (inherited.signal) assert.equal(inherited.signal.aborted, true);
    const before = f.store.list("w-demo").records;
    let refusal;
    try {
      const stream = await f.session.agent.streamFunction(
        f.model,
        {
          messages: [
            {
              role: "user",
              content: "inherited options must not leave",
              timestamp: 0,
            },
          ],
        },
        options,
      );
      await stream.result();
    } catch (error) {
      refusal = error;
    }
    observations.push({
      variant,
      fixedRefusal:
        refusal?.code === unsupported.code &&
        refusal.message === unsupported.message &&
        !Object.hasOwn(refusal, "cause"),
      admissions: f.admitted.length,
      credentialReads: f.frames.filter((method) => method === "credential.read")
        .length,
      http: f.received,
      unchangedStore:
        JSON.stringify(f.store.list("w-demo").records) ===
        JSON.stringify(before),
    });
  }
  assert.deepEqual(
    observations,
    ["temperature", "already-aborted signal"].map((variant) => ({
      variant,
      fixedRefusal: true,
      admissions: 0,
      credentialReads: 0,
      http: 0,
      unchangedStore: true,
    })),
  );
});

const definedOptions = [
  ["onPayload", () => undefined],
  ["onResponse", () => undefined],
  ["onProviderStreamEvent", () => undefined],
  ["transformHeaders", (headers) => headers],
  ["timeoutMs", 300000],
  ["maxRetryDelayMs", 60000],
  ["transport", "auto"],
  ["maxRetries", 0],
  ["websocketConnectTimeoutMs", 1000],
  ["identity", { userAgent: "detailed", attribution: null }],
  ["reasoning", "off"],
  ["thinkingBudgets", {}],
  ["temperature", 0],
  ["maxTokens", 1024],
  ["samplingParams", {}],
  ["metadata", {}],
  ["cacheRetention", "short"],
  ["toolChoice", "auto"],
  ["deferred", false],
  ["sessionId", "s1"],
  ["apiKey", "synthetic-override"],
  ["headers", {}],
  ["env", {}],
  [
    "fetch",
    () => {
      throw new Error("must not call custom fetch");
    },
  ],
  ["unknownFixtureOption", true],
];
test("native SDK projection rejects defined direct semantics including SDK defaults", async (t) => {
  const f = await fixture(t);
  const before = f.store.list("w-demo").records;
  for (const [key, value] of definedOptions) {
    await assert.rejects(
      async () => {
        const stream = await f.session.agent.streamFunction(
          f.model,
          {
            messages: [
              { role: "user", content: "must not leave", timestamp: 0 },
            ],
          },
          { signal: new AbortController().signal, [key]: value },
        );
        await stream.result();
      },
      unsupported,
      `${key} must reject before native admission`,
    );
    assert.equal(f.received, 0, key);
    assert.equal(f.admitted.length, 0, key);
    assert.deepEqual(f.store.list("w-demo").records, before, key);
  }
});

for (const hook of [
  "before_provider_request",
  "before_provider_headers",
  "after_provider_response",
  "provider_stream_event",
]) {
  test(`native SDK projection public prompt denies active ${hook} hook`, async (t) => {
    const f = await fixture(t, { hook });
    await assert.rejects(
      () => f.session.prompt("hook must not leave"),
      unsupported,
    );
    assertNoProviderEffect(f);
    assert.equal(f.hookCalls, 0, "unsupported provider hook must not run");
    const messages = await persistedMessages(f);
    assert.equal(
      messages.filter((message) => message.role === "assistant").length,
      0,
    );
    assert.equal(
      messages.filter((message) => message.role === "user").length,
      1,
      "the user row commits before the request-options boundary; rejection must not fabricate an assistant row",
    );
  });
}

for (const [label, settings] of [
  ["transport equal to auto", { transport: "auto" }],
  ["HTTP timeout equal to 300000", { httpIdleTimeoutMs: 300000 }],
  ["WebSocket timeout", { websocketConnectTimeoutMs: 1000 }],
  ["empty thinking budgets", { thinkingBudgets: {} }],
  [
    "retry delay equal to 60000",
    { retry: { enabled: false, provider: { maxRetryDelayMs: 60000 } } },
  ],
]) {
  test(`native SDK projection public prompt rejects explicit setting ${label}`, async (t) => {
    const f = await fixture(t, { settings });
    for (const [key, value] of Object.entries(settings))
      assert.deepEqual(f.settings.getSettings()[key], value);
    await assert.rejects(
      () => f.session.prompt("explicit setting must not leave"),
      unsupported,
    );
    assertNoProviderEffect(f);
    const messages = await persistedMessages(f);
    assert.equal(
      messages.filter((message) => message.role === "assistant").length,
      0,
    );
    assert.equal(
      messages.filter((message) => message.role === "user").length,
      1,
    );
  });
}

test("native SDK projection rejects non-enumerable accessor and symbol options without invoking getters", async (t) => {
  const f = await fixture(t);
  const variants = [];
  for (const [key, value] of [
    ["onPayload", () => undefined],
    ["maxRetryDelayMs", 60000],
    ["unknownFixtureOption", true],
  ])
    variants.push([
      `non-enumerable ${key}`,
      Object.defineProperty({}, key, { value, enumerable: false }),
    ]);
  let getterCalls = 0;
  variants.push([
    "accessor",
    Object.defineProperty({}, "timeoutMs", {
      get() {
        getterCalls++;
        return 300000;
      },
      enumerable: true,
    }),
  ]);
  variants.push(["symbol", { [Symbol("fixture-option")]: true }]);
  const before = f.store.list("w-demo").records;
  for (const [label, options] of variants) {
    await assert.rejects(
      async () => {
        const stream = await f.session.agent.streamFunction(
          f.model,
          {
            messages: [
              {
                role: "user",
                content: "hidden option must not leave",
                timestamp: 0,
              },
            ],
          },
          options,
        );
        await stream.result();
      },
      unsupported,
      label,
    );
    assert.equal(getterCalls, 0, label);
    assertNoProviderEffect(f);
    assert.deepEqual(f.store.list("w-demo").records, before, label);
  }
});

test("native SDK projection preserves sealed callback replacement denial", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.session.agent.onPayload = () => {
    calls++;
  };
  await assert.rejects(() => f.session.prompt("tampered callback"), {
    code: "SPLYCE_UNAVAILABLE",
  });
  assert.equal(calls, 0);
  assert.equal(f.received, 0);
  assert.equal(f.admitted.length, 0);
});

test("native SDK projection proof accepts only the unchanged actual loop request and source", async (t) => {
  const f = await fixture(t);
  assert.equal(typeof agentApi.isSplyceLoopRequest, "function");
  for (const key of [
    "createSplyceOwner",
    "inheritSplyceLoopRequest",
    "inheritSplyceLoopConfig",
  ])
    assert.equal(
      key in agentApi,
      false,
      "request/owner minting must remain private",
    );
  let captured;
  let agent;
  const options = {
    initialState: { model: f.model },
    streamFn: (model, context, request) => {
      captured = request;
      assert.equal(
        agentApi.isSplyceLoopRequest(agent, request),
        true,
        "actual core request must have a positive provenance precondition",
      );
      return f.runtime.streamSimple(model, context, { signal: request.signal });
    },
  };
  f.owner.bind(options, "agent-options");
  agent = new agentApi.Agent(options);
  await agent.prompt("real loop provenance");
  assert.equal(f.received, 1);
  assert.equal(agent.state.messages.at(-1).stopReason, "stop");
  assert.equal(agentApi.isSplyceLoopRequest(agent, captured), true);
  assert.equal(agentApi.isSplyceLoopRequest(agent, { ...captured }), false);
  assert.equal(
    agentApi.isSplyceLoopRequest(f.session.agent, captured),
    false,
    "a different actual Agent of the same owner must not qualify",
  );
  const foreignOwner = createSplyceOwner(() => {});
  t.after(() => foreignOwner.dispose());
  const foreignOptions = {
    initialState: { model: f.model },
    streamFn: options.streamFn,
  };
  foreignOwner.bind(foreignOptions, "agent-options");
  const foreign = new agentApi.Agent(foreignOptions);
  assert.equal(agentApi.isSplyceLoopRequest(foreign, captured), false);
  const before = Reflect.ownKeys(captured);
  captured.fixtureExtra = true;
  assert.equal(agentApi.isSplyceLoopRequest(agent, captured), false);
  assert.equal(captured.fixtureExtra, true, "proof must not rewrite its input");
  delete captured.fixtureExtra;
  assert.deepEqual(Reflect.ownKeys(captured), before);
  const descriptor = Object.getOwnPropertyDescriptor(captured, "onPayload");
  let getterCalls = 0;
  Object.defineProperty(captured, "onPayload", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls++;
      return descriptor.value;
    },
  });
  try {
    assert.equal(agentApi.isSplyceLoopRequest(agent, captured), false);
    assert.equal(
      getterCalls,
      0,
      "read-only provenance comparison must not execute an accessor",
    );
  } finally {
    Object.defineProperty(captured, "onPayload", descriptor);
  }
  assert.equal(agentApi.isSplyceLoopRequest(agent, captured), true);
  assert.equal(
    f.received,
    1,
    "provenance comparisons must not dispatch another request",
  );
});

test("native SDK projection failure classifier never invokes an error code getter", async (t) => {
  // Actual owned Agent failure path only; this case makes no provider-admission claim.
  const owner = createSplyceOwner(() => {});
  t.after(() => owner.dispose());
  const sentinel = `synthetic-getter-cause-${crypto.randomUUID()}`;
  const failure = new Error("synthetic request failed", {
    cause: new Error(sentinel),
  });
  let getterCalls = 0;
  Object.defineProperty(failure, "code", {
    enumerable: true,
    get() {
      getterCalls++;
      throw new Error(sentinel);
    },
  });
  let streamCalls = 0;
  const options = {
    initialState: {
      model: {
        api: "openai-completions",
        id: "classifier-fixture",
        name: "Classifier fixture",
        provider: "fixture",
        baseUrl: "http://127.0.0.1:1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 16,
      },
    },
    streamFn: () => {
      streamCalls++;
      throw failure;
    },
  };
  owner.bind(options, "agent-options");
  const agent = new agentApi.Agent(options);
  const events = [];
  agent.subscribe((event) => events.push(event));
  await assert.doesNotReject(() =>
    agent.prompt("exercise the actual public failure path"),
  );
  assert.equal(
    streamCalls,
    1,
    "the configured stream must reach the classifier",
  );
  assert.equal(
    getterCalls,
    0,
    "error classification must inspect own data descriptors without invoking getters",
  );
  assert.equal(agent.state.errorMessage, "synthetic request failed");
  const message = agent.state.messages.at(-1);
  assert.equal(message.role, "assistant");
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "synthetic request failed");
  const exposed = JSON.stringify({
    messages: agent.state.messages,
    errorMessage: agent.state.errorMessage,
    events,
  });
  assert.equal(
    exposed.includes(sentinel),
    false,
    "getter text and nested cause must stay out of public output",
  );
  assert.equal(
    exposed.includes("PROVIDER_OPTIONS_UNSUPPORTED"),
    false,
    "an accessor is not evidence of a typed unsupported-options error",
  );
  assert.equal(Object.hasOwn(message, "cause"), false);
  const typedOptions = {
    initialState: options.initialState,
    streamFn: () => {
      throw Object.assign(new Error(sentinel, { cause: failure }), {
        code: "PROVIDER_OPTIONS_UNSUPPORTED",
      });
    },
  };
  owner.bind(typedOptions, "agent-options");
  const typedAgent = new agentApi.Agent(typedOptions);
  const typedEvents = [];
  typedAgent.subscribe((event) => typedEvents.push(event));
  await assert.rejects(
    () => typedAgent.prompt("typed refusal"),
    (error) => {
      assert.equal(error.code, unsupported.code);
      assert.equal(error.message, unsupported.message);
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    },
  );
  assert.equal(
    typedAgent.state.messages.some((entry) => entry.role === "assistant"),
    false,
  );
  assert.equal(
    JSON.stringify({ state: typedAgent.state, typedEvents }).includes(sentinel),
    false,
  );
});
