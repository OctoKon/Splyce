// TD-25 / #137: the parent kills this owned fixture after its first uncommitted correction.
import { existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyRecovery } from "@splyce/pi/recovery-applier";
import { Store } from "../../packages/splyce-pi/dist/store.js";

const [databaseArgument, markerArgument] = process.argv.slice(2);
let store;
let markerPath;

function signal(value) {
  const temporary = `${markerPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), "utf8");
  renameSync(temporary, markerPath);
}

try {
  if (!databaseArgument || !markerArgument) {
    throw new Error("expected database and marker paths");
  }
  const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
  const temporaryRoot = realpathSync(join(workspaceRoot, ".test-tmp"));
  const databasePath = resolve(databaseArgument);
  const ownedDirectory = realpathSync(dirname(databasePath));
  const candidateMarker = resolve(markerArgument);
  if (
    dirname(ownedDirectory) !== temporaryRoot ||
    !basename(ownedDirectory).startsWith("td25-applier-") ||
    dirname(realpathSync(databasePath)) !== ownedDirectory ||
    realpathSync(dirname(candidateMarker)) !== ownedDirectory ||
    candidateMarker === databasePath ||
    !candidateMarker.endsWith(".json") ||
    existsSync(candidateMarker)
  ) {
    throw new Error("paths must be distinct files inside one owned fixture");
  }
  markerPath = candidateMarker;
  store = Store.open(databasePath);
  const caller = {
    sessionId: "s1",
    configRevision: "cfg-0",
    profileRevision: "profile1",
    policyRevision: "policy1",
    resolveReference(id, scopeId) {
      if (scopeId !== "w-demo") return false;
      if (["s1", "w-demo", "b1", "p1", "cap1"].includes(id)) return true;
      try {
        return store.get(id).record.scopeId === scopeId;
      } catch {
        return store
          .list(scopeId, 0, "s1")
          .records.some(
            ({ kind, record }) =>
              (kind === "run" && record.runId === id) ||
              (kind === "action" && record.actionId === id),
          );
      }
    },
  };
  const insertValidated = store.insertValidated.bind(store);
  // applyRecovery commits through one Store.appendBatch; the first corrected
  // row insert is the crash boundary.
  store.insertValidated = (kind, record, sessionId) => {
    const seq = insertValidated(kind, record, sessionId);
    signal({
      phase: "after-first-write",
      inTransaction: store.db.isTransaction,
      seq,
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error("the paused crash fixture unexpectedly resumed");
  };
  applyRecovery(store, {
    scopeId: "w-demo",
    caller,
    explicitRestart: true,
    writers: [
      {
        lease: {
          piSessionId: "s1",
          writerId: "writer1",
          leaseEpoch: "epoch1",
        },
        alive: false,
      },
    ],
  });
  signal({ phase: "unexpected-return" });
  process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (markerPath) signal({ phase: "error", message });
  else process.stderr.write(`${message}\n`);
  process.exitCode = 1;
} finally {
  store?.close();
}
