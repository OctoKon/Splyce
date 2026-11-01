import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Agent,
  agentLoop,
  agentLoopContinue,
  runAgentLoop,
  runAgentLoopContinue,
  runToolCall,
} from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { NestedToolCallRunner } from "../vendor/pi/packages/coding-agent/dist/core/nested-tool-calls.js";

const unavailable = {
  message: "SPLYCE_UNAVAILABLE",
  code: "SPLYCE_UNAVAILABLE",
};
const user = {
  role: "user",
  content: [{ type: "text", text: "fixture" }],
  timestamp: 0,
};
const assistant = {
  role: "assistant",
  content: [],
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  timestamp: 0,
  stopReason: "toolUse",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
const model = {
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
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "splyce-native-entry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Check effects even when a removed fence lets the operation resolve or fail later.
async function denied(operation, verify) {
  let error;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  await verify();
  assert.ok(error, "entrypoint must reject");
  assert.equal(error.code, unavailable.code, error.stack);
  assert.equal(error.message, unavailable.message);
}

for (const method of ["prompt", "continue"]) {
  test(`Agent ${method} rejects before lifecycle or transcript changes`, async () => {
    const calls = [];
    const agent = new Agent({
      initialState: { model, messages: [user] },
      streamFn: () => {
        calls.push("stream");
        throw new Error("fixture stream reached");
      },
      transformContext: async (messages) => {
        calls.push("transform");
        return messages;
      },
      getApiKey: () => {
        calls.push("credential");
        return undefined;
      },
    });
    agent.subscribe((event) => calls.push(event.type));
    const before = structuredClone(agent.state);
    await denied(
      () =>
        method === "prompt" ? agent.prompt("new prompt") : agent.continue(),
      () => {
        assert.deepEqual(
          agent.state,
          before,
          "denial must preserve agent state",
        );
        assert.deepEqual(
          calls,
          [],
          "denial must precede lifecycle and provider callbacks",
        );
      },
    );
    await agent.waitForIdle();
  });
}

for (const continuation of [false, true]) {
  test(`public streaming ${continuation ? "continue" : "start"} rejects synchronously before creating a runnable stream`, () => {
    const context = { messages: [user], tools: [] };
    const config = { model, convertToLlm: (messages) => messages };
    const stream = () => {
      throw new Error("fixture stream reached");
    };
    assert.throws(
      () =>
        continuation
          ? agentLoopContinue(context, config, undefined, stream)
          : agentLoop([user], context, config, undefined, stream),
      unavailable,
    );
    assert.deepEqual(context.messages, [user]);
  });
}

for (const continuation of [false, true]) {
  test(`public async ${continuation ? "continue" : "start"} rejects before event, transform, credential or stream callbacks`, async () => {
    const calls = [];
    const context = { messages: [user], tools: [] };
    const config = {
      model,
      convertToLlm: (messages) => {
        calls.push("convert");
        return messages;
      },
      transformContext: async (messages) => {
        calls.push("transform");
        return messages;
      },
      getApiKey: () => {
        calls.push("credential");
        return undefined;
      },
    };
    const emit = (event) => calls.push(event.type);
    const stream = () => {
      calls.push("stream");
      throw new Error("fixture stream reached");
    };
    await denied(
      () =>
        continuation
          ? runAgentLoopContinue(context, config, emit, undefined, stream)
          : runAgentLoop([user], context, config, emit, undefined, stream),
      () => {
        assert.deepEqual(calls, []);
        assert.deepEqual(context.messages, [user]);
      },
    );
  });
}

for (const nested of [false, true]) {
  test(`${nested ? "nested" : "standalone"} tool dispatch denies before argument hooks and physical execution`, async (t) => {
    const dir = await fixture(t);
    const canary = join(dir, "tool.txt");
    await writeFile(canary, "unchanged");
    const calls = [];
    const tool = {
      name: "fixture_write",
      label: "Fixture write",
      description: "Write owned fixture",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      prepareArguments: (args) => {
        calls.push("arguments");
        return args;
      },
      execute: async (_id, args) => {
        calls.push("execute");
        await writeFile(canary, args.text);
        return { content: [{ type: "text", text: "written" }], details: {} };
      },
    };
    const context = { messages: [user], tools: [tool] };
    const options = {
      tools: [tool],
      assistantMessage: assistant,
      context,
      beforeToolCall: async () => {
        calls.push("before");
      },
      afterToolCall: async () => {
        calls.push("after");
      },
      onUpdate: () => calls.push("update"),
    };
    const toolCall = {
      type: "toolCall",
      id: "parent/1",
      name: tool.name,
      arguments: { text: "changed" },
    };
    const events = [];
    const runner = new NestedToolCallRunner({
      getTools: () => [tool],
      isSequential: () => false,
      emit: async (event) => {
        events.push(event);
      },
      runToolCall: (call, _parent, signal, onUpdate) =>
        runToolCall(call, { ...options, signal, onUpdate }),
    });
    await denied(
      () =>
        nested
          ? runner.execute("parent", tool.name, toolCall.arguments)
          : runToolCall(toolCall, options),
      async () => {
        assert.equal(
          await readFile(canary, "utf8"),
          "unchanged",
          "denied tool must not change physical bytes",
        );
        assert.deepEqual(
          calls,
          [],
          "argument preparation and hooks must not run",
        );
        assert.deepEqual(
          events.map((event) => event.type),
          nested ? ["tool_execution_start"] : [],
        );
      },
    );
  });
}

async function resources(t) {
  const dir = await fixture(t);
  const cwd = join(dir, "project");
  const agentDir = join(dir, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const canary = join(dir, "extension.txt");
  await writeFile(canary, "unchanged");
  const settingsManager = SettingsManager.inMemory(
    {},
    { projectTrusted: true },
  );
  let factories = 0;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      async () => {
        factories++;
        await writeFile(canary, "loaded");
      },
    ],
  });
  const verify = async () => {
    assert.equal(
      await readFile(canary, "utf8"),
      "unchanged",
      "denied startup must not execute extension code",
    );
    assert.equal(factories, 0);
    assert.equal(
      settingsManager.isProjectTrusted(),
      true,
      "denial must not change project trust",
    );
    assert.deepEqual(loader.getExtensions().extensions, []);
  };
  return { dir, cwd, agentDir, settingsManager, loader, verify };
}

