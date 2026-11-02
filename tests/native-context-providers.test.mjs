import assert from "node:assert/strict";
import {
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
import { Store } from "../packages/splyce-pi/dist/store.js";

const records = JSON.parse(
  readFileSync(
    new URL("./fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
const caller = (sessionId) => ({
  sessionId,
  configRevision: "cfg-0",
  profileRevision: "profile1",
  policyRevision: "policy1",
  resolveReference: () => true,
});
function commit(store, scopeId, sessionId) {
  const recordId = `run-${scopeId}`;
  const base = {
    schemaVersion: 1,
    protocolVersion: 2,
    recordId,
    createdAt: "2026-10-27T00:00:00.000Z",
    sourceIds: [recordId],
    sessionId,
    scopeId,
    durable: true,
  };
  const events = [
    {
      ...base,
      eventId: "memory-intent",
      kind: "turn.tool_intent",
      payload: {
        runId: "r1",
        actionId: "action1",
        capabilityId: "fs.write",
        target: "workspace",
        argsSummary: "alpha.ts: Quasar milestone",
      },
    },
    {
      ...base,
      eventId: "memory-outcome",
      kind: "turn.tool_outcome",
      payload: { runId: "r1", actionId: "action1", status: "success" },
    },
  ];
  return store.commitEvents(
    [
      {
        kind: "run",
        record: { ...records.run, recordId, scopeId, workspaceId: scopeId },
      },
    ],
    events,
    caller(sessionId),
  ).events;
}
function fixture(t) {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "context-providers-")),
  );
  const data = join(root, "data");
  let host = createNativeHost(data);
  const writer = Store.open(join(data, "splyce", "store.db"));
  t.after(async () => {
    await host.shutdown();
    writer.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    data,
    writer,
    get host() {
      return host;
    },
    async reopen() {
      await host.shutdown();
      host = createNativeHost(data);
    },
    workspace(name) {
      const path = join(root, name);
      mkdirSync(path);
      const stat = statSync(path, { bigint: true });
      const { workspaceId } = host.admitWorkspace({
        canonicalPath: path,
        volumeSerial: String(stat.dev),
        fileId: String(stat.ino),
      });
      return { path, workspaceId };
    },
  };
}
test("memory facade denies foreign scopes for query and capture", async (t) => {
  const f = fixture(t);
  const a = f.workspace("a");
  const b = f.workspace("b");
  commit(f.writer, b.workspaceId, "chat-b");
  await f.host.captureMemoryAfterTurn(b.workspaceId, "chat-b");
  const memory = await f.host.memoryFor(a.workspaceId);
  await assert.rejects(
    Promise.resolve().then(() => memory.query(b.workspaceId, "Quasar")),
  );
  assert.throws(() => memory.capture(b.workspaceId, "chat-b"));
});

test("retained context handles reject use after workspace revocation and shutdown", async (t) => {
  const f = fixture(t);
  const a = f.workspace("a");
  writeFileSync(join(a.path, "alpha.ts"), "export const quasarSymbol = 42;\n");
  const memory = await f.host.memoryFor(a.workspaceId);
  const search = (await f.host.codeToolsFor(a.workspaceId)).find(
    (tool) => tool.name === "code_search",
  );
  assert.ok(search);
  const stat = statSync(a.path, { bigint: true });
  f.writer.admitWorkspace(
    {
      canonicalPath: a.path,
      volumeSerial: String(stat.dev),
      fileId: `${stat.ino}1`,
    },
    {
      sessionId: "native-workspace-admission",
      configRevision: "cfg-0",
      profileRevision: "cfg-0",
      policyRevision: "cfg-0",
    },
    { readmit: true },
  );
  await assert.rejects(
    Promise.resolve().then(() => memory.query(a.workspaceId, "Quasar")),
  );
  assert.throws(() => memory.capture(a.workspaceId, "chat-a"));
  await assert.rejects(
    Promise.resolve().then(() => search.execute({ query: "quasarSymbol" })),
  );
  await f.host.shutdown();
  await assert.rejects(
    Promise.resolve().then(() => memory.query(a.workspaceId, "Quasar")),
  );
  assert.throws(() => memory.capture(a.workspaceId, "chat-a"));
  await assert.rejects(
    Promise.resolve().then(() => search.execute({ query: "quasarSymbol" })),
  );
});

test("missing and replaced workspace roots deny cached and new provider requests", async (t) => {
  const f = fixture(t);
  const a = f.workspace("a");
  const search = (await f.host.codeToolsFor(a.workspaceId)).find(
    (tool) => tool.name === "code_search",
  );
  assert.ok(search);
  const memory = await f.host.memoryFor(a.workspaceId);
  renameSync(a.path, `${a.path}-old`);
  for (const method of ["codeIndexFor", "memoryFor"])
    await assert.rejects(f.host[method](a.workspaceId));
  await assert.rejects(
    Promise.resolve().then(() => search.execute({ query: "anything" })),
  );
  await assert.rejects(
    Promise.resolve().then(() => memory.query(a.workspaceId, "anything")),
  );
  mkdirSync(a.path);
  for (const method of ["codeIndexFor", "memoryFor"])
    await assert.rejects(f.host[method](a.workspaceId));
  await assert.rejects(f.host.captureMemoryAfterTurn(a.workspaceId, "chat-a"));
});

test("shutdown drains pending creation and rejects further context access", async (t) => {
  const f = fixture(t);
  const a = f.workspace("a");
  const pending = f.host.codeIndexFor(a.workspaceId);
  const denied = assert.rejects(pending);
  await f.host.shutdown();
  await denied;
  for (const method of ["codeIndexFor", "memoryFor"])
    await assert.rejects(f.host[method](a.workspaceId));
});
