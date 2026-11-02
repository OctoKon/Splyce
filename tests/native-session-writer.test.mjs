import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireNativeSessionWriter } from "../packages/splyce-pi/src/native-session-writer.mjs";

const moduleUrl = pathToFileURL(
  path.resolve("packages/splyce-pi/src/native-session-writer.mjs"),
).href;
const childScript = `import { acquireNativeSessionWriter } from ${JSON.stringify(moduleUrl)};
try { const lease = acquireNativeSessionWriter(process.argv[1]); console.log('owned'); if (process.argv[2] === 'hold') setInterval(() => lease.assertCurrent(), 1000); else lease.close(); } catch (e) { console.log(e.code); }`;
function child(file, mode) {
  const process = spawn(
    processExec,
    ["--input-type=module", "-e", childScript, file, mode],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const result = new Promise((resolve, reject) => {
    let output = "";
    process.stdout.on("data", (data) => {
      output += data;
      if (output.includes("\n")) resolve(output.trim());
    });
    process.on("error", reject);
    process.on("exit", (code) => {
      if (!output) reject(new Error(`child exited ${code}`));
    });
  });
  return { process, result };
}
const processExec = process.execPath;

test("writer lease serializes processes and survives holder death", async () => {
  const base = path.resolve("tests");
  const dir = mkdtempSync(path.join(base, "native-writer-test-"));
  let holder;
  let lease;
  try {
    const file = path.join(dir, "session.jsonl");
    const bytes = Buffer.from("original\n");
    writeFileSync(file, bytes);
    writeFileSync(path.join(dir, "unrelated"), "unchanged");
    lease = acquireNativeSessionWriter(file);
    lease.assertCurrent();
    assert.throws(() => acquireNativeSessionWriter(file).close(), {
      code: "NATIVE_SESSION_BUSY",
    });
    if (process.platform === "win32")
      assert.throws(
        () => acquireNativeSessionWriter(path.join(dir, "SESSION.JSONL")),
        { code: "NATIVE_SESSION_BUSY" },
      );
    assert.equal(await child(file, "once").result, "NATIVE_SESSION_BUSY");
    lease.close();
    lease.close();
    assert.throws(() => lease.assertCurrent(), {
      code: "NATIVE_SESSION_UNAVAILABLE",
    });
    holder = child(file, "hold");
    assert.equal(await holder.result, "owned");
    assert.equal(await child(file, "once").result, "NATIVE_SESSION_BUSY");
    const locks = readdirSync(dir).filter((name) => name.endsWith(".sqlite"));
    assert.equal(locks.length, 1);
    const exited = new Promise((resolve) =>
      holder.process.once("exit", resolve),
    );
    holder.process.kill();
    await exited;
    holder = undefined;
    assert.equal(await child(file, "once").result, "owned");
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith(".sqlite")),
      locks,
    );
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(
      readFileSync(path.join(dir, "unrelated"), "utf8"),
      "unchanged",
    );
    assert.throws(
      () =>
        acquireNativeSessionWriter(path.join(dir, "missing", "session.jsonl")),
      { code: "NATIVE_SESSION_UNAVAILABLE" },
    );
    if (process.platform !== "win32") {
      symlinkSync(file, path.join(dir, "alias"));
      assert.throws(() => acquireNativeSessionWriter(path.join(dir, "alias")), {
        code: "NATIVE_SESSION_UNAVAILABLE",
      });
    }
  } finally {
    lease?.close();
    if (holder) {
      const exited = new Promise((resolve) =>
        holder.process.once("exit", resolve),
      );
      holder.process.kill();
      await exited;
    }
    assert.equal(path.dirname(dir), base);
    assert.ok(path.basename(dir).startsWith("native-writer-test-"));
    rmSync(dir, { recursive: true, force: true });
  }
});
