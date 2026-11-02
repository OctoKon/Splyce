import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSplyceOwner } from "../vendor/pi/packages/agent/dist/splyce-readiness.js";
import { AuthStorage } from "../vendor/pi/packages/coding-agent/dist/core/auth-storage.js";
import { InMemoryCodingAgentModelsStore } from "../vendor/pi/packages/coding-agent/dist/core/models-store.js";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";

const unavailable = { code: "SPLYCE_UNAVAILABLE" };
const target = `splyce-credential:v1:${"a".repeat(64)}`;
const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

async function fixture(t) {
  const state = { current: true, present: true, fail: false };
  const frames = [],
    calls = [];
  let beforeReply = async () => {};
  const owner = createSplyceOwner(() => {
    if (!state.current)
      throw Object.assign(new Error("SPLYCE_UNAVAILABLE"), unavailable);
  });
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
          : { value: { present: state.present } }),
      },
    });
  });
  t.after(() => {
    owner.dispose();
    control.shutdown();
  });
  const options = {
    credentials: AuthStorage.inMemory(),
    modelsStore: new InMemoryCodingAgentModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  };
  owner.bind(options, "model-runtime-options");
  const runtime = await ModelRuntime.create(options);
  const model = {
    id: "native-fixture",
    name: "Native fixture",
    provider: "openai",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 16,
  };
  const stream = (selected, transcript, requestOptions) => {
    calls.push({ selected, transcript, requestOptions });
    const result = createAssistantMessageEventStream();
    result.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "native callback" }],
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
      },
    });
    return result;
  };
  const provider = {
    id: model.provider,
    name: "Native fixture",
    auth: {
      apiKey: {
        name: "Native credential",
        check: async ({ ctx, credential, signal }) => {
          assert.equal(credential, undefined);
          assert.equal(await ctx.env("OPENAI_API_KEY"), undefined);
          assert.equal(await ctx.fileExists("ambient-auth"), false);
          const status = await control.credentialStatus({ target }, signal);
          return status.present
            ? { type: "api_key", source: "native credential facility" }
            : undefined;
        },
        resolve: async () => {
          throw new Error("Native runtime must never resolve a secret");
        },
      },
    },
    getModels: () => [model],
    refreshModels: async () => {
      throw new Error("Native runtime must never refresh donor catalogs");
    },
    stream,
    streamSimple: stream,
  };
  return {
    runtime,
    owner,
    model,
    provider,
    state,
    frames,
    calls,
    beforeReply: (callback) => {
      beforeReply = callback;
    },
  };
}

test("awaited native registration publishes genuine nonsecret presence and forwards both stream entrypoints", async (t) => {
  const f = await fixture(t);
  const entered = deferred(),
    release = deferred();
  f.beforeReply(async () => {
    entered.resolve();
    await release.promise;
  });
  const registration = f.runtime.registerNativeProvider(f.provider);
  await entered.promise;
  assert.equal(f.runtime.hasConfiguredAuth("openai"), false);
  assert.deepEqual(f.runtime.getAvailableSnapshot(), []);
  release.resolve();
  await registration;
  assert.equal(f.runtime.hasConfiguredAuth("openai"), true);
  assert.deepEqual(await f.runtime.getAvailable(), [f.model]);
  const framesBefore = f.frames.length;
  assert.equal(
    (await f.runtime.completeSimple(f.model, context, { maxTokens: 8 }))
      .stopReason,
    "error",
  );
  assert.equal(f.frames.length, framesBefore);
  assert.equal(f.calls.length, 0);
  const signal = new AbortController().signal;
  for (const method of ["complete", "completeSimple"]) {
    const result = await f.runtime[method]({ ...f.model }, context, {
      signal,
    });
    assert.equal(result.content[0].text, "native callback");
  }
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.deepEqual(call.selected, f.model);
    assert.equal(call.requestOptions.apiKey, undefined);
    assert.equal(call.requestOptions.credentials, undefined);
    assert.equal(call.requestOptions.env, undefined);
    assert.equal(call.requestOptions.signal, signal);
    assert.equal(call.transcript.messages[0].content, "hello");
  }
  await assert.rejects(f.runtime.getAuth(f.model), unavailable);
});

