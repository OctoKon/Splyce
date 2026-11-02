import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  AgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createSplyceOwner } from "../vendor/pi/packages/agent/dist/splyce-readiness.js";
import { AuthStorage } from "../vendor/pi/packages/coding-agent/dist/core/auth-storage.js";
import { InMemoryCodingAgentModelsStore } from "../vendor/pi/packages/coding-agent/dist/core/models-store.js";
import { loadExtensionFromFactory } from "../vendor/pi/packages/coding-agent/dist/core/extensions/loader.js";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";

const target = `splyce-credential:v1:${"a".repeat(64)}`;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const credentialUnavailable = (error) => {
  assert.equal(error.code, "CREDENTIAL_UNAVAILABLE");
  assert.equal(error.message, "Credential unavailable");
  return true;
};

// Protocol fixture only: actual Pi callers and NativeControl, no installed credential or provider claim.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "splyce-native-callers-"));
  const cwd = join(directory, "project"),
    agentDir = join(directory, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const state = { current: true, fail: false };
  const owner = createSplyceOwner(() => {
    if (!state.current)
      throw Object.assign(new Error("SPLYCE_UNAVAILABLE"), {
        code: "SPLYCE_UNAVAILABLE",
      });
  });
  const calls = [],
    frames = [];
  let beforeReply = async () => {};
  const control = new NativeControl(async (frame) => {
    frames.push(frame);
    assert.equal(frame.native.method, "credential.status");
    assert.deepEqual(frame.native.params, { target });
    await beforeReply();
    control.accept({
      native: {
        id: frame.native.id,
        ok: !state.fail,
        ...(state.fail
          ? { error: { code: "CREDENTIAL_UNAVAILABLE" } }
          : { value: { present: true } }),
      },
    });
  });
  t.after(async () => {
    owner.dispose();
    control.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const runtimeOptions = {
    credentials: AuthStorage.inMemory(),
    modelsStore: new InMemoryCodingAgentModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  };
  owner.bind(runtimeOptions, "model-runtime-options");
  const modelRuntime = await ModelRuntime.create(runtimeOptions);
  const model = {
    id: "native-callers-fixture",
    name: "Original",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 16,
  };
  const makeProvider = (name = "Original") => {
    const stream = (selected, context, options) => {
      calls.push({ selected, context, options });
      const result = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "fixture" }],
        api: selected.api,
        provider: selected.provider,
        model: selected.id,
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      result.push({ type: "done", reason: "stop", message });
      result.end(message);
      return result;
    };
    return {
      id: model.provider,
      name,
      auth: {
        apiKey: {
          name: "Protocol fixture",
          check: async ({ ctx, credential, signal }) => {
            assert.equal(credential, undefined);
            assert.equal(await ctx.env("OPENAI_API_KEY"), undefined);
            const status = await control.credentialStatus({ target }, signal);
            return status.present
              ? { type: "api_key", source: "protocol fixture" }
              : undefined;
          },
          resolve: async () => {
            throw new Error("No secret resolution in caller fixture");
          },
        },
      },
      getModels: () => [{ ...model, name }],
      stream,
      streamSimple: stream,
    };
  };
  const provider = makeProvider();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    cacheWarming: "off",
  });
  const sessionManager = SessionManager.inMemory(cwd);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  for (const [value, role] of [
    [model, "model"],
    [settingsManager, "settings-manager"],
    [sessionManager, "session-manager"],
    [resourceLoader, "resource-loader"],
  ])
    owner.bind(value, role);
  assert.equal(
    typeof owner.bindPersistence,
    "function",
    "awaited persistence core is a runner prerequisite",
  );
  owner.bindPersistence(sessionManager, async (serialized) => serialized);
  const options = {
    cwd,
    agentDir,
    model,
    modelRuntime,
    sessionManager,
    settingsManager,
    resourceLoader,
    tools: [],
  };
  owner.bind(options, "sdk-options");
  const load = async (factory) => {
    const loaded = resourceLoader.getExtensions();
    const extension = await loadExtensionFromFactory(
      factory,
      cwd,
      createEventBus(),
      loaded.runtime,
    );
    loaded.extensions.push(extension);
    return loaded.runtime;
  };
  const gate = () => {
    const entered = deferred(),
      release = deferred();
    beforeReply = async () => {
      entered.resolve();
      await release.promise;
    };
    t.after(() => release.resolve());
    return { entered, release };
  };
  return {
    ...options,
    options,
    state,
    owner,
    provider,
    makeProvider,
    calls,
    frames,
    load,
    gate,
  };
}

test("native caller factory queue acknowledgment cannot deadlock SDK registration", async (t) => {
  const f = await fixture(t);
  let factoryFinished = false,
    startups = 0;
  const queued = await f.load(async (pi) => {
    await pi.registerProvider(f.provider);
    factoryFinished = true;
    pi.on("session_start", () => {
      startups++;
    });
  });
  assert.equal(factoryFinished, true);
  assert.equal(
    f.frames.length,
    0,
    "factory completion only queued the native registration",
  );
  assert.equal(queued.pendingNativeProviderRegistrations.length, 1);
  const { entered, release } = f.gate();
  let exposed = false;
  const pending = createAgentSession(f.options).then((value) => {
    exposed = true;
    return value;
  });
  await entered.promise;
  await turn();
  assert.equal(
    exposed,
    false,
    "SDK must await genuine registration completion",
  );
  assert.equal(startups, 0);
  assert.equal(queued.pendingNativeProviderRegistrations.length, 1);
  release.resolve();
  const { session } = await pending;
  t.after(() => session.dispose());
  assert.equal(queued.pendingNativeProviderRegistrations.length, 0);
  assert.equal(
    f.modelRuntime.getRegisteredNativeProvider("openai"),
    f.provider,
  );
  assert.equal(f.modelRuntime.hasConfiguredAuth("openai"), true);
  await session.bindExtensions({});
  assert.equal(startups, 1);
});

