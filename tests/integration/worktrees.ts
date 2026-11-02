// TD-70 / E1_worktrees — WorktreeManager on real temp git repos and dirs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  type ApplyAct,
  assertPatchConfined,
  MAX_WORKTREE_DIFF_BYTES,
  WorktreeManager,
} from "../../packages/splyce-index/dist/worktrees.js";

const tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "td70-wt-")));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const g = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
const write = (root: string, files: Record<string, string>) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
};
const read = (root: string, rel: string) =>
  readFileSync(join(root, rel), "utf8");

/** Real in-memory once-grant store: a grant is bound to one act and burns on use. */
class Grants {
  private readonly issued = new Map<string, ApplyAct>();
  private n = 0;
  issue(act: ApplyAct): string {
    const id = `g${String(++this.n)}`;
    this.issued.set(id, { ...act });
    return id;
  }
  readonly consume = (grantId: string, act: ApplyAct): void => {
    const bound = this.issued.get(grantId);
    if (!bound) throw new Error("GRANT_REQUIRED");
    if (
      bound.actionId !== act.actionId ||
      bound.argumentsDigest !== act.argumentsDigest
    )
      throw new Error("GRANT_MISMATCH");
    this.issued.delete(grantId);
  };
  get size() {
    return this.issued.size;
  }
}

let counter = 0;
function setup(
  files: Record<string, string>,
  opts: { git?: boolean; max?: number; live?: (id: string) => boolean } = {},
) {
  const base = join(tmpRoot, `t${String(++counter)}`);
  const ws = join(base, "ws");
  mkdirSync(ws, { recursive: true });
  write(ws, files);
  if (opts.git !== false) {
    g(ws, "init", "-q");
    // Byte-exact checkouts whatever the machine's global autocrlf is.
    g(ws, "config", "core.autocrlf", "false");
    g(ws, "add", "-A");
    g(ws, "commit", "-q", "-m", "init");
  }
  const cacheDir = join(base, "cache");
  const grants = new Grants();
  const workspaces = new Map([["w1", { canonicalPath: ws }]]);
  const make = (live = opts.live ?? (() => true)) =>
    new WorktreeManager({
      cacheDir,
      workspaces: { workspace: (id) => workspaces.get(id) },
      consumeGrant: grants.consume,
      isChildLive: live,
      maxPerWorkspace: opts.max ?? 4,
    });
  return { ws, cacheDir, grants, mgr: make(), make, workspaces };
}

const FILES = {
  "keep.txt": "keep\n",
  "edit.txt": "line1\nline2\n",
  "gone.txt": "bye\n",
  "src/deep/a.ts": "export const a = 1;\n",
};

/** Modified + added + deleted change set inside a worktree root. */
const change = (root: string) => {
  writeFileSync(join(root, "edit.txt"), "line1\nCHANGED\n");
  write(root, { "src/new.ts": "export const n = 2;\n" });
  rmSync(join(root, "gone.txt"));
};

test("create isolates: edits in the worktree never touch the parent", async () => {
  const { ws, cacheDir, mgr } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  assert.match(worktreeId, /^wt[0-9a-f]{16}$/);
  assert.ok(
    !relative(cacheDir, root).startsWith(".."),
    "root lives under cacheDir",
  );
  assert.ok(
    relative(ws, root).startsWith(".."),
    "root is outside the workspace",
  );
  assert.equal(read(root, "edit.txt"), "line1\nline2\n");
  change(root);
  assert.equal(read(ws, "edit.txt"), "line1\nline2\n");
  assert.ok(existsSync(join(ws, "gone.txt")));
  assert.ok(!existsSync(join(ws, "src/new.ts")));
  assert.equal(g(ws, "status", "--porcelain"), "");
  assert.deepEqual(
    mgr.list("w1").map((w) => [w.worktreeId, w.childId, w.mode]),
    [[worktreeId, "c1", "git"]],
  );
  assert.equal(mgr.list("w1")[0]!.baseRef, g(ws, "rev-parse", "HEAD").trim());
  assert.ok(!("root" in mgr.list("w1")[0]!), "list never exposes root");
});

