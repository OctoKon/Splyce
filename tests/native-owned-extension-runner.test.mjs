import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isSplyceOwned } from "@earendil-works/pi-agent-core";
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
import { InMemoryCodingAgentModelsStore } from "../vendor/pi/packages/coding-agent/dist/core/models-store.js";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
} from "../vendor/pi/packages/coding-agent/dist/core/extensions/loader.js";
import { ExtensionRunner } from "../vendor/pi/packages/coding-agent/dist/core/extensions/runner.js";

const unavailable = {
  code: "SPLYCE_UNAVAILABLE",
  message: "SPLYCE_UNAVAILABLE",
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const selectedModel = () => ({
  id: "owned-extension-fixture",
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
const observeRejections = (t) => {
  const errors = [];
  const listener = (error) => errors.push(error);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  return errors;
};

// Real SDK/session/runner and file-backed owned persistence. Only the native
// persistence callback and UI are fixture ports; no provider or MCP is started.
async function ownedFixture(t, withExtension = true) {
  const directory = await mkdtemp(join(tmpdir(), "splyce-owned-runner-"));
  assert.equal(dirname(directory), tmpdir());
  const cwd = join(directory, "project"),
    agentDir = join(directory, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const owner = createSplyceOwner(() => {});
  const state = {
    fail: false,
    code: "PERSIST_REDACTION_UNAVAILABLE",
    calls: 0,
  };
  const manager = await SessionManager.createOwned(
    cwd,
    (subject) => {
      owner.bindPersistence(subject, async (serialized) => {
        state.calls++;
        if (state.fail)
          throw Object.assign(new Error("synthetic private failure"), {
            code: state.code,
          });
        return serialized;
      });
    },
    join(directory, "sessions"),
  );
  await manager.withPersistence((draft) =>
    draft.appendMessage({
      role: "user",
      content: "fixture baseline",
      timestamp: 0,
    }),
  );
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    cacheWarming: "off",
  });
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
  owner.bind(runtimeOptions, "model-runtime-options");
  const modelRuntime = await ModelRuntime.create(runtimeOptions);
  const model = selectedModel();
  for (const [subject, role] of [
    [settingsManager, "settings-manager"],
    [resourceLoader, "resource-loader"],
    [model, "model"],
  ])
    owner.bind(subject, role);
  const markers = {
    event: join(directory, "event-entered.txt"),
    after: join(directory, "append-returned.txt"),
    ui: join(directory, "ui-invoked.txt"),
  };
  let api;
  const loaded = resourceLoader.getExtensions();
  if (withExtension) {
    const extension = await loadExtensionFromFactory(
      (pi) => {
        api = pi;
        for (const event of [
          "mcp_servers_change",
          "ui_prompt_start",
          "ui_prompt_end",
        ]) {
          pi.on(event, async () => {
            writeFileSync(markers.event, event);
            await pi.appendEntry("owned-notification", { event });
            writeFileSync(markers.after, event);
          });
        }
      },
      cwd,
      createEventBus(),
      loaded.runtime,
    );
    loaded.extensions.push(extension);
  }
  const options = {
    cwd,
    agentDir,
    model,
    modelRuntime,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    tools: [],
  };
  owner.bind(options, "sdk-options");
  const { session } = await createAgentSession(options);
  t.after(async () => {
    session.dispose();
    owner.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(
    isSplyceOwned(session.extensionRunner),
    true,
    "the actual SDK must bind the actual runner",
  );
  const file = manager.getSessionFile();
  assert.ok(file && existsSync(file), "fixture uses a physical JSONL file");
  const baseline = readFileSync(file);
  const entries = manager.getEntries();
  const ui = {};
  for (const method of ["select", "confirm", "input", "editor", "custom"])
    ui[method] = async () => {
      writeFileSync(markers.ui, method);
      return undefined;
    };
  session.extensionRunner.setUIContext(ui, "interactive");
  return {
    session,
    manager,
    state,
    api,
    runtime: loaded.runtime,
    markers,
    file,
    baseline,
    entries,
  };
}
async function assertUnchanged(f, detached) {
  await turn();
  await turn();
  assert.deepEqual(
    detached,
    [],
    "owned notification must not detach a rejection",
  );
  assert.deepEqual(
    readFileSync(f.file),
    f.baseline,
    "denied notification preserves physical JSONL",
  );
  assert.deepEqual(f.manager.getEntries(), f.entries);
  assert.equal(
    existsSync(f.markers.event),
    false,
    "denied notification must not enter an extension handler",
  );
  assert.equal(existsSync(f.markers.after), false);
}
async function failPersistence(f, code) {
  f.state.code = code;
  f.state.fail = true;
  await assert.rejects(f.api.appendEntry("refusal-control", {}), { code });
  assert.deepEqual(readFileSync(f.file), f.baseline);
  const calls = f.state.calls;
  return () =>
    assert.equal(
      f.state.calls,
      calls,
      "denied route must not attempt a detached append",
    );
}

test("owned runner permits noExtensions SDK startup", async (t) => {
  const f = await ownedFixture(t, false);
  assert.equal(f.session.extensionRunner.getExtensionPaths().length, 0);
  assert.deepEqual(readFileSync(f.file), f.baseline);
});

test("owned MCP initiating APIs deny before registry change and detached append", async (t) => {
  const detached = observeRejections(t);
  const f = await ownedFixture(t);
  for (const code of [
    "PERSIST_REDACTION_UNAVAILABLE",
    "PERSIST_ENTRY_TOO_LARGE",
  ]) {
    const noAppend = await failPersistence(f, code);
    for (const invoke of [
      () =>
        f.api.registerMcpServer("fixture", { url: "http://127.0.0.1:1/mcp" }),
      () => f.api.unregisterMcpServer("fixture"),
    ]) {
      let error;
      try {
        invoke();
      } catch (caught) {
        error = caught;
      }
      assert.equal(
        existsSync(f.markers.event),
        false,
        "owned MCP denial must preserve the physical handler marker",
      );
      assert.deepEqual(
        f.runtime.mcpServers.list(),
        [],
        "owned MCP denial must precede registry mutation",
      );
      assert.ok(
        error,
        "the initiating API must reject rather than report success",
      );
      assert.equal(error.code, unavailable.code);
      assert.equal(error.message, unavailable.message);
      noAppend();
      await assertUnchanged(f, detached);
    }
  }
  f.state.fail = false;
  await f.api.appendEntry("recovery-control", { value: "committed" });
  assert.notDeepEqual(
    readFileSync(f.file),
    f.baseline,
    "ordinary awaited persistence remains usable after denial",
  );
  assert.equal(f.manager.getEntries().at(-1).customType, "recovery-control");
});

test("owned UI initiating APIs deny before renderer and detached append", async (t) => {
  const detached = observeRejections(t);
  const f = await ownedFixture(t);
  const ui = f.session.extensionRunner.createContext().ui;
  for (const code of [
    "PERSIST_REDACTION_UNAVAILABLE",
    "PERSIST_ENTRY_TOO_LARGE",
  ]) {
    const noAppend = await failPersistence(f, code);
    for (const invoke of [
      () => ui.select("fixture", ["value"]),
      () => ui.confirm("fixture", "message"),
      () => ui.input("fixture"),
      () => ui.editor("fixture", "text"),
      () => ui.custom(() => undefined),
    ]) {
      let error;
      try {
        await invoke();
      } catch (caught) {
        error = caught;
      }
      assert.equal(
        existsSync(f.markers.ui),
        false,
        "owned UI denial must preserve the physical renderer marker",
      );
      assert.ok(
        error,
        "the initiating UI API must reject rather than report success",
      );
      assert.equal(error.code, unavailable.code);
      assert.equal(error.message, unavailable.message);
      noAppend();
      await assertUnchanged(f, detached);
    }
  }
});

test("unowned donor runner retains MCP changes and UI prompt notifications", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "splyce-donor-runner-"));
  assert.equal(dirname(directory), tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  manager.appendMessage({
    role: "user",
    content: "fixture baseline",
    timestamp: 0,
  });
  const runtime = createExtensionRuntime();
  const seen = [];
  const notifications = new Map(
    ["mcp_servers_change", "ui_prompt_start", "ui_prompt_end"].map((event) => [
      event,
      Promise.withResolvers(),
    ]),
  );
  const extension = await loadExtensionFromFactory(
    (pi) => {
      for (const event of [
        "mcp_servers_change",
        "ui_prompt_start",
        "ui_prompt_end",
      ])
        pi.on(event, async () => {
          await pi.appendEntry("donor-notification", { event });
          seen.push(event);
          notifications.get(event).resolve();
        });
    },
    directory,
    createEventBus(),
    runtime,
  );
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    directory,
    manager,
    {},
  );
  await runner.bindCore(
    {
      appendEntry: async (type, data) => {
        await manager.withPersistence((draft) =>
          draft.appendCustomEntry(type, data),
        );
      },
    },
    {},
  );
  runtime.mcpServers.register({
    name: "fixture",
    config: { url: "http://127.0.0.1:1/mcp" },
    extensionPath: "fixture",
  });
  await notifications.get("mcp_servers_change").promise;
  assert.deepEqual(seen, ["mcp_servers_change"]);
  assert.equal(runtime.mcpServers.list().length, 1);
  let invoked = false;
  runner.setUIContext(
    {
      select: async () => {
        invoked = true;
        return "value";
      },
    },
    "interactive",
  );
  assert.equal(
    await runner.createContext().ui.select("fixture", ["value"]),
    "value",
  );
  await notifications.get("ui_prompt_end").promise;
  assert.equal(invoked, true);
  assert.deepEqual(seen, [
    "mcp_servers_change",
    "ui_prompt_start",
    "ui_prompt_end",
  ]);
  assert.equal(
    readFileSync(manager.getSessionFile(), "utf8").split("donor-notification")
      .length - 1,
    3,
  );
});

test(
  "removing owned notification denials exposes physical effects in actual SDK callers",
  { timeout: 150000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "splyce-owned-runner-cut-"));
    assert.equal(dirname(directory), tmpdir());
    t.after(() => rm(directory, { recursive: true, force: true }));
    const hook = join(directory, "guard-cut.mjs");
    await writeFile(
      hook,
      [
        'import { registerHooks } from "node:module";',
        "registerHooks({ load(url, context, next) {",
        "  const loaded = next(url, context);",
        '  if (!url.endsWith("/coding-agent/dist/core/extensions/runner.js")) return loaded;',
        "  const source = String(loaded.source);",
        '  const guard = "if (isSplyceOwned(this) || isSplyceOwned(this.sessionManager))";',
        "  const first = source.indexOf(guard), last = source.lastIndexOf(guard);",
        '  if (first < 0 || first === last) throw new Error("owned route guard not found");',
        '  const at = process.env.SPLYCE_RUNNER_CUT === "mcp" ? first : last;',
        '  const mutated = source.slice(0, at) + "if (false)" + source.slice(at + guard.length);',
        "  return { ...loaded, source: mutated };",
        "} });",
      ].join("\n"),
    );
    for (const [target, pattern, oracle] of [
      [
        "mcp",
        "^owned MCP initiating APIs",
        /owned MCP denial must preserve the physical handler marker/,
      ],
      [
        "ui",
        "^owned UI initiating APIs",
        /owned UI denial must preserve the physical renderer marker/,
      ],
    ]) {
      const childEnv = { ...process.env, SPLYCE_RUNNER_CUT: target };
      delete childEnv.NODE_TEST_CONTEXT;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            pathToFileURL(hook).href,
            "--test",
            "--test-timeout=60000",
            "--test-name-pattern=" + pattern,
            fileURLToPath(import.meta.url),
          ],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: childEnv,
            windowsHide: true,
            timeout: 60000,
          },
        );
        const output = [];
        child.stdout.on("data", (chunk) => output.push(chunk));
        child.stderr.on("data", (chunk) => output.push(chunk));
        child.once("error", reject);
        child.once("close", (code, signal) =>
          resolve({
            code,
            signal,
            output: Buffer.concat(output).toString("utf8"),
          }),
        );
      });
      assert.equal(result.signal, null, result.output);
      assert.equal(result.code, 1, result.output);
      assert.match(
        result.output,
        oracle,
        "guard removal must reach the real physical oracle",
      );
      assert.doesNotMatch(
        result.output,
        /guard not found|ERR_MODULE_NOT_FOUND|TimeoutError/,
      );
    }
  },
);
