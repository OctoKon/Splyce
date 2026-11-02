import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSplyceOwner } from "../vendor/pi/packages/agent/dist/splyce-readiness.js";
import {
  exportSessionToJsonl,
  serializeSessionBranch,
} from "../vendor/pi/packages/coding-agent/dist/core/session-export.js";
import { exportSessionToHtml } from "../vendor/pi/packages/coding-agent/dist/core/export-html/index.js";
import { AgentSessionRuntime } from "../vendor/pi/packages/coding-agent/dist/core/agent-session-runtime.js";
import { reportBug } from "../vendor/pi/packages/coding-agent/dist/modes/interactive/bug-report.js";

const sentinel = "fixture-private-sentinel-4827";
const forms = [
  sentinel,
  Buffer.from(sentinel).toString("base64"),
  Buffer.from(sentinel).toString("hex"),
];
const unavailable = (error) => error?.code === "PERSIST_REDACTION_UNAVAILABLE";
const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const scrub = (text) =>
  forms.reduce((safe, value) => safe.replaceAll(value, "[redacted]"), text);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "splyce-persist-"));
  t.after(() => {
    assert.equal(dir.startsWith(join(tmpdir(), "splyce-persist-")), true);
    rmSync(dir, { recursive: true, force: true });
  });
  let current = true;
  let sanitizer = async (text) => scrub(text);
  const owner = createSplyceOwner(() => {
    if (!current) throw new Error("stale fixture");
  });
  return {
    dir,
    owner,
    bind: (manager) =>
      owner.bindPersistence(manager, (text, signal) => sanitizer(text, signal)),
    sanitize: (callback) => {
      sanitizer = callback;
    },
    revoke: () => {
      current = false;
    },
  };
}
function safe(manager) {
  const memory = JSON.stringify(manager.getEntries());
  for (const value of forms) assert.equal(memory.includes(value), false);
  const file = manager.getSessionFile();
  if (file && existsSync(file)) {
    const text = readFileSync(file, "utf8");
    for (const value of forms) assert.equal(text.includes(value), false);
    for (const row of text.trim().split("\n")) JSON.parse(row);
    return text;
  }
  return undefined;
}

test("owned initialization fails before creating directories or exposing an unsealed manager", async (t) => {
  const f = fixture(t);
  const target = join(f.dir, "not-created");
  await assert.rejects(
    SessionManager.createOwned(f.dir, () => {}, target),
    unavailable,
  );
  assert.equal(existsSync(target), false);
  f.sanitize(async () => {
    throw new Error(sentinel);
  });
  await assert.rejects(
    SessionManager.createOwned(f.dir, f.bind, target),
    unavailable,
  );
  assert.equal(existsSync(target), false);
});

test("first flush awaits the complete sanitized header/history and publishes detached safe state", async (t) => {
  const f = fixture(t);
  const manager = await SessionManager.createOwned(f.dir, f.bind, f.dir);
  await manager.withPersistence((stage) =>
    stage.appendCustomEntry("setup", { text: sentinel }),
  );
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.sanitize((text) => {
    entered();
    return new Promise((resolve) => {
      release = () => resolve(scrub(text));
    });
  });
  const message = user(forms.join(" "));
  let captured;
  const before = JSON.stringify(manager.getEntries());
  const pending = manager.withPersistence((stage) => {
    captured = stage;
    return stage.appendMessage(message);
  });
  await started;
  assert.equal(existsSync(manager.getSessionFile()), false);
  assert.equal(JSON.stringify(manager.getEntries()), before);
  assert.throws(() => captured.appendMessage(user("late")));
  message.content = "caller mutation while sanitation is pending";
  // A string entry ID needs another result check in implementations which sanitize returned data.
  f.sanitize(async (text) => scrub(text));
  release();
  const id = await pending;
  assert.equal(typeof id, "string");
  const text = safe(manager);
  assert.equal(text.includes("caller mutation"), false);
  assert.equal(text.includes('"type":"session"'), true);
  assert.equal(text.includes('"customType":"setup"'), true);
  assert.equal(text.includes("[redacted]"), true);
});

test("lane failure, malformed JSON and revocation preserve existing bytes/state; queue recovers", async (t) => {
  const f = fixture(t);
  const manager = await SessionManager.createOwned(f.dir, f.bind, f.dir);
  await manager.withPersistence((stage) =>
    stage.appendMessage(user("baseline")),
  );
  const before = safe(manager);
  const state = JSON.stringify(manager.getEntries());
  for (const reject of [
    async () => {
      throw new Error(sentinel);
    },
    async () => "malformed",
    async () => "{}\n",
  ]) {
    f.sanitize(reject);
    await assert.rejects(
      manager.withPersistence((stage) => stage.appendMessage(user(sentinel))),
      unavailable,
    );
    assert.equal(readFileSync(manager.getSessionFile(), "utf8"), before);
    assert.equal(JSON.stringify(manager.getEntries()), state);
  }
  f.sanitize(async (text) => scrub(text));
  await manager.withPersistence((stage) =>
    stage.appendMessage(user("recovered")),
  );
  safe(manager);
  f.sanitize(async (text) => {
    f.revoke();
    return scrub(text);
  });
  const recovered = readFileSync(manager.getSessionFile(), "utf8");
  await assert.rejects(
    manager.withPersistence((stage) => stage.appendMessage(user(sentinel))),
    unavailable,
  );
  assert.equal(readFileSync(manager.getSessionFile(), "utf8"), recovered);
});