test("create honours baseRef and rejects a bad one", async () => {
  const { ws, mgr } = setup(FILES);
  const first = g(ws, "rev-parse", "HEAD").trim();
  write(ws, { "edit.txt": "v2\n" });
  g(ws, "commit", "-q", "-am", "v2");
  const { root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
    baseRef: first,
  });
  assert.equal(read(root, "edit.txt"), "line1\nline2\n");
  const head = await mgr.create({ workspaceId: "w1", childId: "c2" });
  assert.equal(read(head.root, "edit.txt"), "v2\n");
  for (const baseRef of ["nope", "--upload-pack=x", "a b"])
    await assert.rejects(
      mgr.create({ workspaceId: "w1", childId: "c3", baseRef }),
      {
        code: "BASE_REF_INVALID",
      },
    );
  assert.equal(
    mgr.list("w1").length,
    2,
    "a failed create leaves nothing behind",
  );
});

test("diff lists modified, added (untracked) and deleted files workspace-relative", async () => {
  const { mgr } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  assert.deepEqual((await mgr.diff(worktreeId)).files, []);
  change(root);
  const d = await mgr.diff(worktreeId);
  assert.deepEqual(
    [...d.files].sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "edit.txt", status: "modified" },
      { path: "gone.txt", status: "deleted" },
      { path: "src/new.ts", status: "added" },
    ],
  );
  assert.match(d.patch, /\+CHANGED/);
  assert.match(d.patch, /export const n = 2/);
  assert.equal(d.actionId, `worktree.apply:${worktreeId}`);
  assert.match(d.argumentsDigest, /^[0-9a-f]{64}$/);
});

test("apply without, with an unknown, a mismatched or a spent grant is denied", async () => {
  const { ws, mgr, grants } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  change(root);
  const d = await mgr.diff(worktreeId);
  await assert.rejects(mgr.apply(worktreeId, {} as { grantId: string }), {
    code: "INVALID_ID",
  });
  await assert.rejects(mgr.apply(worktreeId, { grantId: "unknown" }), {
    code: "GRANT_DENIED",
  });
  const wrong = grants.issue({
    actionId: d.actionId,
    argumentsDigest: "0".repeat(64),
  });
  await assert.rejects(mgr.apply(worktreeId, { grantId: wrong }), {
    code: "GRANT_DENIED",
  });
  const other = grants.issue({
    actionId: "worktree.apply:wtother",
    argumentsDigest: d.argumentsDigest,
  });
  await assert.rejects(mgr.apply(worktreeId, { grantId: other }), {
    code: "GRANT_DENIED",
  });
  assert.equal(read(ws, "edit.txt"), "line1\nline2\n");
  assert.equal(
    g(ws, "status", "--porcelain"),
    "",
    "denied apply writes nothing",
  );
  const ok = grants.issue({
    actionId: d.actionId,
    argumentsDigest: d.argumentsDigest,
  });
  await mgr.apply(worktreeId, { grantId: ok });
  // The grant is burnt; a second identical apply needs a new one.
  g(ws, "checkout", "-q", "--", ".");
  g(ws, "clean", "-qfd");
  await assert.rejects(mgr.apply(worktreeId, { grantId: ok }), {
    code: "GRANT_DENIED",
  });
  assert.equal(g(ws, "status", "--porcelain"), "");
});

test("a grant bound to an earlier diff does not cover a later worktree edit", async () => {
  const { ws, mgr, grants } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  change(root);
  const d = await mgr.diff(worktreeId);
  const grantId = grants.issue({
    actionId: d.actionId,
    argumentsDigest: d.argumentsDigest,
  });
  write(root, { "keep.txt": "sneaky\n" });
  await assert.rejects(mgr.apply(worktreeId, { grantId }), {
    code: "GRANT_DENIED",
  });
  assert.equal(read(ws, "keep.txt"), "keep\n");
});

