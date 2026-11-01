import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as agentApi from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createSplyceOwner } from "../vendor/pi/packages/agent/dist/splyce-readiness.js";
import { AuthStorage } from "../vendor/pi/packages/coding-agent/dist/core/auth-storage.js";
import { InMemoryCodingAgentModelsStore } from "../vendor/pi/packages/coding-agent/dist/core/models-store.js";
import {
  NativePolicy,
  actionArgumentsDigest,
} from "../packages/splyce-pi/dist/policy.js";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { admitAndGrant } from "./fixtures/native-grants.mjs";

const { Agent, assertSplyceReady, assertSameSplyceOwner, inheritSplyceOwner } =
  agentApi;
const unavailable = {
  message: "SPLYCE_UNAVAILABLE",
  code: "SPLYCE_UNAVAILABLE",
};
const model = () => ({
  id: "fixture",
  name: "Fixture",
  provider: "fixture",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1024,
  maxTokens: 16,
});

function ownerFixture() {
  const selected = {
    session: "session",
    revision: 1,
    epoch: 1,
    cancelled: false,
  };
  const current = { ...selected };
  let checks = 0;
  const owner = createSplyceOwner(() => {
    checks++;
    if (
      current.cancelled ||
      current.session !== selected.session ||
      current.revision !== selected.revision ||
      current.epoch !== selected.epoch
    ) {
      throw Object.assign(new Error("SPLYCE_UNAVAILABLE"), {
        code: "SPLYCE_UNAVAILABLE",
      });
    }
  });
  return { owner, current, checks: () => checks };
}

test("private owner mint is absent from public package and default readiness never activates", () => {
  assert.equal("createSplyceOwner" in agentApi, false);
  for (const name of [
    "getSplyceToolImplementation",
    "inheritSplyceLoopConfig",
    "assertSplyceLoopStream",
  ])
    assert.equal(name in agentApi, false);
  const { owner } = ownerFixture();
  const subject = {};
  owner.bind(subject, "session-manager");
  assertSplyceReady(subject);
  assert.throws(() => assertSplyceReady(), unavailable);
  for (const forged of [
    {},
    { ...subject },
    Object.create(subject),
    new Proxy(subject, {}),
  ]) {
    assert.throws(() => assertSplyceReady(forged), unavailable);
  }
  for (const role of ["agent", "agent-options", "sdk-options", "loop-config"]) {
    assert.throws(() => inheritSplyceOwner(subject, {}, role), unavailable);
  }
});

test("same-owner checks reject foreign roles, rebinding and disposed generations", () => {
  const a = ownerFixture();
  const b = ownerFixture();
  const subject = {};
  const foreign = {};
  a.owner.bind(subject, "session");
  b.owner.bind(foreign, "session");
  assert.throws(() => assertSameSplyceOwner(subject, foreign), unavailable);
  assert.throws(
    () => assertSameSplyceOwner(subject, subject, "agent"),
    unavailable,
  );
  assert.throws(() => b.owner.bind(subject, "session"), unavailable);
  const runner = {};
  inheritSplyceOwner(subject, runner, "runner");
  assert.throws(
    () => inheritSplyceOwner(runner, {}, "agent-options"),
    unavailable,
  );
  const before = a.checks();
  assertSplyceReady(runner);
  assert.ok(
    a.checks() > before,
    "derived identities recheck native state on use",
  );
  a.owner.dispose();
  a.owner.dispose();
  for (const value of [subject, runner])
    assert.throws(() => assertSplyceReady(value), unavailable);
  assert.throws(() => b.owner.bind(subject, "session"), unavailable);
});

for (const [key, value] of [
  ["session", "other"],
  ["revision", 2],
  ["epoch", 2],
  ["cancelled", true],
]) {
  test(`native ${key} changes invalidate an already derived identity`, () => {
    const fixture = ownerFixture();
    const options = {};
    fixture.owner.bind(options, "agent-options");
    const agent = new Agent({
      streamFn: () => {
        throw new Error("unowned");
      },
    });
    inheritSplyceOwner(options, agent, "agent");
    assertSplyceReady(agent);
    fixture.current[key] = value;
    assert.throws(() => assertSplyceReady(agent), unavailable);
    assert.throws(
      () => inheritSplyceOwner(agent, {}, "loop-config"),
      unavailable,
    );
  });
}