test("SDK session creation denies before real loader factories and startup files", async (t) => {
  const r = await resources(t);
  await mkdir(join(r.agentDir, "extensions"));
  await writeFile(
    join(r.agentDir, "extensions", "fixture.ts"),
    `import { writeFile } from 'node:fs/promises';
export default async function () { await writeFile(${JSON.stringify(join(r.dir, "extension.txt"))}, 'loaded'); }\n`,
  );
  const sessionManager = SessionManager.inMemory(r.cwd);
  let optionReads = 0;
  await denied(
    () =>
      createAgentSession({
        get cwd() {
          optionReads++;
          return r.cwd;
        },
        agentDir: r.agentDir,
        settingsManager: r.settingsManager,
        sessionManager,
        model,
        noTools: "all",
      }),
    async () => {
      await r.verify();
      assert.equal(
        existsSync(join(r.agentDir, "auth.json")),
        false,
        "denial must not create credential storage",
      );
      assert.equal(sessionManager.getEntries().length, 0);
      assert.equal(
        optionReads,
        0,
        "SDK denial must precede input option access",
      );
    },
  );
});

test("resource reload denies before extension factories and trust resolution", async (t) => {
  const r = await resources(t);
  let trustPrompts = 0;
  await denied(
    () =>
      r.loader.reload({
        resolveProjectTrust: async () => {
          trustPrompts++;
          return false;
        },
      }),
    async () => {
      await r.verify();
      assert.equal(trustPrompts, 0);
    },
  );
});

test("project-trust extension loading denies before settings mutation or factory execution", async (t) => {
  const r = await resources(t);
  await denied(() => r.loader.loadProjectTrustExtensions(), r.verify);
});

test("model runtime creation denies before credential file creation and catalog network", async (t) => {
  const dir = await fixture(t);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const authPath = join(dir, "auth.json");
  await denied(
    () =>
      ModelRuntime.create({
        authPath,
        modelsPath: null,
        allowModelNetwork: true,
        modelRefreshTimeoutMs: 250,
        catalogBaseUrl: `http://127.0.0.1:${server.address().port}`,
      }),
    () => {
      assert.equal(
        existsSync(authPath),
        false,
        "denial must precede real credential storage startup",
      );
      assert.equal(requests, 0, "denial must precede catalog requests");
    },
  );
});