test("native caller SDK rejection preserves registration failure before startup and exposure", async (t) => {
  const f = await fixture(t);
  let startups = 0;
  const queued = await f.load((pi) => {
    pi.registerProvider(f.provider);
    pi.on("session_start", () => {
      startups++;
    });
  });
  f.state.fail = true;
  let exposed = false;
  await assert.rejects(
    createAgentSession(f.options).then(() => {
      exposed = true;
    }),
    credentialUnavailable,
  );
  assert.equal(exposed, false);
  assert.equal(startups, 0);
  assert.equal(queued.pendingNativeProviderRegistrations.length, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.sessionManager.getEntries().some((entry) => entry.type === "message"),
    false,
  );
});

test("native caller constructor stays synchronous and initialization retains its first failure", async (t) => {
  const f = await fixture(t);
  await f.load(async (pi) => {
    await pi.registerProvider(f.provider);
  });
  const agentOptions = {
    initialState: {
      model: f.model,
      thinkingLevel: "off",
      messages: [],
      tools: [],
    },
    streamFn: () => {
      throw new Error("Registration refusal must precede generation");
    },
  };
  f.owner.bind(agentOptions, "agent-options");
  const agent = new Agent(agentOptions);
  const config = {
    agent,
    cwd: f.cwd,
    sessionManager: f.sessionManager,
    settingsManager: f.settingsManager,
    resourceLoader: f.resourceLoader,
    modelRuntime: f.modelRuntime,
    initialActiveToolNames: [],
  };
  f.owner.bind(config, "session-options");
  const session = new AgentSession(config);
  t.after(() => session.dispose());
  await turn();
  assert.equal(
    f.frames.length,
    0,
    "constructor cannot start unobserved registration work",
  );
  f.state.fail = true;
  let failure;
  await assert.rejects(session.initialize(), (error) => {
    failure = error;
    credentialUnavailable(error);
    return true;
  });
  const frames = f.frames.length;
  await assert.rejects(session.initialize(), (error) => error === failure);
  await assert.rejects(
    session.bindExtensions({}),
    (error) => error === failure,
  );
  assert.equal(
    f.frames.length,
    frames,
    "failed initialization cannot blindly retry registration",
  );
});

test("native caller ModelRegistry returns and propagates the actual registration promise", async (t) => {
  const f = await fixture(t);
  const registry = new ModelRegistry(f.modelRuntime);
  const { entered, release } = f.gate();
  f.state.fail = true;
  const pending = registry.registerProvider(f.provider);
  assert.equal(typeof pending?.then, "function");
  const rejected = assert.rejects(pending, credentialUnavailable);
  await entered.promise;
  assert.equal(registry.getRegisteredNativeProvider("openai"), f.provider);
  assert.equal(f.modelRuntime.hasConfiguredAuth("openai"), false);
  release.resolve();
  await rejected;
});

test("native caller live extension rejection cannot refresh the selected model", async (t) => {
  const f = await fixture(t);
  let api;
  await f.load((pi) => {
    api = pi;
  });
  const { session } = await createAgentSession(f.options);
  t.after(() => session.dispose());
  const selected = session.model;
  const { entered, release } = f.gate();
  f.state.fail = true;
  const pending = api.registerProvider(f.makeProvider("Replacement"));
  assert.equal(typeof pending?.then, "function");
  const rejected = assert.rejects(pending, credentialUnavailable);
  await entered.promise;
  assert.equal(session.model, selected);
  release.resolve();
  await rejected;
  assert.equal(session.model, selected);
});

for (const headersHook of [false, true]) {
  test(`native caller SDK ${headersHook ? "rejects a real" : "omits an absent"} provider-header hook`, async (t) => {
    const f = await fixture(t);
    let hookCalls = 0;
    if (headersHook)
      await f.load((pi) => {
        pi.on("before_provider_headers", (event) => {
          hookCalls++;
          return event;
        });
      });
    await f.modelRuntime.registerNativeProvider(f.provider);
    const { session } = await createAgentSession(f.options);
    t.after(() => session.dispose());
    const frames = f.frames.length;
    const request = () =>
      session.agent.streamFunction(f.model, { messages: [] }, {});
    if (headersHook) {
      await assert.rejects(request, {
        code: "PROVIDER_OPTIONS_UNSUPPORTED",
        message: "PROVIDER_OPTIONS_UNSUPPORTED",
      });
      assert.equal(f.calls.length, 0);
      assert.equal(
        f.frames.length,
        frames,
        "real unsupported hook fails before native status or send",
      );
      assert.equal(hookCalls, 0);
    } else {
      const result = await (await request()).result();
      assert.equal(result.stopReason, "stop");
      assert.equal(f.calls.length, 1);
      assert.equal(
        Object.hasOwn(f.calls[0].options, "transformHeaders"),
        false,
      );
    }
  });
}

test("native caller late registration after real reload invalidation cannot refresh an old runner", async (t) => {
  const f = await fixture(t);
  let api;
  await f.load((pi) => {
    api = pi;
  });
  const { session } = await createAgentSession(f.options);
  t.after(() => session.dispose());
  const selected = session.model;
  const { entered, release } = f.gate();
  const pending = api.registerProvider(f.makeProvider("Stale replacement"));
  const rejected = assert.rejects(pending);
  await entered.promise;
  // The actual resource-admission path remains unavailable; it still invalidates the old runner first.
  await assert.rejects(session.reload());
  release.resolve();
  await rejected;
  assert.equal(session.model, selected);
});