async function services(t) {
  const dir = await mkdtemp(join(tmpdir(), "splyce-owned-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const fixture = ownerFixture();
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
  const runtimeOptions = {
    credentials: AuthStorage.inMemory(),
    modelsStore: new InMemoryCodingAgentModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  };
  fixture.owner.bind(runtimeOptions, "model-runtime-options");
  const modelRuntime = await ModelRuntime.create(runtimeOptions);
  const selectedModel = model();
  for (const [value, role] of [
    [settingsManager, "settings-manager"],
    [sessionManager, "session-manager"],
    [resourceLoader, "resource-loader"],
    [selectedModel, "model"],
  ])
    fixture.owner.bind(value, role);
  const options = {
    cwd,
    agentDir,
    model: selectedModel,
    modelRuntime,
    sessionManager,
    settingsManager,
    resourceLoader,
    tools: [],
  };
  fixture.owner.bind(options, "sdk-options");
  return { ...fixture, options, cwd, agentDir };
}

test("actual loaded SDK creates only the explicitly owned session and keeps bare startup denied", async (t) => {
  const fixture = await services(t);
  const { session } = await createAgentSession(fixture.options);
  t.after(() => session.dispose());
  assertSameSplyceOwner(fixture.options, session, "session");
  assertSameSplyceOwner(session, session.agent, "agent");
  assert.deepEqual(session.getActiveToolNames(), []);
  await assert.rejects(
    () => createAgentSession({ ...fixture.options }),
    unavailable,
  );
  await assert.rejects(() => createAgentSession(), unavailable);
  await assert.rejects(() => session.executeBash("denied"), unavailable);
  fixture.owner.dispose();
  await assert.rejects(() => session.agent.prompt("stale"), unavailable);
  await assert.rejects(() => session.bindExtensions({}), unavailable);
  assert.deepEqual(
    await readdir(fixture.agentDir),
    [],
    "owned in-memory startup creates no ambient files",
  );
});

test("public session disposal revokes the actual wrapped tool, Agent and loop identities before cleanup", async (t) => {
  const fixture = await services(t);
  fixture.options.tools = ["read"];
  const { session } = await createAgentSession(fixture.options);
  const tool = session.agent.state.tools.find((value) => value.name === "read");
  const config = session.agent.createLoopConfig();
  assertSameSplyceOwner(session, tool, "tool");
  session.dispose();
  session.dispose();
  for (const value of [session, tool, session.agent, config])
    assert.throws(() => assertSplyceReady(value), unavailable);
  assert.throws(
    () => tool.execute("disposed", { path: join(fixture.cwd, "unused") }),
    unavailable,
  );
  await assert.rejects(() => session.prompt("disposed"), unavailable);
  const entries = structuredClone(session.sessionManager.getEntries());
  const settings = structuredClone(session.settingsManager.getSettings());
  for (const operation of [
    () => session.setThinkingLevel("high"),
    () => session.setCacheWarmingMode("off"),
    () => session.setSessionName("stale"),
    () => session.setSteeringMode("all"),
    () => session.setFollowUpMode("all"),
    () => session.setAutoCompactionEnabled(true),
    () => session.setAutoRetryEnabled(true),
    () => session.setActiveToolsByName(["read"]),
    () => session.setScopedModels([]),
  ])
    assert.throws(operation, unavailable);
  await assert.rejects(
    () =>
      session.sendCustomMessage({
        customType: "stale",
        content: [],
        display: false,
      }),
    unavailable,
  );
  await assert.rejects(() => session.compact(), unavailable);
  assert.deepEqual(session.sessionManager.getEntries(), entries);
  assert.deepEqual(session.settingsManager.getSettings(), settings);
  const next = ownerFixture();
  assert.throws(() => next.owner.bind(session.agent, "agent"), unavailable);
});

test("direct final owned tool execution without native admission preserves physical bytes", async (t) => {
  const fixture = await services(t);
  fixture.options.tools = ["write"];
  const { session } = await createAgentSession(fixture.options);
  t.after(() => session.dispose());
  const canary = join(fixture.cwd, "direct.txt");
  await writeFile(canary, "unchanged");
  const tool = session.agent.state.tools.find(
    (value) => value.name === "write",
  );
  try {
    await tool.execute("no-permit", {
      path: canary,
      content: "readiness-only-write",
    });
  } catch {}
  assert.equal(
    await readFile(canary, "utf8"),
    "unchanged",
    "direct owned tool must not write without native admission",
  );
  await assert.rejects(
    () =>
      agentApi.runToolCall(
        {
          type: "toolCall",
          id: "no-permit",
          name: "write",
          arguments: { path: canary, content: "still denied" },
        },
        {
          tools: [tool],
          context: { messages: [], tools: [tool] },
          assistantMessage: { role: "assistant", content: [] },
        },
      ),
    unavailable,
  );
});

async function admittedWriteFixture(t) {
  const fixture = await services(t);
  fixture.options.tools = ["write"];
  const { session } = await createAgentSession(fixture.options);
  t.after(() => session.dispose());
  const tool = session.agent.state.tools.find(
    (value) => value.name === "write",
  );
  const canary = join(fixture.cwd, "admitted.txt");
  await writeFile(canary, "unchanged");
  const records = JSON.parse(
    await readFile(
      new URL("./fixtures/contracts/records.json", import.meta.url),
      "utf8",
    ),
  );
  const storeDir = await mkdtemp(join(tmpdir(), "splyce-owned-policy-"));
  const store = Store.open(join(storeDir, "owned-policy.db"));
  t.after(async () => {
    if (!store.closed) store.close();
    await rm(storeDir, { recursive: true, force: true });
  });
  const refs = new Set([
    session.sessionId,
    "s1",
    "b1",
    "w-demo",
    "snapshot1",
    "e1",
    "grant1",
    "p1",
    "binding1",
    "cap1",
    "args1",
  ]);
  const caller = {
    sessionId: session.sessionId,
    configRevision: "cfg1",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference: (id, scope) =>
      (scope === "w-demo" || refs.has(scope)) &&
      (refs.has(id) ||
        store
          .list(scope)
          .records.some(
            ({ record }) =>
              record.recordId === id ||
              record.runId === id ||
              record.actionId === id,
          )),
  };
  const args = { path: canary, content: "admitted" };
  const granted = admitAndGrant(store, caller, refs, records, {
    actionId: "a1",
    argumentsDigest: actionArgumentsDigest(args),
  });
  store.append(
    { kind: "run", record: { ...granted.run, piSessionId: session.sessionId } },
    caller,
  );
  const ownership = store.acquireWorkspace(
    granted.workspaceId,
    session.sessionId,
  );
  const policy = new NativePolicy(
    store,
    caller,
    () => ({ ...caller, grantIds: [granted.grantId], planMode: false }),
    granted.identity,
  );
  policy.authorize({
    toolCallId: "owned-write",
    toolName: "write",
    actionId: "a1",
    runRecordId: "rec-run",
    grantId: granted.grantId,
    parentActionId: null,
    capabilityId: "cap1",
    capabilityVersion: "1",
    argumentsArtifactId: "args1",
    argumentsDigest: actionArgumentsDigest(args),
    targetScopeId: "w-demo",
    idempotencyKey: "owned-effect",
    ownership,
    capability: "fs.write",
  });
  t.after(agentApi.bindSplyceToolAdmission(tool, policy));
  return { fixture, session, tool, canary, store, args, policy };
}

test("actual final wrapped write uses native preparation and exactly one durable intent/outcome", async (t) => {
  const { tool, canary, store, args } = await admittedWriteFixture(t);
  const result = await agentApi.runToolCall(
    { type: "toolCall", id: "owned-write", name: "write", arguments: args },
    {
      tools: [tool],
      context: { messages: [], tools: [tool] },
      assistantMessage: { role: "assistant", content: [] },
    },
  );
  assert.equal(result.isError, false);
  assert.equal(await readFile(canary, "utf8"), "admitted");
  assert.deepEqual(
    store
      .list("w-demo")
      .records.filter(({ kind }) => kind !== "run")
      .map(({ kind, record }) => [kind, record.state ?? record.effectState]),
    [
      ["action", "proposed"],
      ["action", "approved"],
      ["action", "running"],
      ["outcome", "observed-success"],
      ["action", "completed"],
    ],
  );
});

test("disposed owned tool denies before durable reservation or argument callbacks", async (t) => {
  const { fixture, tool, canary, store, args } = await admittedWriteFixture(t);
  const before = store.list("w-demo").records.length;
  fixture.owner.dispose();
  let error;
  try {
    await agentApi.runToolCall(
      { type: "toolCall", id: "owned-write", name: "write", arguments: args },
      {
        tools: [tool],
        context: { messages: [], tools: [tool] },
        assistantMessage: { role: "assistant", content: [] },
      },
    );
  } catch (caught) {
    error = caught;
  }
  assert.equal(
    store.list("w-demo").records.length,
    before,
    "disposed owner must not append a reservation",
  );
  assert.equal(await readFile(canary, "utf8"), "unchanged");
  assert.equal(error?.code, "SPLYCE_UNAVAILABLE");
});

for (const interruption of ["revoke", "cancel"]) {
  test(`owned async tool ${interruption} blocks a later physical update callback`, async (t) => {
    const { fixture, tool, args, policy } = await admittedWriteFixture(t);
    const controller = new AbortController();
    const canary = join(fixture.cwd, "update.txt");
    await writeFile(canary, "unchanged");
    const ownedTool = {
      ...tool,
      execute: async (_id, _args, _signal, onUpdate) => {
        await Promise.resolve();
        if (interruption === "revoke") fixture.current.revision++;
        else controller.abort();
        onUpdate({ content: [], details: {} });
        return { content: [], details: {} };
      },
    };
    fixture.owner.bind(ownedTool, "tool");
    t.after(agentApi.bindSplyceToolAdmission(ownedTool, policy));
    let failed = false;
    try {
      const result = await agentApi.runToolCall(
        { type: "toolCall", id: "owned-write", name: "write", arguments: args },
        {
          tools: [ownedTool],
          context: { messages: [], tools: [ownedTool] },
          assistantMessage: { role: "assistant", content: [] },
          signal: controller.signal,
          onUpdate: () => writeFile(canary, "changed"),
        },
      );
      failed = result.isError;
    } catch {
      failed = true;
    }
    assert.equal(
      await readFile(canary, "utf8"),
      "unchanged",
      "revoked or canceled tool must not invoke a physical update callback",
    );
    assert.equal(failed, true);
  });
}

for (const stage of ["beforeToolCall", "afterToolCall"]) {
  for (const interruption of ["revoke", "cancel"]) {
    test(`${interruption} during awaited owned ${stage} prevents subsequent physical effects`, async (t) => {
      const { fixture, tool, canary, args } = await admittedWriteFixture(t);
      const nextCanary = join(fixture.cwd, "next-callback.txt");
      await writeFile(nextCanary, "unchanged");
      let agent;
      let reached = false;
      const options = {
        initialState: { model: fixture.options.model, tools: [tool] },
        prepareNextTurn: async () => {
          await writeFile(nextCanary, "changed");
        },
        streamFn: () => {
          const stream = createAssistantMessageEventStream();
          const message = {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "owned-write",
                name: "write",
                arguments: args,
              },
            ],
            api: "openai-completions",
            provider: "fixture",
            model: "fixture",
            stopReason: "toolUse",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          };
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end(message);
          return stream;
        },
      };
      options[stage] = async () => {
        reached = true;
        await Promise.resolve();
        if (interruption === "revoke") fixture.current.revision++;
        else agent.abort();
      };
      fixture.owner.bind(options, "agent-options");
      agent = new Agent(options);
      await agent.prompt("fixture");
      assert.equal(reached, true);
      assert.equal(
        await readFile(canary, "utf8"),
        stage === "beforeToolCall" ? "unchanged" : "admitted",
        "owned hook interruption must preserve admission ordering",
      );
      assert.equal(
        await readFile(nextCanary, "utf8"),
        "unchanged",
        "interrupted hook must prevent the next physical callback",
      );
    });
  }
}

