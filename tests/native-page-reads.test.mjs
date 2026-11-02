import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";
import { encodeFrame } from "../packages/splyce-pi/src/engine-host.mjs";
import { caller, commit, turn } from "./integration/memory-fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const records = JSON.parse(
  readFileSync(
    new URL("./fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
function fixture(t) {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "splyce-page-reads-")),
  );
  const data = join(directory, "data");
  let host = createNativeHost(data);
  const writer = Store.open(join(data, "splyce", "store.db"));
  t.after(async () => {
    await host.shutdown();
    writer.close();
    assert.equal(
      dirname(resolve(directory)).toLowerCase(),
      realpathSync
        .native(tmpdir())
        .toLowerCase()
        .replace(/[\\/]$/u, ""),
    );
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
      const path = join(directory, name);
      mkdirSync(path);
      const stat = statSync(path, { bigint: true });
      return host.admitWorkspace({
        canonicalPath: path,
        volumeSerial: String(stat.dev),
        fileId: String(stat.ino),
      }).workspaceId;
    },
  };
}
const read = (f, op, workspaceId, extra = {}) =>
  f.host.readPage(op, { requestId: "read-1", workspaceId, ...extra });
function append(f, kind, workspaceId, fields = {}) {
  const record = {
    ...records[kind],
    scopeId: workspaceId,
    sourceIds: [],
    ...fields,
  };
  if (kind === "run") record.workspaceId = workspaceId;
  f.writer.append({ kind, record }, caller());
  return record.recordId;
}

test("session and usage reads fold real Store state, survive reopen, and never revive deleted latest records", async (t) => {
  const f = fixture(t);
  const workspaceId = f.workspace();
  assert.deepEqual(await read(f, "sessions.list", workspaceId), {
    sessions: [],
    truncated: false,
  });
  append(f, "branchAnchor", workspaceId);
  append(f, "run", workspaceId, {
    optionalNote: { path: "private-fixture", credentialRef: "private-fixture" },
  });
  let sessions = await read(f, "sessions.list", workspaceId);
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0].sessionId, "s1");
  assert.equal(sessions.sessions[0].state, "running");
  assert.equal(JSON.stringify(sessions).includes("private-fixture"), false);
  assert.deepEqual(await read(f, "usage.read", workspaceId), {
    semantics: "unavailable",
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    sessionCount: 1,
    runCount: 1,
  });
  f.reopen();
  assert.deepEqual(await read(f, "sessions.list", workspaceId), sessions);
  append(f, "run", workspaceId, {
    recordId: "run-finished",
    state: "completed",
    createdAt: "2026-10-28T00:00:00.000Z",
  });
  assert.equal(
    (await read(f, "sessions.list", workspaceId)).sessions[0].state,
    "completed",
  );
  f.writer.noteDeletion("run-finished");
  assert.equal(
    (await read(f, "sessions.list", workspaceId)).sessions[0].state,
    "idle",
  );
  assert.equal((await read(f, "usage.read", workspaceId)).runCount, 0);
  f.writer.noteDeletion("rec-anchor");
  assert.deepEqual(await read(f, "sessions.list", workspaceId), {
    sessions: [],
    truncated: false,
  });
});

test("session activity uses durable event time when terminal receipts retain the original creation date", async (t) => {
  const f = fixture(t);
  const workspaceId = f.workspace();
  append(f, "branchAnchor", workspaceId);
  append(f, "run", workspaceId);
  const event = {
    schemaVersion: 1,
    protocolVersion: 2,
    recordId: "rec-run",
    eventId: "terminal-time",
    createdAt: "2026-10-28T10:20:00.000Z",
    sourceIds: ["rec-run"],
    scopeId: workspaceId,
    sessionId: "s1",
    durable: true,
    kind: "turn.canceled",
    payload: { runId: "r1", cleanedUp: true },
  };
  f.writer.commitEvents(
    [
      {
        kind: "run",
        record: {
          ...records.run,
          recordId: "terminal-run",
          scopeId: workspaceId,
          workspaceId,
          sourceIds: [],
          state: "canceled",
        },
      },
    ],
    [event],
    caller(),
  );
  let session = (await read(f, "sessions.list", workspaceId)).sessions[0];
  assert.equal(session.createdAt, records.branchAnchor.createdAt);
  assert.equal(session.updatedAt, event.createdAt);
  assert.equal(session.state, "canceled");
  f.reopen();
  assert.deepEqual(
    (await read(f, "sessions.list", workspaceId)).sessions[0],
    session,
  );
});