test("apply with a valid grant updates the parent exactly", async () => {
  const { ws, mgr, grants } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  change(root);
  const d = await mgr.diff(worktreeId);
  const grantId = grants.issue({
    actionId: d.actionId,
    argumentsDigest: d.argumentsDigest,
  });
  const res = await mgr.apply(worktreeId, { grantId });
  assert.equal(res.applied, true);
  assert.deepEqual(res.files, d.files);
  assert.equal(grants.size, 0, "grant consumed");
  assert.equal(read(ws, "edit.txt"), "line1\nCHANGED\n");
  assert.equal(read(ws, "src/new.ts"), "export const n = 2;\n");
  assert.ok(!existsSync(join(ws, "gone.txt")));
  assert.equal(read(ws, "keep.txt"), "keep\n");
  assert.deepEqual(
    g(ws, "status", "--porcelain", "-uall").split("\n").filter(Boolean).sort(),
    [" D gone.txt", " M edit.txt", "?? src/new.ts"],
    "changes land uncommitted in the working tree only",
  );
});

test("prepared apply is bound to one invocation", async () => {
  const { mgr, grants } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  change(root);
  const diff = await mgr.diff(worktreeId);
  const apply = await mgr.prepareApply(worktreeId);
  await apply({ grantId: grants.issue(diff) });
  assert.throws(() => apply({ grantId: grants.issue(diff) }), {
    code: "GRANT_DENIED",
  });
});

test("apply conflict: dirty touched file refused, no partial write, grant kept", async () => {
  const { ws, mgr, grants } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  change(root);
  write(ws, { "edit.txt": "line1\nUSER EDIT\n" });
  const d = await mgr.diff(worktreeId);
  const grantId = grants.issue({
    actionId: d.actionId,
    argumentsDigest: d.argumentsDigest,
  });
  await assert.rejects(
    mgr.apply(worktreeId, { grantId }),
    (e: { code: string; paths: string[] }) => {
      assert.equal(e.code, "APPLY_CONFLICT");
      assert.deepEqual(e.paths, ["edit.txt"]);
      return true;
    },
  );
  assert.equal(read(ws, "edit.txt"), "line1\nUSER EDIT\n");
  assert.ok(
    existsSync(join(ws, "gone.txt")),
    "no other touched file was written",
  );
  assert.ok(!existsSync(join(ws, "src/new.ts")));
  assert.equal(grants.size, 1, "a refused apply does not burn the grant");
  // An untracked parent file at an added path is a conflict too.
  write(ws, { "edit.txt": "line1\nline2\n", "src/new.ts": "mine\n" });
  await assert.rejects(mgr.apply(worktreeId, { grantId }), {
    code: "APPLY_CONFLICT",
  });
  assert.equal(read(ws, "src/new.ts"), "mine\n");
});

test("apply conflict: an uncommitted edit far from the hunk still refuses (no silent merge)", async () => {
  const long =
    Array.from({ length: 40 }, (_, i) => `l${String(i)}`).join("\n") + "\n";
  const { ws, mgr, grants } = setup({ ...FILES, "long.txt": long });
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  write(root, { "long.txt": long.replace("l2\n", "AGENT\n") });
  const userEdit = long.replace("l37\n", "USER\n");
  write(ws, { "long.txt": userEdit });
  const d = await mgr.diff(worktreeId);
  const grantId = grants.issue({
    actionId: d.actionId,
    argumentsDigest: d.argumentsDigest,
  });
  await assert.rejects(mgr.apply(worktreeId, { grantId }), {
    code: "APPLY_CONFLICT",
  });
  assert.equal(read(ws, "long.txt"), userEdit);
  assert.equal(grants.size, 1);
});

test("apply conflict: parent HEAD moved under the patch fails --check atomically", async () => {
  const { ws, mgr, grants } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  change(root);
  write(ws, { "edit.txt": "line1\nCOMMITTED\n" });
  g(ws, "commit", "-q", "-am", "moved");
  const d = await mgr.diff(worktreeId);
  const grantId = grants.issue({
    actionId: d.actionId,
    argumentsDigest: d.argumentsDigest,
  });
  await assert.rejects(mgr.apply(worktreeId, { grantId }), {
    code: "APPLY_CONFLICT",
  });
  assert.equal(
    g(ws, "status", "--porcelain"),
    "",
    "no file of the patch was written",
  );
  assert.equal(grants.size, 1);
});