test("exposed Agent cannot mint or substitute a low-level loop stream callback", async (t) => {
  const fixture = await services(t);
  const { session } = await createAgentSession(fixture.options);
  t.after(() => session.dispose());
  const canary = join(fixture.cwd, "loop-stream.txt");
  await writeFile(canary, "unchanged");
  const config = {
    model: fixture.options.model,
    convertToLlm: (messages) => messages,
  };
  let calls = 0;
  const stream = async () => {
    calls++;
    await writeFile(canary, "unadmitted");
    throw new Error("unadmitted callback reached");
  };
  try {
    inheritSplyceOwner(session.agent, config, "loop-config");
  } catch {}
  try {
    await agentApi.runAgentLoop(
      [
        {
          role: "user",
          content: [{ type: "text", text: "fixture" }],
          timestamp: 0,
        },
      ],
      { messages: [], tools: [] },
      config,
      () => {},
      undefined,
      stream,
    );
  } catch {}
  const extracted = session.agent.createLoopConfig();
  try {
    await agentApi.runAgentLoop(
      [],
      { messages: [], tools: [] },
      extracted,
      () => {},
      undefined,
      stream,
    );
  } catch {}
  session.agent.streamFunction = stream;
  await session.agent.prompt("mutated callback");
  assert.equal(
    calls,
    0,
    "exposed Agent must not dispatch a caller-selected loop stream",
  );
  assert.equal(
    await readFile(canary, "utf8"),
    "unchanged",
    "unadmitted loop callback must preserve physical bytes",
  );
  assert.throws(
    () => inheritSplyceOwner(session.agent, {}, "loop-config"),
    unavailable,
  );
});