test("memory reads use native projection, isolate scopes, omit claim text, and honor deletion after reopen", async (t) => {
  const f = fixture(t);
  const a = f.workspace();
  const b = f.workspace("other");
  assert.deepEqual(await read(f, "memory.list", a), {
    entries: [],
    truncated: false,
  });
  const events = commit(
    f.writer,
    turn("memory", "private-fixture.ts", "expoMemoryNeedle", a, "s1"),
    a,
    "s1",
  );
  assert.equal(await f.host.captureMemoryAfterTurn(a, "s1"), 1);
  const listed = await read(f, "memory.list", a);
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].sourceCount, 2);
  assert.deepEqual(
    await read(f, "memory.search", a, { query: "expoMemoryNeedle" }),
    listed,
  );
  assert.equal(JSON.stringify(listed).includes("private-fixture"), false);
  assert.deepEqual(await read(f, "memory.list", b), {
    entries: [],
    truncated: false,
  });
  assert.deepEqual(
    await read(f, "memory.search", b, { query: "expoMemoryNeedle" }),
    { entries: [], truncated: false },
  );
  f.reopen();
  assert.deepEqual(await read(f, "memory.list", a), listed);
  f.writer.noteDeletion(`event:${events[1].eventId}`);
  assert.deepEqual(await read(f, "memory.list", a), {
    entries: [],
    truncated: false,
  });
  assert.deepEqual(
    await read(f, "memory.search", a, { query: "expoMemoryNeedle" }),
    { entries: [], truncated: false },
  );
});

test("page limits are explicit and deleted memory cannot displace live rows", async (t) => {
  const f = fixture(t);
  const workspaceId = f.workspace();
  for (let i = 0; i < 101; i++)
    append(f, "branchAnchor", workspaceId, {
      recordId: `anchor-${i}`,
      branchAnchorId: `branch-${i}`,
      piSessionId: `session-${i}`,
    });
  const sessions = await read(f, "sessions.list", workspaceId);
  assert.equal(sessions.sessions.length, 100);
  assert.equal(sessions.truncated, true);
  assert.equal((await read(f, "usage.read", workspaceId)).sessionCount, 101);
  commit(
    f.writer,
    Array.from({ length: 101 }, (_, i) =>
      turn(`bounded-${i}`, "file.ts", "boundedMemoryNeedle", workspaceId, "s1"),
    ).flat(),
    workspaceId,
    "s1",
  );
  assert.equal(await f.host.captureMemoryAfterTurn(workspaceId, "s1"), 101);
  const memory = await read(f, "memory.list", workspaceId);
  assert.equal(memory.entries.length, 100);
  assert.equal(memory.truncated, true);
  const searched = await read(f, "memory.search", workspaceId, {
    query: "boundedMemoryNeedle",
  });
  assert.equal(searched.entries.length, 50);
  assert.equal(searched.truncated, true);
  f.writer.noteDeletion(memory.entries[0].observationId);
  const remaining = await read(f, "memory.list", workspaceId);
  assert.equal(remaining.entries.length, 100);
  assert.equal(remaining.truncated, false);
  assert.ok(
    remaining.entries.every(
      (row) => row.observationId !== memory.entries[0].observationId,
    ),
  );
});

