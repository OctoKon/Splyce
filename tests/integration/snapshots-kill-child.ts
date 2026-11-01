// TD-24 helper process: persists a snapshot through the Store, reports the
// acknowledged record, then hangs so the parent test can kill it AFTER the
// store acknowledged the commit. The parent then reloads the manifest from a
// fresh Store connection in a different process, which a process-local cache
// could not satisfy.
//
// Run by tests/integration/snapshots.ts: node snapshots-kill-child.ts <dir>

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../packages/splyce-pi/dist/store.js";
import { createSnapshot } from "../../src/snapshots.ts";

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  console.error("usage: snapshots-kill-child.ts <dir>");
  process.exit(2);
}

const store = Store.open(join(dir, "store.db"));
const snapshot = createSnapshot(join(dir, "fixture"));
const ack = snapshot.persist(store);
writeFileSync(
  join(dir, "ack.json"),
  JSON.stringify({
    seq: ack.seq,
    recordId: ack.recordId,
    digest: ack.digest,
    manifest: snapshot.manifest,
  }),
  "utf8",
);

// Hang until the parent kills this process; the append is already durable.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
process.exit(0);