test("owned SDK rejects foreign dependencies and absent explicit selection before session persistence", async (t) => {
  const fixture = await services(t);
  for (const key of [
    "model",
    "modelRuntime",
    "sessionManager",
    "settingsManager",
    "resourceLoader",
  ]) {
    const original = fixture.options[key];
    fixture.options[key] = {};
    await assert.rejects(
      () => createAgentSession(fixture.options),
      unavailable,
    );
    fixture.options[key] = original;
  }
  for (const key of ["cwd", "agentDir", "model", "tools"]) {
    const original = fixture.options[key];
    delete fixture.options[key];
    await assert.rejects(
      () => createAgentSession(fixture.options),
      unavailable,
    );
    fixture.options[key] = original;
  }
  assert.deepEqual(fixture.options.sessionManager.getEntries(), []);
});

test("owned runtime and loader do not turn readiness into provider or module admission", async (t) => {
  const fixture = await services(t);
  const { modelRuntime, resourceLoader } = fixture.options;
  await assert.rejects(
    () => modelRuntime.getAuth(fixture.options.model),
    unavailable,
  );
  await assert.rejects(
    () => modelRuntime.refresh({ allowNetwork: true }),
    unavailable,
  );
  const denied = await modelRuntime.completeSimple(fixture.options.model, {
    messages: [],
  });
  assert.equal(denied.stopReason, "error");
  assert.equal(denied.errorMessage, "SPLYCE_UNAVAILABLE");
  await assert.rejects(() => resourceLoader.reload(), unavailable);
  assert.deepEqual(await readdir(fixture.agentDir), []);
});

