import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Store } from "../packages/splyce-pi/dist/store.js";
import { Snapshot } from "../src/snapshots.ts";
import { NativeControl } from "../packages/splyce-pi/src/native-control.mjs";
import { captureNativeSnapshot } from "../packages/splyce-pi/src/native-snapshots.mjs";

test("private control persists and verifies its snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-snapshot-"));
  const store = Store.open(join(root, "store.db"));
  try {
    const manifest = {
      tracked: [{ path: "file.txt", sha256: "a".repeat(64) }],
      untracked: [],
      links: [],
      excluded: ["b".repeat(64)],
    };
    const control = new NativeControl((frame) => {
      assert.equal(frame.native.method, "inventory.capture");
      control.accept({
        native: { id: frame.native.id, ok: true, value: { manifest } },
      });
    });
    const caller = {
      sessionId: "session",
      configRevision: "cfg",
      profileRevision: "profile",
      policyRevision: "policy",
    };
    const result = await captureNativeSnapshot({
      store,
      workspace: {
        workspaceId: "workspace",
        canonicalPath: root,
        volumeSerial: "1",
        fileId: "1",
      },
      caller,
      assertCurrent() {},
      control,
    });
    assert.equal(result.digest, result.baseRevision);
    assert.equal(store.get(result.recordId).record.scopeId, "workspace");
    assert.deepEqual(Snapshot.load(store, result.recordId).manifest, manifest);
    writeFileSync(join(root, "snapshots", `${result.recordId}.json`), "{}");
    assert.throws(() => Snapshot.load(store, result.recordId), {
      code: "DIGEST_MISMATCH",
    });
    control.shutdown();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