test(
  "removing native fences in isolated module loads breaks the corresponding observations",
  { skip: process.env.SPLYCE_ENTRY_MUTANT === "1" },
  async (t) => {
    const dir = await fixture(t);
    const hook = join(dir, "mutation.mjs");
    await writeFile(
      hook,
      `import { registerHooks } from 'node:module';
const targets = JSON.parse(process.env.SPLYCE_ENTRY_TARGETS);
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (targets.some(target => url.endsWith(target))) {
    const source = String(result.source);
    const fence = /(?:assertSplyceReady|assertSameSplyceOwner|assertSplyceLoopStream)\\([^;]*?\\);/g;
    if (!fence.test(source)) throw new Error('mutation target not found');
    let mutated = source.replace(fence, 'void 0;').replaceAll('getSplyceAgentCallbacks(this)', 'this');
    if (url.endsWith('/agent/dist/splyce-admission.js')) {
      const binding = 'const admission = tool && admissions.get(tool);';
      if (!mutated.includes(binding)) throw new Error('binding mutation target not found');
      mutated = mutated.replace(binding, 'const admission = {check() {}, reserve() {}, async prepare() {}, finish() {}, discard() {}, execute(_id, _name, args, invoke) {return invoke(args);}};');
    }
    return { ...result, source: mutated };
  }
  return result;
} });\n`,
    );
    const cases = [
      [
        "Agent prompt",
        ["/agent/dist/agent.js"],
        /denial must preserve agent state/,
      ],
      [
        "Agent continue",
        ["/agent/dist/agent.js"],
        /denial must preserve agent state/,
      ],
      [
        "public streaming start",
        ["/agent/dist/agent-loop.js"],
        /Missing expected exception/,
      ],
      [
        "public streaming continue",
        ["/agent/dist/agent-loop.js"],
        /Missing expected exception/,
      ],
      [
        "public async start",
        ["/agent/dist/agent-loop.js"],
        /actual|Expected values to be strictly deep-equal/,
      ],
      [
        "public async continue",
        ["/agent/dist/agent-loop.js"],
        /actual|Expected values to be strictly deep-equal/,
      ],
      [
        "standalone tool",
        ["/agent/dist/splyce-admission.js"],
        /denied tool must not change physical bytes/,
      ],
      [
        "nested tool",
        ["/agent/dist/splyce-admission.js"],
        /denied tool must not change physical bytes/,
      ],
      [
        "SDK session creation",
        ["/coding-agent/dist/core/sdk.js"],
        /SDK denial must precede input option access/,
      ],
      // Owned SDK creation has no ambient runtime/loader fallback to activate.
      // The SDK probe above retains input-access ordering; loader probes retain physical effects.
      [
        "resource reload",
        ["/coding-agent/dist/core/resource-loader.js"],
        /denied startup must not execute extension code/,
      ],
      [
        "project-trust extension loading",
        ["/coding-agent/dist/core/resource-loader.js"],
        /denied startup must not execute extension code/,
      ],
      [
        "model runtime creation",
        ["/coding-agent/dist/core/model-runtime.js"],
        /denial must precede real credential storage startup/,
      ],
    ];
    // A clean environment keeps mutation probes away from ambient provider credentials.
    const env = Object.fromEntries(
      ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT"]
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    );
    for (const [name, targets, observation] of cases) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(hook).href,
          "--test",
          "--test-name-pattern",
          `^${name}`,
          fileURLToPath(import.meta.url),
        ],
        {
          env: {
            ...env,
            HOME: dir,
            USERPROFILE: dir,
            PI_CODING_AGENT_DIR: dir,
            SPLYCE_ENTRY_MUTANT: "1",
            SPLYCE_ENTRY_TARGETS: JSON.stringify(targets),
          },
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(
        result.error,
        undefined,
        `${name}: ${result.stdout}\n${result.stderr}\n${result.error?.message}`,
      );
      assert.equal(result.signal, null, `${name}: mutation probe timed out`);
      assert.notEqual(
        result.status,
        0,
        `${name}: removed native guard was not detected`,
      );
      assert.match(
        result.stdout + result.stderr,
        /AssertionError|ERR_ASSERTION/,
        `${name}: failure must come from a behavior assertion`,
      );
      assert.match(
        result.stdout + result.stderr,
        observation,
        `${name}: mutation must expose the expected observable change`,
      );
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /mutation target not found|ERR_MODULE_NOT_FOUND|SyntaxError/,
        `${name}: probe must load the actual implementation`,
      );
    }
  },
);
