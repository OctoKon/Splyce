// TD-24 / C5_dirty_snapshot — stale-verification tests.
// Immutable candidate/input manifest from dirty tracked/untracked fixture;
// unchanged HEAD with changed relevant bytes invalidates prior verifier;
// excluded output cannot hide verifier input; persistence is Store-backed
// (acknowledged artifact record + digest-verified content) and survives a
// process kill.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execSync, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Store } from "../../packages/splyce-pi/dist/store.js";
import {
  Snapshot,
  SnapshotError,
  createSnapshot,
  verifyStale,
} from "../../src/snapshots.ts";

const CHILD = fileURLToPath(
  new URL("./snapshots-kill-child.ts", import.meta.url),
);

const tmpRoot = mkdtempSync(join(tmpdir(), "td24-snapshots-"));
let counter = 0;
const freshDir = () => {
  counter += 1;
  const dir = join(tmpRoot, `t${String(counter)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const waitFor = (file: string, timeoutMs = 15000) => {
  const start = Date.now();
  while (!existsSync(file)) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timeout waiting ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
};

const killTree = (pid: number) => {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], {
    stdio: "ignore",
  });
  if (result.status !== 0)
    throw new Error(`taskkill failed for ${String(pid)}`);
};

test("createSnapshot builds an immutable manifest from dirty tracked+untracked files", () => {
  const dir = freshDir();
  // init git repo
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  // tracked file (committed)
  writeFileSync(join(dir, "tracked.ts"), "export const x = 1;");
  execSync("git add tracked.ts", { cwd: dir });
  execSync("git commit -q -m init", { cwd: dir });
  // modify tracked file (dirty)
  writeFileSync(join(dir, "tracked.ts"), "export const x = 2;");
  // untracked file
  writeFileSync(join(dir, "untracked.ts"), "export const y = 2;");

  const snap = createSnapshot(dir);
  assert.ok(snap instanceof Snapshot);
  // Manifest is frozen/immutable.
  assert.throws(() => {
    (snap as unknown as Record<string, unknown>).head = "tampered";
  });
  // Contains both tracked and untracked entries.
  assert.ok(snap.manifest.tracked.length >= 1);
  assert.ok(snap.manifest.untracked.length >= 1);
  // Each entry carries path + content hash.
  for (const entry of [...snap.manifest.tracked, ...snap.manifest.untracked]) {
    assert.equal(typeof entry.path, "string");
    assert.equal(typeof entry.sha256, "string");
    assert.equal(entry.sha256.length, 64);
  }
});

test("verifyStale: unchanged HEAD with changed relevant bytes invalidates prior verifier", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "relevant.ts"), "export const v = 1;");
  const snap = createSnapshot(dir);

  // Simulate: HEAD unchanged but relevant bytes changed.
  writeFileSync(join(dir, "relevant.ts"), "export const v = 2;");

  assert.throws(
    () => verifyStale(snap, dir),
    (err: unknown) =>
      err instanceof SnapshotError && err.code === "STALE_RELEVANT_BYTES",
  );
});

test("verifyStale: matching bytes pass verification", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "relevant.ts"), "export const v = 1;");
  const snap = createSnapshot(dir);

  // No changes -> not stale.
  assert.doesNotThrow(() => verifyStale(snap, dir));
});

test("verifyStale: excluded output cannot hide verifier input", () => {
  const dir = freshDir();
  writeFileSync(join(dir, "input.ts"), "export const i = 1;");
  writeFileSync(join(dir, "output.log"), "generated noise");
  const snap = createSnapshot(dir, { exclude: ["*.log"] });

  // Mutate an excluded output file -> should NOT affect staleness.
  writeFileSync(join(dir, "output.log"), "different noise");
  assert.doesNotThrow(() => verifyStale(snap, dir));

  // Mutate a non-excluded input file -> stale.
  writeFileSync(join(dir, "input.ts"), "export const i = 2;");
  assert.throws(
    () => verifyStale(snap, dir),
    (err: unknown) =>
      err instanceof SnapshotError && err.code === "STALE_RELEVANT_BYTES",
  );
});

test("persist writes an acknowledged store record, not process memory", () => {
  const dir = freshDir();
  const source = join(dir, "fixture");
  mkdirSync(source);
  writeFileSync(join(source, "tracked.ts"), "export const x = 1;");
  const store = Store.open(join(dir, "store.db"));
  const snap = createSnapshot(source);
  const persisted = snap.persist(store);
  assert.equal(typeof persisted.seq, "number");
  assert.equal(typeof persisted.recordId, "string");

  // The record is a real, readable row in the store.
  const stored = store.get(persisted.recordId);
  assert.equal(stored.kind, "artifact");
  const record = stored.record as Record<string, unknown>;
  assert.equal(record.digest, persisted.digest);
  assert.equal(
    record.mediaType,
    "application/vnd.splyce.snapshot-manifest+json",
  );
  assert.equal(typeof record.byteLength, "number");

  const loaded = Snapshot.load(store, persisted.recordId);
  assert.deepEqual(loaded.manifest, snap.manifest);
  assert.equal(loaded.recordId, persisted.recordId);
  assert.equal(loaded.seq, persisted.seq);
  store.close();
});

test("a persisted snapshot reloads in a fresh process after a kill", () => {
  const dir = freshDir();
  const source = join(dir, "fixture");
  mkdirSync(source);
  writeFileSync(join(source, "relevant.ts"), "export const v = 1;");

  const child = spawn(process.execPath, [CHILD, dir], { stdio: "ignore" });
  const ackPath = join(dir, "ack.json");
  waitFor(ackPath);
  const ack = JSON.parse(readFileSync(ackPath, "utf8")) as {
    seq: number;
    recordId: string;
    digest: string;
    manifest: Snapshot["manifest"];
  };
  // Kill after the store acknowledged the commit.
  killTree(child.pid as number);

  // A different process, a brand-new connection: the manifest must come back
  // from the store and its content file, not from any in-process cache.
  const store = Store.open(join(dir, "store.db"));
  const loaded = Snapshot.load(store, ack.recordId);
  assert.deepEqual(loaded.manifest, ack.manifest);
  assert.equal(loaded.seq, ack.seq);
  assert.equal(loaded.recordId, ack.recordId);
  assert.deepEqual(
    loaded.manifest,
    createSnapshot(source).manifest,
    "the reloaded manifest still describes the unchanged fixture",
  );
  store.close();
});

test("tampered snapshot content fails closed with DIGEST_MISMATCH", () => {
  const dir = freshDir();
  const source = join(dir, "fixture");
  mkdirSync(source);
  writeFileSync(join(source, "relevant.ts"), "export const v = 1;");
  const store = Store.open(join(dir, "store.db"));
  const snap = createSnapshot(source);
  const persisted = snap.persist(store);

  const content = join(dir, "snapshots", `${persisted.recordId}.json`);
  // reading throws if the content file was not written beside the store
  JSON.parse(readFileSync(content, "utf8"));
  writeFileSync(
    content,
    JSON.stringify({ ...snap.manifest, excluded: ["*.ts"] }),
  );

  assert.throws(
    () => Snapshot.load(store, persisted.recordId),
    (err: unknown) =>
      err instanceof SnapshotError && err.code === "DIGEST_MISMATCH",
    "edited content must not be accepted as the acknowledged manifest",
  );
  store.close();
});

test("missing snapshot content fails closed with CONTENT_MISSING", () => {
  const dir = freshDir();
  const source = join(dir, "fixture");
  mkdirSync(source);
  writeFileSync(join(source, "relevant.ts"), "export const v = 1;");
  const store = Store.open(join(dir, "store.db"));
  const persisted = createSnapshot(source).persist(store);

  rmSync(join(dir, "snapshots", `${persisted.recordId}.json`));
  assert.throws(
    () => Snapshot.load(store, persisted.recordId),
    (err: unknown) =>
      err instanceof SnapshotError && err.code === "CONTENT_MISSING",
  );
  store.close();
});

test("unknown or non-snapshot records fail closed", () => {
  const dir = freshDir();
  const source = join(dir, "fixture");
  mkdirSync(source);
  writeFileSync(join(source, "relevant.ts"), "export const v = 1;");
  const store = Store.open(join(dir, "store.db"));

  assert.throws(
    () => Snapshot.load(store, "snap-does-not-exist"),
    (err: unknown) => err instanceof SnapshotError && err.code === "NOT_FOUND",
  );
  store.close();
});

test("createSnapshot rejects empty directory", () => {
  const dir = freshDir();
  assert.throws(
    () => createSnapshot(dir),
    (err: unknown) =>
      err instanceof SnapshotError && err.code === "EMPTY_SNAPSHOT",
  );
});

// Links: never followed. Skip a case only if the OS refuses to create the link.
const mkLink = (
  t: { skip: (m: string) => void },
  target: string,
  path: string,
) => {
  try {
    symlinkSync(target, path, "junction");
  } catch (error) {
    t.skip(`OS refused to create link: ${(error as Error).message}`);
    return false;
  }
  return true;
};

const outsideFixture = () => {
  const base = freshDir();
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside bytes");
  writeFileSync(join(root, "a.ts"), "export const a = 1;");
  return { root, outside };
};

test("a junction to a directory outside the root is a link; outside content is not hashed", (t) => {
  const { root, outside } = outsideFixture();
  if (!mkLink(t, outside, join(root, "escape"))) return;
  const snap = createSnapshot(root);
  const all = [...snap.manifest.tracked, ...snap.manifest.untracked];
  assert.deepEqual(
    all.map((e) => e.path),
    ["a.ts"],
  );
  assert.equal(snap.manifest.links?.length, 1);
  assert.equal(snap.manifest.links?.[0]?.path, "escape");
  // outside content changing is not a change to the snapshot
  writeFileSync(join(outside, "secret.txt"), "changed");
  assert.doesNotThrow(() => verifyStale(snap, root));
});

test("a link cycle terminates and is recorded as a link", (t) => {
  const { root } = outsideFixture();
  mkdirSync(join(root, "d"));
  if (!mkLink(t, root, join(root, "d", "loop"))) return;
  const snap = createSnapshot(root);
  assert.deepEqual(
    snap.manifest.links?.map((l) => l.path),
    ["d/loop"],
  );
  assert.doesNotThrow(() => verifyStale(snap, root));
});

test("a link inside the root is recorded, not descended into", (t) => {
  const { root } = outsideFixture();
  mkdirSync(join(root, "real"));
  writeFileSync(join(root, "real", "x.ts"), "x");
  if (!mkLink(t, join(root, "real"), join(root, "alias"))) return;
  const snap = createSnapshot(root);
  const paths = snap.manifest.tracked.map((e) => e.path).sort();
  assert.deepEqual(paths, ["a.ts", "real/x.ts"]);
  assert.deepEqual(
    snap.manifest.links?.map((l) => l.path),
    ["alias"],
  );
});

test("verifyStale: retargeting, adding or removing a link after capture is stale", (t) => {
  const { root, outside } = outsideFixture();
  const other = join(root, "..", "other");
  mkdirSync(other);
  if (!mkLink(t, outside, join(root, "escape"))) return;
  const snap = createSnapshot(root);
  const stale = (err: unknown) =>
    err instanceof SnapshotError && err.code === "STALE_RELEVANT_BYTES";

  rmSync(join(root, "escape"), { recursive: true });
  assert.throws(() => verifyStale(snap, root), stale); // removed
  symlinkSync(other, join(root, "escape"), "junction");
  assert.throws(() => verifyStale(snap, root), stale); // retargeted
  rmSync(join(root, "escape"), { recursive: true });
  symlinkSync(outside, join(root, "escape"), "junction");
  symlinkSync(other, join(root, "extra"), "junction");
  assert.throws(() => verifyStale(snap, root), stale); // added
});
