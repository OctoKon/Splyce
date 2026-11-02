import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";
import { createAgentContextTools } from "../packages/splyce-pi/dist/agent-context-tools.js";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { redactSecrets } from "../packages/splyce-retrieval/dist/retrieval.js";
import { commit, turn } from "./integration/memory-fixture.ts";

function fixture(t) {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "native-context-")),
  );
  const data = join(directory, "data");
  let host = createNativeHost(data);
  const writer = Store.open(join(data, "splyce", "store.db"));
  t.after(async () => {
    await host.shutdown();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    data,
    writer,
    get host() {
      return host;
    },
    reopen() {
      host.close();
      host = createNativeHost(data);
    },
    workspace(name = "project") {
      const root = join(directory, name);
      mkdirSync(root);
      const stat = statSync(root, { bigint: true });
      const { workspaceId } = host.admitWorkspace({
        canonicalPath: root,
        volumeSerial: String(stat.dev),
        fileId: String(stat.ino),
      });
      return { root, workspaceId };
    },
  };
}
const code = (expected) => (error) => error.code === expected;

test("native base startup succeeds while optional memory imports are blocked", (t) => {
  const f = fixture(t);
  const hostUrl = new URL(
    "../packages/splyce-pi/src/native-host.mjs",
    import.meta.url,
  ).href;
  const memoryUrl = new URL(
    "../packages/splyce-memory/dist/memory.js",
    import.meta.url,
  ).href;
  const script = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (/splyce-(?:memory|retrieval)|@splyce\\/(?:memory|retrieval)/.test(specifier))
        throw Object.assign(new Error("Optional module blocked"), { code: "OPTIONAL_MODULE_BLOCKED" });
      return next(specifier, context);
    }});
    const { createNativeHost } = await import(${JSON.stringify(hostUrl)});
    const host = createNativeHost(${JSON.stringify(f.data)});
    assert.equal(host.handshakeReadiness.state, "ready");
    host.close();
    await assert.rejects(import(${JSON.stringify(memoryUrl)}), { code: "OPTIONAL_MODULE_BLOCKED" });
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

async function tools(host, workspaceId) {
  const index = await host.codeIndexFor(workspaceId);
  return createAgentContextTools({
    workspaceRoot: host.resolveWorkspace(workspaceId).canonicalPath,
    index,
    codeTools: await host.codeToolsFor(workspaceId),
    memory: await host.memoryFor(workspaceId),
    scopeId: workspaceId,
    redact: redactSecrets,
  });
}
async function call(context, name, args) {
  const tool = context.find((item) => item.name === name);
  assert.ok(tool, name);
  return JSON.parse(await tool.execute(args));
}

test("native context providers are lazy and reject unadmitted scopes before disk effects", async (t) => {
  const { host, data } = fixture(t);
  assert.equal(existsSync(join(data, "splyce", "code-index")), false);
  assert.equal(existsSync(join(data, "splyce", "memory")), false);
  for (const method of ["codeIndexFor", "memoryFor", "codeToolsFor"]) {
    await assert.rejects(
      host[method]("unknown"),
      code("NATIVE_WORKSPACE_UNAVAILABLE"),
    );
    await assert.rejects(host[method]("../foreign"), code("NATIVE_INVALID_ID"));
  }
  assert.equal(existsSync(join(data, "splyce", "code-index")), false);
  assert.equal(existsSync(join(data, "splyce", "memory")), false);
});

test("native code_search finds real symbols and graph links, excludes secrets and oversized files", async (t) => {
  const f = fixture(t);
  const { root, workspaceId } = f.workspace();
  writeFileSync(
    join(root, "alpha.ts"),
    "export function expoWidget() { return 1; }\n",
  );
  writeFileSync(
    join(root, "beta.ts"),
    'import { expoWidget } from "./alpha";\nexport const usage = expoWidget();\n',
  );
  writeFileSync(join(root, ".env"), "EXPO_PRIVATE_MARKER=hidden\n");
  mkdirSync(join(root, ".ssh"));
  writeFileSync(join(root, ".ssh", "config"), "EXPO_PRIVATE_MARKER\n");
  writeFileSync(join(root, "large.ts"), "oversizedMarker ".repeat(10000));
  assert.equal(existsSync(join(f.data, "splyce", "code-index")), false);
  const [index, same] = await Promise.all([
    f.host.codeIndexFor(workspaceId),
    f.host.codeIndexFor(workspaceId),
  ]);
  assert.equal(index, same);
  assert.equal(index.root, root);
  assert.equal(index.maxFiles, 2000);
  assert.equal(index.maxFileBytes, 128 * 1024);
  assert.equal(index.fileCount, 2);
  const context = await tools(f.host, workspaceId);
  const search = await call(context, "code_search", { query: "expoWidget" });
  assert.ok(search.results.some((hit) => hit.path === "alpha.ts"));
  assert.match(
    JSON.stringify(await call(context, "code_symbol", { name: "expoWidget" })),
    /alpha\.ts/,
  );
  assert.match(
    JSON.stringify(
      await call(context, "code_dependencies", { path: "beta.ts" }),
    ),
    /alpha\.ts/,
  );
  assert.deepEqual(
    (await call(context, "code_search", { query: '"EXPO_PRIVATE_MARKER"' }))
      .results,
    [],
  );
  assert.deepEqual(
    (await call(context, "code_search", { query: "oversizedMarker" })).results,
    [],
  );
  assert.doesNotMatch(
    readFileSync(index.cacheFile, "utf8"),
    /EXPO_PRIVATE_MARKER/,
  );
});

