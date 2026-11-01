// TD-09 J0 helper process for S2 (forced kill) and S6 (second writer).
// Run by tests/integration/store.ts: node store-kill-child.ts <mode> <dir>
// Protocols are file-signal based; paths are inside <dir>.

import { Store } from "../../packages/splyce-pi/dist/store.js";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, dir] = process.argv.slice(2);
if (mode === undefined || dir === undefined) {
  console.error("usage: store-kill-child.ts <mode> <dir>");
  process.exit(2);
}
const dbPath = join(dir, "store.db");
const caller = {
  sessionId: "child",
  configRevision: "cfg1",
  profileRevision: "profile1",
  policyRevision: "policy1",
  resolveReference: () => true,
};

const record = (recordId: string) => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL("../fixtures/contracts/records.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const base = structuredClone(fixtures.run) as Record<string, unknown>;
  base.recordId = recordId;
  base.scopeId = "w-demo";
  return base;
};

if (mode === "commit-then-signal") {
  // S2 killed-after-ack: append (durable, synchronous=FULL), signal, sleep.
  const store = Store.open(dbPath);
  const appended = store.append(
    { kind: "run", record: record("rec-child-ack") },
    caller,
  );
  writeFileSync(join(dir, "ack.json"), JSON.stringify(appended), "utf8");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  process.exit(0);
}

if (mode === "mid-transaction") {
  // S2 killed-mid-tx: uncommitted batch is abandoned when the process dies.
  const store = Store.open(dbPath);
  const appended = store.append(
    { kind: "run", record: record("rec-child-open") },
    caller,
  );
  writeFileSync(join(dir, "open.json"), JSON.stringify(appended), "utf8");
  const raw = new DatabaseSync(dbPath, { timeout: 5000 });
  raw.exec("BEGIN IMMEDIATE;");
  raw
    .prepare(
      "INSERT INTO records (kind, record_id, schema_version, scope_id, session_id, created_at, payload) " +
        "VALUES ('run', 'rec-uncommitted', 1, 'w-demo', 'child', '2026-10-26T00:00:00.000Z', '{}')",
    )
    .run();
  writeFileSync(join(dir, "mid.json"), "{}", "utf8");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  process.exit(0);
}

if (mode === "busy-hold") {
  // S6 second writer: hold an IMMEDIATE transaction until released.
  const trace = (step: string) => {
    try {
      writeFileSync(join(dir, `child-trace-${step}.json`), "{}", "utf8");
    } catch {
      // diagnostics only
    }
  };
  try {
    trace("start");
    const raw = new DatabaseSync(dbPath, { timeout: 0 });
    trace("opened");
    raw.exec("PRAGMA journal_mode = WAL;");
    trace("wal");
    raw.exec("BEGIN IMMEDIATE;");
    trace("begun");
    raw
      .prepare(
        "INSERT INTO records (kind, record_id, schema_version, scope_id, session_id, created_at, payload) " +
          "VALUES ('run', 'rec-child-second', 1, 'w-demo', 'child', '2026-10-26T00:00:00.000Z', '{}')",
      )
      .run();
    trace("inserted");
    writeFileSync(join(dir, "held.json"), "{}", "utf8");
    trace("held");
    while (!existsSync(join(dir, "release.json"))) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    trace("released");
    raw.exec("COMMIT;");
    trace("committed");
    raw.close();
    process.exit(0);
  } catch (error) {
    writeFileSync(
      join(dir, "child-error.json"),
      JSON.stringify({
        message: String(error),
        errcode: (error as { errcode?: number }).errcode,
      }),
      "utf8",
    );
    process.exit(1);
  }
}

console.error(`unknown mode ${mode}`);
process.exit(2);