test("tool/custom/compaction/branch rewrites all pass through the same sanitation boundary", async (t) => {
  const f = fixture(t);
  const manager = await SessionManager.createOwned(f.dir, f.bind, f.dir);
  const first = await manager.withPersistence((stage) =>
    stage.appendMessage(user("start")),
  );
  await manager.withPersistence((stage) => {
    stage.appendMessage({
      role: "toolResult",
      toolCallId: "tool",
      toolName: "fixture",
      content: [{ type: "text", text: sentinel }],
      isError: false,
      timestamp: 2,
    });
    stage.appendCustomEntry("fixture", { raw: forms });
    stage.appendCompaction(sentinel, first, 12);
    stage.branchWithSummary(first, sentinel);
    stage.appendSessionInfo(sentinel);
  });
  safe(manager);
  const fork = await manager.withPersistence((stage) =>
    stage.createBranchedSession(first),
  );
  assert.equal(typeof fork, "string");
  safe(manager);
});

test("owned synchronous methods and async stage callbacks cannot change file or memory", async (t) => {
  const f = fixture(t);
  const manager = await SessionManager.createOwned(f.dir, f.bind, f.dir);
  await manager.withPersistence((stage) =>
    stage.appendMessage(user("baseline")),
  );
  const before = safe(manager);
  const state = JSON.stringify(manager.getEntries());
  for (const mutate of [
    () => manager.appendMessage(user(sentinel)),
    () => manager.newSession(),
    () => manager.setSessionFile(join(f.dir, "other.jsonl")),
    () => manager.branch(null),
    () => manager._persist(manager.getEntries()[0]),
  ]) {
    assert.throws(mutate, unavailable);
    assert.equal(JSON.stringify(manager.getEntries()), state);
    assert.equal(readFileSync(manager.getSessionFile(), "utf8"), before);
  }
  await assert.rejects(
    manager.withPersistence(async (stage) => {
      stage.appendMessage(user(sentinel));
    }),
    unavailable,
  );
  assert.equal(readFileSync(manager.getSessionFile(), "utf8"), before);
});

test("owned open repairs/migrates only after sanitation, with failure leaving bytes untouched", async (t) => {
  const f = fixture(t);
  const path = join(f.dir, "existing.jsonl");
  const original =
    JSON.stringify({
      type: "session",
      version: 3,
      id: "existing",
      timestamp: "2026-10-28T00:00:00.000Z",
      cwd: f.dir,
    }) +
    "\n" +
    JSON.stringify({
      type: "custom",
      id: "row",
      parentId: null,
      timestamp: "2026-10-28T00:00:00.000Z",
      customType: "fixture",
      data: sentinel,
    });
  writeFileSync(path, original);
  f.sanitize(async () => {
    throw new Error(sentinel);
  });
  await assert.rejects(
    SessionManager.openOwned(path, f.bind, f.dir),
    unavailable,
  );
  assert.equal(readFileSync(path, "utf8"), original);
  f.sanitize(async (text) => scrub(text));
  const manager = await SessionManager.openOwned(path, f.bind, f.dir);
  const text = safe(manager);
  assert.equal(text.endsWith("\n"), true);
  assert.equal(readdirSync(f.dir).length, 1);
});

test("unqualified native exports reject both owned managers and staged aliases before mkdir or write", async (t) => {
  const f = fixture(t);
  const manager = await SessionManager.createOwned(f.dir, f.bind, f.dir);
  const target = join(f.dir, "export-denied", "session.jsonl");
  assert.throws(() => serializeSessionBranch(manager), unavailable);
  assert.throws(() => exportSessionToJsonl(manager, target), unavailable);
  await assert.rejects(
    exportSessionToHtml(manager, undefined, { outputPath: target }),
    unavailable,
  );
  await manager.withPersistence((stage) => {
    assert.throws(() => serializeSessionBranch(stage), unavailable);
    assert.throws(() => exportSessionToJsonl(stage, target), unavailable);
  });
  assert.equal(existsSync(join(f.dir, "export-denied")), false);
});

test("native runtime replacement/import routes deny before repair/copy/new directories", async (t) => {
  const f = fixture(t);
  const manager = await SessionManager.createOwned(f.dir, f.bind, f.dir);
  const runtime = new AgentSessionRuntime(
    { sessionManager: manager },
    {},
    async () => {
      throw new Error("unexpected factory");
    },
  );
  const target = join(f.dir, "missing.jsonl");
  for (const run of [
    () => runtime.switchSession(target),
    () => runtime.newSession(),
    () => runtime.fork("missing"),
    () => runtime.importFromJsonl(target),
  ])
    await assert.rejects(run(), unavailable);
  assert.deepEqual(readdirSync(f.dir), []);
});

test("unqualified native diagnostic export denies before asking the terminal or creating a bundle", async (t) => {
  const f = fixture(t);
  const manager = await SessionManager.createOwned(f.dir, f.bind, f.dir);
  await assert.rejects(
    reportBug({ session: { sessionManager: manager } }),
    unavailable,
  );
  assert.deepEqual(readdirSync(f.dir), []);
});