test("discard removes the worktree and is idempotent", async () => {
  const { ws, mgr } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  change(root);
  await mgr.discard(worktreeId);
  assert.ok(!existsSync(root));
  assert.deepEqual(mgr.list("w1"), []);
  assert.equal(
    g(ws, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
  await mgr.discard(worktreeId);
  await mgr.discard("wtneverexisted");
  await assert.rejects(mgr.diff(worktreeId), { code: "WORKTREE_UNKNOWN" });
  await assert.rejects(mgr.discard("../escape"), { code: "INVALID_ID" });
});

test("sweepOrphans at startup removes worktrees with no live child only", async () => {
  const { ws, mgr, make } = setup(FILES);
  const live = await mgr.create({ workspaceId: "w1", childId: "alive" });
  const dead = await mgr.create({ workspaceId: "w1", childId: "dead" });
  // Restart: a fresh manager over the same cache dir.
  const restarted = make((id) => id === "alive");
  const swept = await restarted.sweepOrphans();
  assert.deepEqual(swept, { removed: [dead.worktreeId], failed: [] });
  assert.ok(!existsSync(dead.root));
  assert.ok(existsSync(live.root));
  assert.deepEqual(
    restarted.list("w1").map((w) => w.childId),
    ["alive"],
  );
  assert.equal(
    g(ws, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    2,
  );
});

test("discard and sweep refuse forged metadata directories without touching outside files", async () => {
  for (const operation of ["discard", "sweep"] as const) {
    const { ws, mgr, make } = setup(FILES);
    const { worktreeId, root } = await mgr.create({
      workspaceId: "w1",
      childId: "dead",
    });
    const outside = join(dirname(ws), "outside");
    write(outside, { "sentinel.txt": "preserve me\n" });
    const file = `${root}.json`;
    const meta = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...meta, dir: outside }));
    if (operation === "discard") {
      await assert.rejects(mgr.discard(worktreeId), {
        code: "WORKTREE_PATH_INVALID",
      });
    } else {
      assert.deepEqual(await make(() => false).sweepOrphans(), {
        removed: [],
        failed: [{ worktreeId, code: "WORKTREE_PATH_INVALID" }],
      });
    }
    assert.equal(read(outside, "sentinel.txt"), "preserve me\n");
    assert.ok(existsSync(root), "the original worktree is preserved too");
    assert.ok(
      existsSync(file),
      "invalid metadata remains available for recovery",
    );
  }
});

test("sweep reports malformed metadata and continues removing valid orphans", async () => {
  const { mgr, make } = setup(FILES);
  const bad = await mgr.create({ workspaceId: "w1", childId: "bad" });
  const good = await mgr.create({ workspaceId: "w1", childId: "good" });
  writeFileSync(`${bad.root}.json`, "{broken");
  const swept = await make(() => false).sweepOrphans();
  assert.deepEqual(swept.removed, [good.worktreeId]);
  assert.deepEqual(swept.failed, [
    { worktreeId: bad.worktreeId, code: "WORKTREE_PATH_INVALID" },
  ]);
  assert.ok(existsSync(bad.root));
  assert.ok(!existsSync(good.root));
});

test("discard and sweep refuse a redirected worktree directory", async () => {
  for (const operation of ["discard", "sweep"] as const) {
    const { ws, mgr, make } = setup(FILES, { git: false });
    const { worktreeId, root } = await mgr.create({
      workspaceId: "w1",
      childId: "dead",
    });
    const outside = join(dirname(ws), "outside");
    write(outside, { "sentinel.txt": "preserve me\n" });
    rmSync(root, { recursive: true });
    symlinkSync(
      outside,
      root,
      process.platform === "win32" ? "junction" : "dir",
    );
    if (operation === "discard") {
      await assert.rejects(mgr.discard(worktreeId), {
        code: "WORKTREE_PATH_INVALID",
      });
    } else {
      assert.deepEqual(await make(() => false).sweepOrphans(), {
        removed: [],
        failed: [{ worktreeId, code: "WORKTREE_PATH_INVALID" }],
      });
    }
    assert.equal(read(outside, "sentinel.txt"), "preserve me\n");
    assert.ok(existsSync(`${root}.json`));
  }
});