test("actual owned Agent streams through its derived loop config and disposal denies further prompts", async () => {
  const fixture = ownerFixture();
  let streams = 0;
  const selectedModel = model();
  const options = {
    initialState: { model: selectedModel },
    prepareRequest: async () => ({ model: selectedModel }),
    prepareNextTurn: async () => ({ model: selectedModel }),
    finishTurn: () => ({ action: streams === 1 ? "continue" : "end" }),
    streamFn: () => {
      streams++;
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "local fixture" }],
        api: selectedModel.api,
        provider: selectedModel.provider,
        model: selectedModel.id,
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
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  };
  fixture.owner.bind(options, "agent-options");
  const agent = new Agent(options);
  await agent.prompt("local fixture");
  assert.equal(streams, 2);
  assert.equal(agent.state.messages.at(-1).content[0].text, "local fixture");
  fixture.owner.dispose();
  const before = structuredClone(agent.state.messages);
  await assert.rejects(() => agent.prompt("denied"), unavailable);
  assert.deepEqual(agent.state.messages, before);
  assert.equal(streams, 2);
});

test("owner revision changes during an awaited transform deny before local stream dispatch", async () => {
  const fixture = ownerFixture();
  let streams = 0;
  const options = {
    initialState: { model: model() },
    transformContext: async (messages) => {
      fixture.current.revision++;
      return messages;
    },
    streamFn: () => {
      streams++;
      throw new Error("must not stream");
    },
  };
  fixture.owner.bind(options, "agent-options");
  const agent = new Agent(options);
  await agent.prompt("fixture");
  assert.equal(streams, 0);
  assert.equal(agent.state.errorMessage, "SPLYCE_UNAVAILABLE");
});