test("invalid or unadmitted reads are typed failures, not empty lists, and recovery remains possible", async (t) => {
  const f = fixture(t);
  for (const op of [
    "sessions.list",
    "memory.list",
    "memory.search",
    "usage.read",
  ]) {
    const extra = op === "memory.search" ? { query: "project" } : {};
    await assert.rejects(read(f, op, "unknown", extra), {
      code: "PAGE_READ_UNAVAILABLE",
      message: "Page data unavailable",
    });
    await assert.rejects(
      read(f, op, "unknown", { ...extra, credentialRef: "private" }),
      { code: "PAGE_READ_INVALID" },
    );
  }
  assert.equal(existsSync(join(f.data, "splyce", "memory")), false);
  const workspaceId = f.workspace();
  await assert.rejects(read(f, "memory.search", workspaceId, { query: " " }), {
    code: "PAGE_READ_INVALID",
  });
  assert.deepEqual(await read(f, "memory.list", workspaceId), {
    entries: [],
    truncated: false,
  });
  f.host.close();
  await assert.rejects(read(f, "sessions.list", workspaceId), {
    code: "PAGE_READ_UNAVAILABLE",
  });
  f.reopen();
  assert.deepEqual(await read(f, "sessions.list", workspaceId), {
    sessions: [],
    truncated: false,
  });
});

for (const entry of [
  "packages/splyce-pi/src/engine-host.mjs",
  "apps/desktop/src-tauri/resources/engine/host.mjs",
]) {
  test(`framed native page reads: ${entry}`, async (t) => {
    const f = fixture(t);
    const workspaceId = f.workspace();
    append(f, "branchAnchor", workspaceId);
    commit(
      f.writer,
      turn(
        "framed",
        "private-fixture.ts",
        "framedMemoryNeedle",
        workspaceId,
        "s1",
      ),
      workspaceId,
      "s1",
    );
    await f.host.captureMemoryAfterTurn(workspaceId, "s1");
    f.host.close();
    const setup = (command, requestId, payload) => ({
      id: requestId,
      method: "send",
      params: {
        frame: "setup",
        command,
        requestId,
        payload: { requestId, workspaceId, ...payload },
      },
    });
    const requests = [
      {
        id: "native-bootstrap",
        method: "native.bootstrap",
        params: { appDataDir: f.data },
      },
      setup("sessions.list", "sessions"),
      setup("memory.list", "memory"),
      setup("memory.search", "search", { query: "framedMemoryNeedle" }),
      setup("usage.read", "usage"),
      setup("memory.list", "invalid", { credentialRef: "private-fixture" }),
      setup("sessions.list", "unknown", { workspaceId: "unknown" }),
      { id: "stop", method: "shutdown", params: {} },
    ];
    const result = spawnSync(
      join(root, "apps/desktop/src-tauri/resources/engine/node.exe"),
      [join(root, entry)],
      {
        cwd: f.directory,
        input: Buffer.concat(requests.map(encodeFrame)),
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr?.toString());
    const replies = [];
    for (let offset = 0; offset < result.stdout.length;) {
      const length = result.stdout.readUInt32BE(offset);
      offset += 4;
      replies.push(
        JSON.parse(result.stdout.subarray(offset, offset + length).toString()),
      );
      offset += length;
    }
    assert.deepEqual(
      replies.map((r) => r.id),
      requests.map((r) => r.id),
    );
    assert.equal(replies[1].value.sessions.length, 1);
    assert.equal(replies[2].value.entries.length, 1);
    assert.deepEqual(replies[3].value, replies[2].value);
    assert.equal(replies[4].value.runCount, 1);
    assert.equal(replies[5].error.code, "PAGE_READ_INVALID");
    assert.equal(replies[6].error.code, "PAGE_READ_UNAVAILABLE");
    assert.equal(JSON.stringify(replies).includes("private-fixture"), false);
  });
}
