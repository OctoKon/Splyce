import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createNativeHost } from "../packages/splyce-pi/src/native-host.mjs";
import { Store } from "../packages/splyce-pi/dist/store.js";
import {
  encodeFrame,
  readFrames,
} from "../packages/splyce-pi/src/engine-host.mjs";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";

const sourceHost = fileURLToPath(
  new URL("../packages/splyce-pi/src/engine-host.mjs", import.meta.url),
);
const selection = {
  canonicalPath: "C:\\native-folder",
  volumeSerial: "4294967295",
  fileId: "18446744073709551615",
};
const bootstrap = (appDataDir) => ({
  id: "native-bootstrap",
  method: "native.bootstrap",
  params: { appDataDir },
});
const admit = (params) => ({
  id: "admit",
  method: "native.workspace.admit",
  params,
});
const shutdown = { id: "shutdown", method: "shutdown", params: {} };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "splyce-workspace-host-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function run(requests) {
  const result = spawnSync(process.execPath, [sourceHost], {
    input: Buffer.concat(requests.map(encodeFrame)),
    timeout: 15000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  const replies = [];
  for await (const frame of readFrames(Readable.from([result.stdout])))
    replies.push(frame);
  return { result, replies };
}
function assertNoGrants(host, path, workspaceId) {
  assert.deepEqual(host.current(workspaceId).grantIds, []);
  assert.ok(
    Object.values(host.handshakeReadiness.ports).every(
      (value) => value === false,
    ),
  );
  const store = Store.open(join(path, "splyce", "store.db"));
  try {
    assert.equal(store.getWorkspace(workspaceId).workspaceId, workspaceId);
    assert.equal(store.audit().recordCount, 1);
  } finally {
    store.close();
  }
}

test("actual source host privately admits, preserves u64, reopens, and denies renderer send", async (t) => {
  assert.equal(process.version, "v24.22.1");
  const directory = fixture(t);
  const { result, replies } = await run([
    bootstrap(directory),
    admit(selection),
    {
      id: "renderer",
      method: "send",
      params: { op: "native.workspace.admit", payload: selection },
    },
    shutdown,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stderr.length, 0);
  assert.equal(replies[1].ok, true);
  const view = replies[1].value;
  assert.deepEqual(Object.keys(view).sort(), [
    "admittedAt",
    "displayName",
    "revision",
    "workspaceId",
  ]);
  assert.equal(view.displayName, "native-folder");
  assert.equal(replies[2].error.code, "POLICY_DENIED");
  const host = createNativeHost(directory);
  try {
    const native = host.resolveWorkspace(view.workspaceId);
    assert.equal(native.canonicalPath, selection.canonicalPath);
    assert.equal(native.fileId, selection.fileId);
    assert.equal(native.volumeSerial, selection.volumeSerial);
    assert.deepEqual(host.admitWorkspace(selection), view);
    assertNoGrants(host, directory, view.workspaceId);
  } finally {
    host.close();
  }
  const reopened = await run([
    bootstrap(directory),
    admit(selection),
    shutdown,
  ]);
  assert.equal(reopened.result.status, 0);
  assert.deepEqual(reopened.replies[1].value, view);
});

test("private admission before trusted bootstrap cannot open Store", async (t) => {
  const directory = fixture(t);
  const { result, replies } = await run([admit(selection)]);
  assert.equal(result.status, 1);
  assert.deepEqual(replies, []);
});

for (const [name, input] of [
  ["UNC", { ...selection, canonicalPath: "\\\\host\\share" }],
  ["device", { ...selection, canonicalPath: "\\\\?\\C:\\project" }],
  ["relative", { ...selection, canonicalPath: "project" }],
  ["extra field", { ...selection, readmit: true }],
  ["invalid volume identity", { ...selection, volumeSerial: "4294967296" }],
  ["invalid file identity", { ...selection, fileId: "18446744073709551616" }],
  ["numeric identity", { ...selection, fileId: 42 }],
  ["malformed identity", { ...selection, fileId: "0x42" }],
]) {
  test(`private admission rejects ${name} without records or raw error disclosure`, async (t) => {
    const directory = fixture(t);
    const { result, replies } = await run([
      bootstrap(directory),
      admit(input),
      shutdown,
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(replies[1], {
      id: "admit",
      ok: false,
      error: {
        code: "POLICY_DENIED",
        message: "Workspace admission unavailable",
        correlationId: "admit",
        retryable: false,
      },
    });
    const store = Store.open(join(directory, "splyce", "store.db"));
    try {
      assert.equal(store.cursor(), 0);
    } finally {
      store.close();
    }
  });
}

test("native listing survives reopen and resolves only current nondeleted workspaces", (t) => {
  const directory = fixture(t);
  const host = createNativeHost(directory);
  const first = host.admitWorkspace(selection);
  assert.deepEqual(host.listWorkspaces(), [first]);
  const store = Store.open(join(directory, "splyce", "store.db"));
  const caller = {
    sessionId: "native-workspace-admission",
    configRevision: "cfg-0",
    profileRevision: "cfg-0",
    policyRevision: "cfg-0",
  };
  const changed = { ...selection, fileId: "42" };
  const current = store.admitWorkspace(changed, caller, { readmit: true });
  assert.equal(host.resolveWorkspace(first.workspaceId), undefined);
  assert.equal(host.resolveWorkspace(current.workspaceId).fileId, "42");
  const view = host.listWorkspaces()[0];
  assert.equal(view.workspaceId, current.workspaceId);
  assert.deepEqual(Object.keys(view).sort(), [
    "admittedAt",
    "displayName",
    "revision",
    "workspaceId",
  ]);
  host.close();
  const reopened = createNativeHost(directory);
  try {
    assert.deepEqual(reopened.listWorkspaces(), [view]);
    assert.equal(reopened.resolveWorkspace(first.workspaceId), undefined);
    store.noteDeletion(current.recordId);
    assert.deepEqual(reopened.listWorkspaces(), []);
    assert.equal(reopened.resolveWorkspace(current.workspaceId), undefined);
    assert.ok(
      store.getWorkspace(first.workspaceId),
      "superseded history retained",
    );
  } finally {
    reopened.close();
    store.close();
  }
  const deleted = createNativeHost(directory);
  try {
    assert.deepEqual(deleted.listWorkspaces(), []);
    assert.equal(deleted.resolveWorkspace(first.workspaceId), undefined);
    assert.equal(deleted.resolveWorkspace(current.workspaceId), undefined);
  } finally {
    deleted.close();
  }
});

test("unexpected SQLite admission fault shuts down actual source host without disclosing or deleting data", async (t) => {
  const directory = fixture(t);
  const host = createNativeHost(directory);
  const preserved = host.admitWorkspace(selection);
  host.close();
  const child = spawn(process.execPath, [sourceHost], {
    windowsHide: true,
    timeout: 15000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (data) => {
    stderr += data;
  });
  const replies = readFrames(child.stdout)[Symbol.asyncIterator]();
  child.stdin.write(encodeFrame(bootstrap(directory)));
  assert.equal((await replies.next()).value.ok, true);
  const database = new DatabaseSync(join(directory, "splyce", "store.db"));
  const before = database.prepare("SELECT * FROM records ORDER BY seq").all();
  database.exec(
    "CREATE TRIGGER admission_fault BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT, 'isolated-private-io-fault'); END",
  );
  child.stdin.write(
    encodeFrame(
      admit({ ...selection, canonicalPath: "C:\\other-native-folder" }),
    ),
  );
  const [status] = await closed;
  assert.equal(status, 1);
  assert.equal(stderr, "Engine bootstrap failed\n");
  assert.deepEqual(await replies.next(), { value: undefined, done: true });
  assert.deepEqual(
    database.prepare("SELECT * FROM records ORDER BY seq").all(),
    before,
  );
  database.exec("DROP TRIGGER admission_fault");
  database.close();
  const recovered = createNativeHost(directory);
  try {
    assert.deepEqual(recovered.listWorkspaces(), [preserved]);
    assert.equal(
      recovered.resolveWorkspace(preserved.workspaceId).fileId,
      selection.fileId,
    );
  } finally {
    recovered.close();
  }
});

test("identity change remains a bounded denial and preserves existing admission", async (t) => {
  const directory = fixture(t);
  const { result, replies } = await run([
    bootstrap(directory),
    admit(selection),
    admit({ ...selection, fileId: "42" }),
    shutdown,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(replies[1].ok, true);
  assert.equal(replies[2].ok, false);
  assert.equal(replies[2].error.code, "POLICY_DENIED");
  assert.equal(replies[3].value.state, "stopped");
  const host = createNativeHost(directory);
  try {
    assert.deepEqual(host.listWorkspaces(), [replies[1].value]);
    assert.equal(
      host.resolveWorkspace(replies[1].value.workspaceId).fileId,
      selection.fileId,
    );
  } finally {
    host.close();
  }
});
