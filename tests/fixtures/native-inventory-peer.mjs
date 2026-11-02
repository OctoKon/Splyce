import { Store } from "../../packages/splyce-pi/dist/store.js";
import { NativeControl } from "../../packages/splyce-pi/src/native-control.mjs";
import { captureNativeSnapshot } from "../../packages/splyce-pi/src/native-snapshots.mjs";
import {
  encodeFrame,
  readFrames,
} from "../../packages/splyce-pi/src/engine-host.mjs";
import { Snapshot } from "../../src/snapshots.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [root, db, volumeSerial, fileId] = process.argv.slice(2);
const store = Store.open(join(db, "store.db"));
const control = new NativeControl((frame) =>
  process.stdout.write(encodeFrame(frame)),
);
const response = (async () => {
  for await (const frame of readFrames(process.stdin)) {
    control.accept(frame);
    return;
  }
  throw new Error("missing reply");
})();
try {
  const result = await captureNativeSnapshot({
    store,
    workspace: {
      workspaceId: "ws-fixture",
      canonicalPath: root,
      volumeSerial,
      fileId,
    },
    caller: {
      sessionId: "fixture",
      configRevision: "cfg",
      profileRevision: "profile",
      policyRevision: "policy",
    },
    assertCurrent() {},
    control,
  });
  await response;
  const manifest = Snapshot.load(store, result.recordId).manifest;
  const pathHash = createHash("sha256").update(".env").digest("hex");
  process.stdout.write(
    encodeFrame({
      ok:
        store.get(result.recordId).record.scopeId === "ws-fixture" &&
        result.baseRevision === result.digest &&
        manifest.tracked.length === 1 &&
        manifest.tracked[0].path === "ordinary.txt" &&
        manifest.tracked[0].sha256 ===
          createHash("sha256").update("ordinary").digest("hex") &&
        manifest.excluded.length === 1 &&
        manifest.excluded[0] === pathHash,
    }),
  );
} finally {
  control.shutdown();
  store.close();
  process.stdin.destroy();
}
