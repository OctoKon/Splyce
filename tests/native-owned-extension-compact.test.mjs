import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
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
import { prepareCompaction } from "../vendor/pi/packages/coding-agent/dist/core/compaction/compaction.js";
import { loadExtensionFromFactory } from "../vendor/pi/packages/coding-agent/dist/core/extensions/loader.js";
import { InMemoryCodingAgentModelsStore } from "../vendor/pi/packages/coding-agent/dist/core/models-store.js";

const refusal = {
  code: "PERSIST_REDACTION_UNAVAILABLE",
  message: "PERSIST_REDACTION_UNAVAILABLE",
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const turn = () => new Promise((done) => setImmediate(done));
const rows = (serialized) =>
  serialized
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
async function within(promise) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Compaction failure event was not observed")),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

// Actual owned SDK, file-backed manager and trusted inline extension. Its supported
// session_before_compact result avoids provider generation; no native/provider claim.
async function fixture(t) {
  const temporary = resolve(tmpdir());
  const directory = await mkdtemp(join(temporary, "splyce-extension-compact-"));
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const owner = createSplyceOwner(() => {});
  let session;
  t.after(async () => {
    session?.dispose();
    owner.dispose();
    const child = relative(temporary, resolve(directory));
    assert.ok(child && !isAbsolute(child) && !child.startsWith(".."));
    await rm(directory, { recursive: true, force: true });
  });
  const state = {
    calls: 0,
    refusals: 0,
    refuseCompaction: false,
    beforeCompact: 0,
    compacted: 0,
    failed: 0,
    persistedBeforeSuccessEvent: false,
    failure: deferred(),
    context: undefined,
  };
  const manager = await SessionManager.createOwned(
    cwd,
    (value) => {
      owner.bindPersistence(value, async (serialized) => {
        state.calls++;
        if (
          state.refuseCompaction &&
          rows(serialized).some((entry) => entry.type === "compaction")
        ) {
          state.refusals++;
          throw Object.assign(
            new Error("synthetic compaction persistence refusal"),
            { code: refusal.code },
          );
        }
        return serialized;
      });
    },
    join(directory, "sessions"),
  );
  const model = {
    id: "compact-fixture",
    name: "Compaction fixture",
    provider: "compact-fixture",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  await manager.withPersistence((draft) => {
    for (let index = 0; index < 4; index++) {
      draft.appendMessage({
        role: "user",
        content: `synthetic user ${index} `.repeat(64),
        timestamp: index * 2,
      });
      draft.appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: `synthetic reply ${index} `.repeat(64) },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop",
        timestamp: index * 2 + 1,
      });
    }
  });
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 128, keepRecentTokens: 32 },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const resources = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
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
  const runtime = await ModelRuntime.create(runtimeOptions);
  for (const [value, role] of [
    [model, "model"],
    [settings, "settings-manager"],
    [resources, "resource-loader"],
  ])
    owner.bind(value, role);
  const loaded = resources.getExtensions();
  const extension = await loadExtensionFromFactory(
    (pi) => {
      pi.on("session_start", (_event, context) => {
        state.context = context;
      });
      pi.on("session_before_compact", (event) => {
        state.beforeCompact++;
        return {
          compaction: {
            summary: "synthetic owned checkpoint",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        };
      });
      pi.on("session_compact_failed", () => {
        state.failed++;
        state.failure.resolve();
      });
      pi.on("session_compact", async (event) => {
        state.compacted++;
        state.persistedBeforeSuccessEvent = rows(
          await readFile(manager.getSessionFile(), "utf8"),
        ).some(
          (entry) =>
            entry.id === event.compactionEntry.id &&
            entry.type === "compaction",
        );
      });
    },
    cwd,
    createEventBus(),
    loaded.runtime,
  );
  loaded.extensions.push(extension);
  const options = {
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: resources,
    tools: [],
  };
  owner.bind(options, "sdk-options");
  ({ session } = await createAgentSession(options));
  await session.bindExtensions({});
  assert.equal(isSplyceOwned(session), true);
  assert.equal(
    state.context?.isProjectTrusted(),
    true,
    "actual trusted extension context must be active",
  );
  assert.equal(typeof state.context.compact, "function");
  const preparation = prepareCompaction(
    manager.getBranch(),
    settings.getCompactionSettings(model),
  );
  assert.ok(
    preparation && preparation.tokensBefore > 0,
    "real history must be compactable",
  );
  assert.ok(
    preparation.messagesToSummarize.length +
      preparation.turnPrefixMessages.length >
      0,
  );
  const events = [];
  session.subscribe((event) => events.push(event));
  const snapshot = async () => ({
    entries: manager.getEntries(),
    leaf: manager.getLeafId(),
    jsonl: await readFile(manager.getSessionFile(), "utf8"),
    messages: structuredClone(session.agent.state.messages),
  });
  return { state, session, manager, events, snapshot };
}

test("owned trusted extension compact refuses synchronously before async work without callbacks", async (t) => {
  const f = await fixture(t);
  f.state.refuseCompaction = true;
  const before = await f.snapshot();
  const calls = f.state.calls;
  let callbacks = 0;
  for (const options of [
    undefined,
    { onComplete: () => callbacks++, onError: () => callbacks++ },
  ]) {
    let caught;
    let returned;
    try {
      returned = f.state.context.compact(options);
    } catch (error) {
      caught = error;
    }
    if (!caught) {
      await within(f.state.failure.promise);
      await turn();
      assert.equal(
        f.state.refusals,
        1,
        "baseline must reach actual refused compaction persistence",
      );
    }
    assert.ok(
      caught,
      `trusted ctx.compact returned ${typeof returned} and discarded persistence rejection; ` +
        JSON.stringify({
          sanitizerRefusals: f.state.refusals,
          beforeCompact: f.state.beforeCompact,
          failedEvents: f.state.failed,
        }),
    );
    assert.equal(caught.code, refusal.code);
    assert.equal(caught.message, refusal.message);
    assert.equal(Object.hasOwn(caught, "cause"), false);
  }
  await turn();
  assert.equal(f.state.calls, calls);
  assert.equal(f.state.beforeCompact, 0);
  assert.equal(f.state.refusals, 0);
  assert.equal(f.state.failed, 0);
  assert.equal(f.state.compacted, 0);
  assert.equal(callbacks, 0);
  assert.deepEqual(f.events, []);
  assert.deepEqual(await f.snapshot(), before);
});

test("owned public awaited compact preserves persistence rejection and committed success", async (t) => {
  const f = await fixture(t);
  f.state.refuseCompaction = true;
  const before = await f.snapshot();
  await assert.rejects(
    () => f.session.compact("synthetic public compaction"),
    refusal,
  );
  assert.equal(f.state.refusals, 1);
  assert.equal(f.state.beforeCompact, 1);
  assert.equal(f.state.failed, 1);
  assert.equal(f.state.compacted, 0);
  assert.deepEqual(await f.snapshot(), before);
  f.state.refuseCompaction = false;
  const result = await f.session.compact("synthetic public retry");
  assert.equal(result.summary, "synthetic owned checkpoint");
  assert.equal(f.state.compacted, 1);
  assert.equal(f.state.persistedBeforeSuccessEvent, true);
  const saved = f.manager
    .getEntries()
    .filter((entry) => entry.type === "compaction");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].summary, result.summary);
  assert.equal(
    rows((await f.snapshot()).jsonl).filter(
      (entry) => entry.type === "compaction",
    ).length,
    1,
  );
});
