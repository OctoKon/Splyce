// TD-51 C3_crash_matrix — crash/migration regression tests against the real
// Store: an acknowledged commit survives a hard kill, an uncommitted row does
// not survive one.
// Uses the existing store-kill-child harness (tests/integration/store-kill-child.ts).

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Store, StoreError } from "../../packages/splyce-pi/dist/store.js";

const CHILD = fileURLToPath(new URL("./store-kill-child.ts", import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), "td51-crash-"));
let n = 0;
const dir = () => {
  n += 1;
  const d = join(tmpRoot, `t${n}`);
  mkdirSync(d);
  return d;
};
const wait = (f: string, ms = 15000) => {
  const s = Date.now();
  while (!existsSync(f)) {
    if (Date.now() - s > ms) throw new Error(`timeout ${f}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
};
// Portable hard kill: no taskkill, so the case runs on POSIX runners too.
// SIGKILL is a TerminateProcess on Windows and unblockable elsewhere, which is
// exactly the crash under test — the child gets no cleanup path. The returned
// promise settles only after the OS reports the child gone, so its SQLite
// handles are released before the test reopens the database.
const kill = (child: ChildProcess): Promise<void> =>
  new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(
      () => reject(new Error("child did not exit after SIGKILL")),
      15000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill("SIGKILL");
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
const spawnChild = (mode: string, d: string) =>
  spawn(process.execPath, [CHILD, mode, d], { stdio: "ignore" });

test("CM1 kill-during-append: acknowledged commit survives kill", async () => {
  const d = dir();
  const child = spawnChild("commit-then-signal", d);
  wait(join(d, "ack.json"));
  const ack = JSON.parse(readFileSync(join(d, "ack.json"), "utf8")) as {
    seq: number;
  };
  await kill(child);
  const store = Store.open(join(d, "store.db"));
  const got = store.get("rec-child-ack");
  assert.equal(got.seq, ack.seq);
  store.close();
  rmSync(d, { recursive: true, force: true });
});

test("CM2 kill-mid-transaction: uncommitted row absent after reopen", async () => {
  const d = dir();
  const child = spawnChild("mid-transaction", d);
  wait(join(d, "mid.json"));
  await kill(child);
  const store = Store.open(join(d, "store.db"));
  // the acknowledged first append survives; only the open transaction is lost.
  assert.ok(store.get("rec-child-open"));
  assert.throws(
    () => store.get("rec-uncommitted"),
    (e: unknown) => e instanceof StoreError && e.code === "STORE_NOT_FOUND",
  );
  store.close();
  rmSync(d, { recursive: true, force: true });
});