test("ambient credentials and donor catalog never authorize an unregistered provider", async (t) => {
  const f = await fixture(t);
  const ambient = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "ambient-fixture";
  t.after(() => {
    if (ambient === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ambient;
  });
  await assert.rejects(f.runtime.checkAuth("openai"), unavailable);
  await assert.rejects(f.runtime.getAvailable("openai"), unavailable);
  assert.deepEqual(await f.runtime.getAvailable(), []);
  const result = await f.runtime.completeSimple(f.model, context);
  assert.equal(result.stopReason, "error");
  assert.equal(f.frames.length, 0);
  assert.equal(f.calls.length, 0);
  assert.throws(
    () => ModelRuntime.prototype.registerNativeProvider.call({}, f.provider),
    unavailable,
  );
});

test("missing native key denies dispatch and failed status clears availability and propagates", async (t) => {
  const f = await fixture(t);
  await f.runtime.registerNativeProvider(f.provider);
  f.state.present = false;
  const missing = await f.runtime.completeSimple(f.model, context);
  assert.equal(missing.stopReason, "error");
  assert.equal(f.runtime.hasConfiguredAuth("openai"), false);
  assert.deepEqual(f.runtime.getAvailableSnapshot(), []);
  f.state.fail = true;
  await assert.rejects(f.runtime.refresh({ allowNetwork: false }));
  await assert.rejects(f.runtime.registerNativeProvider(f.provider));
  assert.equal(f.calls.length, 0);
  f.state.fail = false;
  f.state.present = true;
  await f.runtime.refresh({ allowNetwork: false });
  assert.deepEqual(f.runtime.getAvailableSnapshot(), [f.model]);
});

test("ownership and cancellation are checked before and after awaited native presence", async (t) => {
  for (const revoke of ["stale", "dispose", "abort"]) {
    const f = await fixture(t);
    await f.runtime.registerNativeProvider(f.provider);
    const entered = deferred(),
      release = deferred();
    f.beforeReply(async () => {
      entered.resolve();
      await release.promise;
    });
    const controller = new AbortController();
    const pending = f.runtime.completeSimple(f.model, context, {
      signal: controller.signal,
    });
    await entered.promise;
    if (revoke === "stale") f.state.current = false;
    if (revoke === "dispose") f.owner.dispose();
    if (revoke === "abort") controller.abort();
    release.resolve();
    assert.equal((await pending).stopReason, "error");
    assert.equal(f.calls.length, 0);
    if (revoke !== "abort") {
      const frames = f.frames.length;
      await assert.rejects(f.runtime.checkAuth("openai"), unavailable);
      assert.equal(f.frames.length, frames);
    }
  }
});

test("registered model and request overrides cannot change native identity or credential routing", async (t) => {
  const f = await fixture(t);
  await f.runtime.registerNativeProvider(f.provider);
  for (const override of [
    { provider: "anthropic" },
    { id: "other" },
    { api: "openai-responses" },
    { baseUrl: "http://127.0.0.1:2/v1" },
    { headers: { authorization: "fixture" } },
  ]) {
    assert.equal(
      (await f.runtime.completeSimple({ ...f.model, ...override }, context))
        .stopReason,
      "error",
    );
  }
  for (const name of [
    "apiKey",
    "credentials",
    "env",
    "headers",
    "transformHeaders",
    "fetch",
    "baseUrl",
    "baseURL",
    "client",
    "transport",
  ]) {
    const result = await f.runtime.completeSimple(f.model, context, {
      [name]: {},
    });
    assert.equal(result.stopReason, "error", name);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.frames.length,
    1,
    "identity and override refusal precedes status RPC",
  );
});

test("caller mutation while status awaits cannot add overrides or alter the registered request model", async (t) => {
  const f = await fixture(t);
  await f.runtime.registerNativeProvider(f.provider);
  const entered = deferred(),
    release = deferred();
  f.beforeReply(async () => {
    entered.resolve();
    await release.promise;
  });
  const options = { signal: new AbortController().signal };
  const selected = { ...f.model };
  const request = f.runtime.completeSimple(selected, context, options);
  await entered.promise;
  options.apiKey = "untrusted";
  options.headers = { authorization: "untrusted" };
  selected.baseUrl = "http://127.0.0.1:2";
  release.resolve();
  assert.equal((await request).stopReason, "stop");
  assert.equal(f.calls[0].requestOptions.apiKey, undefined);
  assert.equal(f.calls[0].requestOptions.headers, undefined);
  assert.equal(f.calls[0].selected.baseUrl, f.model.baseUrl);
});

test("legacy registrations cannot replace or provisionally authorize the native provider", async (t) => {
  const f = await fixture(t);
  await f.runtime.registerNativeProvider(f.provider);
  for (const invoke of [
    () => f.runtime.registerProvider("openai", { apiKey: "untrusted" }),
    () => f.runtime.unregisterProvider("openai"),
    () => f.runtime.registerVirtualModel({ provider: "openai", id: "virtual" }),
    () => f.runtime.unregisterVirtualModel("openai", "virtual"),
  ])
    assert.throws(invoke, unavailable);
  assert.equal(f.runtime.getRegisteredNativeProvider("openai"), f.provider);
  assert.deepEqual(await f.runtime.getAvailable(), [f.model]);
});

test(
  "removing native runtime guards fails the behavioral assertions",
  {
    skip: process.env.SPLYCE_MODEL_RUNTIME_MUTANT === "1",
  },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "splyce-model-runtime-mutant-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const hook = join(dir, "mutation.mjs");
    await writeFile(
      hook,
      `import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (!url.endsWith('/coding-agent/dist/core/model-runtime.js')) return loaded;
  const source = String(loaded.source);
  const targets = {
    current: ['requireNativeProvider(providerId, expected) {\\n        assertSameSplyceOwner(this, this, "model-runtime");', 'requireNativeProvider(providerId, expected) {'],
    endpoint: ['selected.baseUrl !== model.baseUrl ||', ''],
    overrides: ['Reflect.ownKeys(options).some((key) => key !== "signal")', 'false'],
    presence: ['if (!(await this.checkAuth(provider.id, { signal: providerOptions.signal })))', 'if (false)'],
  };
  const [from, to] = targets[process.env.SPLYCE_MODEL_RUNTIME_TARGET];
  const mutated = source.replace(from, to);
  if (source === mutated) throw new Error('mutation target not found');
  return { ...loaded, source: mutated };
}});
`,
    );
    for (const [kind, pattern] of [
      ["current", "ownership and cancellation"],
      ["endpoint", "registered model and request overrides"],
      ["overrides", "registered model and request overrides"],
      ["presence", "missing native key"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(hook).href,
          "--test",
          `--test-name-pattern=${pattern}`,
          fileURLToPath(import.meta.url),
        ],
        {
          env: {
            ...Object.fromEntries(
              ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT"]
                .filter((key) => process.env[key])
                .map((key) => [key, process.env[key]]),
            ),
            SPLYCE_MODEL_RUNTIME_MUTANT: "1",
            SPLYCE_MODEL_RUNTIME_TARGET: kind,
          },
          encoding: "utf8",
          windowsHide: true,
          timeout: 30000,
        },
      );
      const output = result.stdout + result.stderr;
      assert.equal(result.error, undefined, kind);
      assert.notEqual(result.status, 0, kind);
      assert.doesNotMatch(
        output,
        /mutation target not found|SyntaxError/,
        kind,
      );
      assert.match(output, /AssertionError/, kind);
    }
  },
);