test("oversized multibyte patches are refused before parent writes or grant consumption", async () => {
  assert.equal(MAX_WORKTREE_DIFF_BYTES, 1_048_576);
  const { ws, mgr, grants } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  write(root, { "large.txt": "small\n" });
  const approved = await mgr.diff(worktreeId);
  const grantId = grants.issue(approved);
  const content = `${"\u00e9".repeat(MAX_WORKTREE_DIFF_BYTES / 2)}\n`;
  assert.ok(content.length < MAX_WORKTREE_DIFF_BYTES);
  assert.ok(Buffer.byteLength(content) > MAX_WORKTREE_DIFF_BYTES);
  write(root, { "large.txt": content });
  await assert.rejects(mgr.diff(worktreeId), { code: "PATCH_TOO_LARGE" });
  await assert.rejects(mgr.apply(worktreeId, { grantId }), {
    code: "PATCH_TOO_LARGE",
  });
  assert.equal(grants.size, 1);
  assert.ok(!existsSync(join(ws, "large.txt")));
  assert.equal(read(ws, "edit.txt"), FILES["edit.txt"]);
  assert.equal(g(ws, "status", "--porcelain"), "");
});

const PATCH = (a: string, b = a) =>
  `diff --git a/${a} b/${b}\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/${b}\n@@ -0,0 +1 @@\n+x\n`;

test("crafted patches touching ../, absolute, drive, .git or device paths are refused", () => {
  assertPatchConfined(PATCH("src/ok.ts"));
  assertPatchConfined(
    `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n--- comment\n+--- x/../../y\n`,
  );
  const bad = [
    PATCH("../outside.txt"),
    PATCH("src/../../outside.txt"),
    PATCH("ok.txt").replace("+++ b/ok.txt", "+++ b//etc/passwd"),
    PATCH("ok.txt").replace("+++ b/ok.txt", "+++ /abs/path"),
    PATCH("C:/Windows/x"),
    PATCH(".git/hooks/pre-commit"),
    PATCH("sub/.GIT/config"),
    PATCH("GIT~1/config"),
    PATCH("nul"),
    PATCH("a.txt:stream"),
    PATCH("trail."),
    PATCH("back\\slash"),
    `diff --git "a/..\\057x" "b/..\\057x"\n--- /dev/null\n+++ "b/..\\057x"\n`,
    `diff --git a/x b/y\nrename from x\nrename to ../y\n`,
    `diff --git a/l b/l\nnew file mode 120000\n`,
    `diff --git a/m b/m\nnew file mode 160000\n`,
  ];
  for (const patch of bad)
    assert.throws(
      () => assertPatchConfined(patch),
      { code: "PATCH_REJECTED" },
      patch,
    );
});

test("apply refuses a worktree symlink instead of planting it in the parent", async () => {
  const { ws, mgr, grants } = setup(FILES);
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  symlinkSync("../../../outside.txt", join(root, "link.txt"), "file");
  await assert.rejects(mgr.diff(worktreeId), { code: "PATCH_REJECTED" });
  await assert.rejects(
    mgr.apply(worktreeId, {
      grantId: grants.issue({ actionId: "x", argumentsDigest: "y" }),
    }),
    {
      code: "PATCH_REJECTED",
    },
  );
  assert.ok(!existsSync(join(ws, "link.txt")));
  assert.equal(grants.size, 1);
});