for (const key of [
  "prepareRequest",
  "transformContext",
  "convertToLlm",
  "getApiKey",
  "beforeToolCall",
  "afterToolCall",
  "prepareNextTurn",
  "prepareNextTurnWithContext",
  "finishTurn",
  "onPayload",
  "onResponse",
  "onProviderStreamEvent",
]) {
  test(`initialized SDK callback ${key} replacement is denied before physical effects`, async (t) => {
    const fixture = await services(t);
    const { session } = await createAgentSession(fixture.options);
    t.after(() => session.dispose());
    const canary = join(fixture.cwd, "callback.txt");
    await writeFile(canary, "unchanged");
    session.agent[key] = async () => {
      await writeFile(canary, "changed");
    };
    await assert.rejects(() => session.agent.prompt("fixture"), unavailable);
    assert.equal(
      await readFile(canary, "utf8"),
      "unchanged",
      "replaced callback must preserve physical bytes",
    );
  });
}

test("sealed Agent callback snapshot preserves physical bytes", async (t) => {
  const fixture = ownerFixture();
  const dir = await mkdtemp(join(tmpdir(), "splyce-callback-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const canary = join(dir, "callback.txt");
  await writeFile(canary, "unchanged");
  const options = {
    initialState: { model: model() },
    streamFn: () => {
      throw new Error("fixture stream");
    },
  };
  fixture.owner.bind(options, "agent-options");
  const agent = new Agent(options);
  agent.prepareRequest = async () => {
    await writeFile(canary, "changed");
  };
  let error;
  try {
    await agent.prompt("fixture");
  } catch (caught) {
    error = caught;
  }
  assert.equal(
    await readFile(canary, "utf8"),
    "unchanged",
    "replaced callback must preserve physical bytes",
  );
  assert.equal(error?.code, "SPLYCE_UNAVAILABLE");
});

for (const stage of [
  "prepareRequest",
  "transformContext",
  "convertToLlm",
  "getApiKey",
]) {
  for (const interruption of ["revoke", "cancel"]) {
    test(`${interruption} during awaited ${stage} prevents the next physical callback`, async (t) => {
      const fixture = ownerFixture();
      const dir = await mkdtemp(join(tmpdir(), "splyce-callback-await-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const canary = join(dir, "callback.txt");
      await writeFile(canary, "unchanged");
      let agent;
      let reached = false;
      const effects = {
        prepareRequest: "transformContext",
        transformContext: "convertToLlm",
        convertToLlm: "getApiKey",
        getApiKey: "streamFn",
      };
      const options = {
        initialState: { model: model() },
        streamFn: () => {
          throw new Error("stream must stay unreachable");
        },
      };
      options[stage] = async (value) => {
        reached = true;
        await Promise.resolve();
        if (interruption === "revoke") fixture.current.revision++;
        else agent.abort();
        return stage === "convertToLlm" || stage === "transformContext"
          ? value
          : undefined;
      };
      options[effects[stage]] = async () => {
        await writeFile(canary, "changed");
        throw new Error("next callback reached");
      };
      fixture.owner.bind(options, "agent-options");
      agent = new Agent(options);
      await agent.prompt("fixture");
      assert.equal(reached, true);
      assert.equal(
        await readFile(canary, "utf8"),
        "unchanged",
        "interrupted callback must prevent the next physical effect",
      );
      assert.equal(agent.state.isStreaming, false);
      assert.equal(
        agent.state.errorMessage,
        interruption === "cancel"
          ? "This operation was aborted"
          : "SPLYCE_UNAVAILABLE",
      );
    });
  }
}

for (const stage of [
  "prepareNextTurn",
  "prepareNextTurnWithContext",
  "finishTurn",
]) {
  for (const interruption of ["revoke", "cancel"]) {
    test(`${interruption} during awaited ${stage} prevents continuation callbacks`, async (t) => {
      const fixture = ownerFixture();
      const dir = await mkdtemp(join(tmpdir(), "splyce-continuation-await-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const canary = join(dir, "callback.txt");
      await writeFile(canary, "unchanged");
      let agent;
      let requests = 0;
      let reached = false;
      const options = {
        initialState: { model: model() },
        prepareRequest: async () => {
          if (++requests > 1) await writeFile(canary, "changed");
        },
        finishTurn: () => ({ action: "continue" }),
        streamFn: () => {
          const stream = createAssistantMessageEventStream();
          const message = {
            role: "assistant",
            content: [],
            api: "openai-completions",
            provider: "fixture",
            model: "fixture",
            stopReason: "stop",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          };
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
          return stream;
        },
      };
      options[stage] = async () => {
        reached = true;
        await Promise.resolve();
        if (interruption === "revoke") fixture.current.revision++;
        else agent.abort();
        return stage === "finishTurn" ? { action: "continue" } : undefined;
      };
      fixture.owner.bind(options, "agent-options");
      agent = new Agent(options);
      await agent.prompt("fixture");
      assert.equal(reached, true);
      assert.equal(requests, 1);
      assert.equal(
        await readFile(canary, "utf8"),
        "unchanged",
        "interrupted continuation must preserve physical bytes",
      );
    });
  }
}

for (const interruption of ["revoke", "cancel"]) {
  test(`streaming loop reports ${interruption} during awaited context through iterator and result`, async () => {
    const fixture = ownerFixture();
    const controller = new AbortController();
    let streamed = 0;
    const options = {
      initialState: { model: model() },
      transformContext: async (messages) => {
        await Promise.resolve();
        if (interruption === "revoke") fixture.current.revision++;
        else controller.abort();
        return messages;
      },
      streamFn: () => {
        streamed++;
        throw new Error("stream must stay unreachable");
      },
    };
    fixture.owner.bind(options, "agent-options");
    const agent = new Agent(options);
    const stream = agentApi.agentLoop(
      [{ role: "user", content: [], timestamp: 0 }],
      { messages: [], tools: [] },
      agent.createLoopConfig(),
      controller.signal,
      agent.streamFunction,
    );
    await assert.rejects(
      async () => {
        for await (const _event of stream) {
          /* drain actual event stream */
        }
      },
      interruption === "revoke" ? unavailable : { name: "AbortError" },
    );
    await assert.rejects(
      () => stream.result(),
      interruption === "revoke" ? unavailable : { name: "AbortError" },
    );
    assert.equal(streamed, 0);
  });
}

for (const interruption of ["revoke", "cancel"]) {
  test(`SDK subscriber ${interruption} prevents the next physical subscriber`, async (t) => {
    const fixture = await services(t);
    const { session } = await createAgentSession(fixture.options);
    t.after(() => session.dispose());
    const canary = join(fixture.cwd, "subscriber.txt");
    await writeFile(canary, "unchanged");
    let reached = false;
    session.agent.subscribe(async () => {
      reached = true;
      await Promise.resolve();
      if (interruption === "revoke") fixture.current.revision++;
      else session.agent.abort();
    });
    session.agent.subscribe(() => writeFile(canary, "changed"));
    await session.agent.prompt("fixture");
    assert.equal(reached, true);
    assert.equal(
      await readFile(canary, "utf8"),
      "unchanged",
      "interrupted subscriber must not reach subsequent subscribers",
    );
    assert.equal(session.agent.state.isStreaming, false);
  });

  test(`interrupted ${interruption} failure handling does not invoke physical subscribers`, async (t) => {
    const fixture = ownerFixture();
    const dir = await mkdtemp(join(tmpdir(), "splyce-failure-subscriber-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const canary = join(dir, "subscriber.txt");
    await writeFile(canary, "unchanged");
    let agent;
    const options = {
      initialState: { model: model() },
      streamFn: () => {
        throw new Error("must not stream");
      },
      transformContext: async (messages) => {
        await Promise.resolve();
        if (interruption === "revoke") fixture.current.revision++;
        else agent.abort();
        return messages;
      },
    };
    fixture.owner.bind(options, "agent-options");
    agent = new Agent(options);
    agent.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant")
        return writeFile(canary, "changed");
    });
    await agent.prompt("fixture");
    assert.equal(
      await readFile(canary, "utf8"),
      "unchanged",
      "interrupted failure handling must preserve physical subscriber bytes",
    );
    assert.equal(agent.state.isStreaming, false);
    assert.ok(agent.state.errorMessage);
  });
}

test("derived loop callback replacement is rejected before its physical effect", async (t) => {
  const fixture = await services(t);
  const { session } = await createAgentSession(fixture.options);
  t.after(() => session.dispose());
  const canary = join(fixture.cwd, "loop-callback.txt");
  await writeFile(canary, "unchanged");
  const config = session.agent.createLoopConfig();
  config.prepareRequest = async () => {
    await writeFile(canary, "changed");
  };
  await assert.rejects(
    () =>
      agentApi.runAgentLoop(
        [],
        { messages: [], tools: [] },
        config,
        () => {},
        undefined,
        session.agent.streamFunction,
      ),
    unavailable,
  );
  assert.equal(await readFile(canary, "utf8"), "unchanged");
});

test(
  "removing native identity, role, current-state or disposal guards fails their independent behavioral assertions",
  { skip: process.env.SPLYCE_OWNER_MUTANT === "1" },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "splyce-owner-mutant-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const hook = join(dir, "owner-mutant.mjs");
    await writeFile(
      hook,
      `import { registerHooks } from "node:module";
registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (!url.endsWith('/agent/dist/splyce-readiness.js')) return loaded;
  const source = String(loaded.source);
  const kind = process.env.SPLYCE_OWNER_TARGET;
  let mutated = source;
  if (kind === 'identity') mutated = source.replace('if (!binding || binding.owner.disposed)', 'if (!binding) return { owner: { checkCurrent() {}, disposed: false }, role: "session" }; if (binding.owner.disposed)');
  if (kind === 'role') mutated = source.replace('if (!derivations[binding.role]?.includes(role))', 'if (false)');
  if (kind === 'current') mutated = source.replaceAll('binding.owner.checkCurrent();', 'void 0;');
  if (kind === 'disposed') mutated = source.replace('!binding || binding.owner.disposed', '!binding').replace('if (binding.owner.disposed)', 'if (false)');
  if (kind === 'tool-current') mutated = source.replace('if (bindings.has(tool))', 'if (false)');
  if (kind === 'tool-exposure') mutated = source.replace('tool.execute = () => unavailable();', 'void 0;');
  if (kind === 'callback-snapshot') mutated = source.replace('!snapshot || callbackKeys.some((key) => snapshot[key] !== agent[key])', '!snapshot').replace('return snapshot;', 'return agent;');
  if (kind === 'stream-binding') mutated = source.replace('if (streams.get(config) !== stream)', 'if (false)');
  if (mutated === source) throw new Error('owner mutation target not found');
  return { ...loaded, source: mutated };
} });\n`,
    );
    for (const [kind, pattern, observation] of [
      [
        "callback-snapshot",
        "sealed Agent callback snapshot",
        /replaced callback must preserve physical bytes/,
      ],
      ["identity", "private owner mint", /Missing expected exception/],
      ["role", "private owner mint", /Missing expected exception/],
      ["current", "native revision changes", /Missing expected exception/],
      [
        "current",
        "owned async tool revoke",
        /revoked or canceled tool must not invoke a physical update callback/,
      ],
      [
        "current",
        "SDK subscriber revoke",
        /interrupted subscriber must not reach subsequent subscribers/,
      ],
      ["disposed", "same-owner checks", /Missing expected exception/],
      [
        "tool-current",
        "disposed owned tool",
        /disposed owner must not append a reservation/,
      ],
      [
        "tool-exposure",
        "direct final owned tool",
        /direct owned tool must not write without native admission/,
      ],
      [
        "stream-binding",
        "exposed Agent cannot",
        /exposed Agent must not dispatch a caller-selected loop stream/,
      ],
    ]) {
      const env = Object.fromEntries(
        ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT"]
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      );
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
            ...env,
            HOME: dir,
            USERPROFILE: dir,
            PI_CODING_AGENT_DIR: dir,
            SPLYCE_OWNER_MUTANT: "1",
            SPLYCE_OWNER_TARGET: kind,
          },
          encoding: "utf8",
          timeout: 30000,
          windowsHide: true,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(
        result.status,
        1,
        `${kind}: ${result.stdout}\n${result.stderr}`,
      );
      assert.match(result.stdout + result.stderr, observation, kind);
    }
  },
);