test("captured committed turns are recalled with citations, survive reopen and honor source deletion", async (t) => {
  const f = fixture(t);
  const { workspaceId } = f.workspace();
  const events = commit(
    f.writer,
    turn(
      "expo",
      "alpha.ts",
      "ExpoWidget memory milestone",
      workspaceId,
      "chat-1",
    ),
    workspaceId,
    "chat-1",
  );
  assert.equal(await f.host.captureMemoryAfterTurn(workspaceId, "chat-1"), 1);
  assert.equal(await f.host.captureMemoryAfterTurn(workspaceId, "chat-1"), 0);
  let context = await tools(f.host, workspaceId);
  let hits = (await call(context, "memory_search", { query: "ExpoWidget" }))
    .results;
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /ExpoWidget memory milestone/);
  assert.deepEqual(
    hits[0].sourceIds,
    events.map((event) => `event:${event.eventId}`).sort(),
  );
  assert.ok(hits[0].observationId.startsWith("memobs:"));
  f.reopen();
  context = await tools(f.host, workspaceId);
  hits = (await call(context, "memory_search", { query: "ExpoWidget" }))
    .results;
  assert.equal(hits.length, 1);
  assert.equal(await f.host.captureMemoryAfterTurn(workspaceId, "chat-1"), 0);
  f.writer.noteDeletion(`event:${events[1].eventId}`);
  assert.deepEqual(
    (await call(context, "memory_search", { query: "ExpoWidget" })).results,
    [],
  );
});

test("workspace providers isolate code caches and memory projections", async (t) => {
  const f = fixture(t);
  const a = f.workspace("first");
  const b = f.workspace("second");
  writeFileSync(
    join(a.root, "a.ts"),
    "export const firstWorkspaceSymbol = 1;\n",
  );
  writeFileSync(
    join(b.root, "b.ts"),
    "export const secondWorkspaceSymbol = 1;\n",
  );
  commit(
    f.writer,
    turn("only-a", "a.ts", "firstWorkspaceMemory", a.workspaceId, "chat-a"),
    a.workspaceId,
    "chat-a",
  );
  await f.host.captureMemoryAfterTurn(a.workspaceId, "chat-a");
  const [indexA, indexB] = await Promise.all([
    f.host.codeIndexFor(a.workspaceId),
    f.host.codeIndexFor(b.workspaceId),
  ]);
  assert.notEqual(indexA.cacheFile, indexB.cacheFile);
  const [memoryA, sameA, memoryB] = await Promise.all([
    f.host.memoryFor(a.workspaceId),
    f.host.memoryFor(a.workspaceId),
    f.host.memoryFor(b.workspaceId),
  ]);
  assert.equal(memoryA, sameA);
  assert.notEqual(memoryA, memoryB);
  const context = await tools(f.host, b.workspaceId);
  assert.deepEqual(
    (await call(context, "code_search", { query: '"firstWorkspaceSymbol"' }))
      .results,
    [],
  );
  assert.deepEqual(
    (await call(context, "memory_search", { query: "firstWorkspaceMemory" }))
      .results,
    [],
  );
});

test("a failed lazy index build can recover without reopening the host", async (t) => {
  const f = fixture(t);
  const { root, workspaceId } = f.workspace();
  mkdirSync(join(root, ".gitignore"));
  await assert.rejects(f.host.codeIndexFor(workspaceId));
  rmSync(join(root, ".gitignore"), { recursive: true });
  writeFileSync(
    join(root, "recovered.ts"),
    "export const recoveredSymbol = 1;\n",
  );
  const context = await tools(f.host, workspaceId);
  assert.ok(
    (
      await call(context, "code_search", { query: "recoveredSymbol" })
    ).results.some((hit) => hit.path === "recovered.ts"),
  );
});

test("cached providers reject a replaced or revoked admitted directory", async (t) => {
  const f = fixture(t);
  const { root, workspaceId } = f.workspace();
  await f.host.codeIndexFor(workspaceId);
  await f.host.memoryFor(workspaceId);
  renameSync(root, `${root}-old`);
  mkdirSync(root);
  for (const method of ["codeIndexFor", "memoryFor", "codeToolsFor"])
    await assert.rejects(
      f.host[method](workspaceId),
      code("NATIVE_WORKSPACE_CHANGED"),
    );
  rmSync(root, { recursive: true });
  renameSync(`${root}-old`, root);
  f.writer.noteDeletion(`${workspaceId}.admitted`);
  await assert.rejects(
    f.host.codeIndexFor(workspaceId),
    code("NATIVE_WORKSPACE_UNAVAILABLE"),
  );
  await assert.rejects(
    f.host.captureMemoryAfterTurn(workspaceId, "chat-1"),
    code("NATIVE_WORKSPACE_UNAVAILABLE"),
  );
});

test("shutdown drains lazy provider creation and closes memory before the authoritative store", async (t) => {
  const f = fixture(t);
  const { workspaceId } = f.workspace();
  const memory = await f.host.memoryFor(workspaceId);
  const pending = f.host.codeIndexFor(workspaceId);
  const result = assert.rejects(pending, code("NATIVE_CONTEXT_CLOSED"));
  assert.throws(() => f.host.close(), code("NATIVE_ASYNC_SHUTDOWN_REQUIRED"));
  await f.host.shutdown();
  await result;
  await assert.rejects(
    memory.query(workspaceId, "chat-1"),
    code("NATIVE_CONTEXT_CLOSED"),
  );
  await assert.rejects(
    f.host.memoryFor(workspaceId),
    code("NATIVE_CONTEXT_CLOSED"),
  );
  await assert.rejects(
    f.host.codeIndexFor(workspaceId),
    code("NATIVE_CONTEXT_CLOSED"),
  );
});