test("non-git workspace: snapshot of listed files, skipping ignored and secret files", async () => {
  const { ws, mgr, grants } = setup(
    {
      ...FILES,
      ".gitignore": "dist/\n",
      "dist/out.js": "built\n",
      ".env": "TOKEN=1\n",
      "keys/id_rsa": "private\n",
    },
    { git: false },
  );
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  assert.equal(mgr.list("w1")[0]!.mode, "snapshot");
  assert.equal(read(root, "src/deep/a.ts"), "export const a = 1;\n");
  for (const skipped of ["dist/out.js", ".env", "keys/id_rsa"])
    assert.ok(!existsSync(join(root, skipped)), skipped);
  await assert.rejects(
    mgr.create({ workspaceId: "w1", childId: "c2", baseRef: "HEAD" }),
    {
      code: "BASE_REF_INVALID",
    },
  );
  change(root);
  const d = await mgr.diff(worktreeId);
  assert.deepEqual(d.files.map((f) => f.status).sort(), [
    "added",
    "deleted",
    "modified",
  ]);
  // Conflict: the parent file drifted from the snapshot.
  write(ws, { "edit.txt": "drift\n" });
  const grantId = grants.issue({
    actionId: d.actionId,
    argumentsDigest: d.argumentsDigest,
  });
  await assert.rejects(mgr.apply(worktreeId, { grantId }), {
    code: "APPLY_CONFLICT",
  });
  assert.ok(
    existsSync(join(ws, "gone.txt")) && !existsSync(join(ws, "src/new.ts")),
  );
  write(ws, { "edit.txt": "line1\nline2\n" });
  await mgr.apply(worktreeId, { grantId });
  assert.equal(read(ws, "edit.txt"), "line1\nCHANGED\n");
  assert.equal(read(ws, "src/new.ts"), "export const n = 2;\n");
  assert.ok(!existsSync(join(ws, "gone.txt")));
  assert.equal(read(ws, ".env"), "TOKEN=1\n");
  assert.equal(read(ws, "dist/out.js"), "built\n");
  assert.ok(
    !existsSync(join(ws, ".git")),
    "the parent stays a plain directory",
  );
  await mgr.discard(worktreeId);
  assert.ok(!existsSync(root));
});

test("workspace in a repo subdirectory: root, diff and apply stay workspace-relative", async () => {
  const { ws, mgr, grants, workspaces } = setup({
    ...FILES,
    "pkg/app/main.ts": "v1\n",
    "other.txt": "o\n",
  });
  const sub = join(ws, "pkg", "app");
  workspaces.set("w1", { canonicalPath: sub });
  const { worktreeId, root } = await mgr.create({
    workspaceId: "w1",
    childId: "c1",
  });
  assert.equal(read(root, "main.ts"), "v1\n");
  write(root, { "main.ts": "v2\n", "../../other.txt": "outside-ws edit\n" });
  const d = await mgr.diff(worktreeId);
  assert.deepEqual(d.files, [{ path: "main.ts", status: "modified" }]);
  await mgr.apply(worktreeId, {
    grantId: grants.issue({
      actionId: d.actionId,
      argumentsDigest: d.argumentsDigest,
    }),
  });
  assert.equal(read(sub, "main.ts"), "v2\n");
  assert.equal(
    read(ws, "other.txt"),
    "o\n",
    "nothing outside the workspace is applied",
  );
});

test("ids are strict and the per-workspace count is bounded", async () => {
  const { mgr } = setup(FILES, { max: 1 });
  for (const childId of ["a/b", "a\\b", "..", "", "x".repeat(129), "-flag"])
    await assert.rejects(
      mgr.create({ workspaceId: "w1", childId }),
      { code: "INVALID_ID" },
      childId,
    );
  await assert.rejects(mgr.create({ workspaceId: "nope", childId: "c" }), {
    code: "WORKSPACE_UNKNOWN",
  });
  const first = await mgr.create({ workspaceId: "w1", childId: "c1" });
  await assert.rejects(mgr.create({ workspaceId: "w1", childId: "c2" }), {
    code: "WORKTREE_LIMIT",
  });
  await mgr.discard(first.worktreeId);
  await mgr.create({ workspaceId: "w1", childId: "c2" });
});

test("cacheDir inside the workspace is refused", async () => {
  const { ws } = setup(FILES);
  const mgr = new WorktreeManager({
    cacheDir: join(ws, ".cache"),
    workspaces: { workspace: () => ({ canonicalPath: ws }) },
    consumeGrant: () => undefined,
    isChildLive: () => true,
    maxPerWorkspace: 2,
  });
  await assert.rejects(mgr.create({ workspaceId: "w1", childId: "c1" }), {
    code: "CACHE_DIR_INVALID",
  });
});
