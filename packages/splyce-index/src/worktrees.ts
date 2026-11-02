// TD-70 / E1_worktrees — isolated working copies for write-capable subagents.
// Engine-only: `root` is handed to the child's tools and never to the renderer.
// Copies live under <cacheDir>/worktrees/<workspaceHash>/<worktreeId>, outside
// the user's repository, with short hashed names (Windows MAX_PATH).
//  - git workspace: `git worktree add --detach <dir> <base>`; base defaults to
//    the workspace HEAD.
//  - non-git workspace: a copy-on-create snapshot of the files the code index
//    would list (root .gitignore, links never followed, secret-shaped paths
//    skipped — `listWorkspaceFiles`), committed into a private git repo inside
//    the snapshot so diff/apply use the same git machinery.
// apply() recomputes the diff itself (callers never supply a patch), confines
// every path, refuses dirty/changed parent files, `git apply --check`s, consumes
// a once-grant bound to {actionId, argumentsDigest = sha256(patch)}, then runs
// `git apply`, which is all-or-nothing. Git runs via spawn with argument arrays,
// no shell, GIT_* env stripped, hooks and fsmonitor disabled. Stdlib only.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { listWorkspaceFiles } from "./index.js";

export type WorktreeErrorCode =
  | "INVALID_ID"
  | "CACHE_DIR_INVALID"
  | "WORKSPACE_UNKNOWN"
  | "WORKTREE_UNKNOWN"
  | "WORKTREE_LIMIT"
  | "WORKTREE_PATH_INVALID"
  | "PATCH_TOO_LARGE"
  | "BASE_REF_INVALID"
  | "PATCH_REJECTED"
  | "APPLY_CONFLICT"
  | "GRANT_DENIED"
  | "WORKTREE_BUSY"
  | "GIT_FAILED";

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;
  /** Workspace-relative paths behind an APPLY_CONFLICT / PATCH_REJECTED. */
  readonly paths: readonly string[];
  constructor(
    code: WorktreeErrorCode,
    message: string,
    options: { cause?: unknown; paths?: readonly string[] } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "WorktreeError";
    this.code = code;
    this.paths = options.paths ?? [];
  }
}

/** Git failure; stderr (may hold engine paths) stays in `detail`, off the message. */
export class GitError extends Error {
  readonly exitCode: number | null;
  readonly detail: string;
  constructor(command: string, exitCode: number | null, detail: string) {
    super(`git ${command} exited ${String(exitCode)}`);
    this.name = "GitError";
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

export interface WorkspacePort {
  workspace(workspaceId: string): { canonicalPath: string } | undefined;
}
export interface ApplyAct {
  actionId: string;
  argumentsDigest: string;
}
export interface WorktreeManagerOptions {
  /** App-data cache dir (absolute, outside every workspace). */
  cacheDir: string;
  workspaces: WorkspacePort;
  /** Atomically consumes a once-grant bound to the act; throws when invalid. */
  consumeGrant(grantId: string, act: ApplyAct): void | Promise<void>;
  /** Liveness of the owning child, for `sweepOrphans`. */
  isChildLive(childId: string): boolean;
  /** Config: max live worktrees per workspace. */
  maxPerWorkspace: number;
}
export type FileStatus = "added" | "modified" | "deleted";
export interface WorktreeFile {
  path: string;
  status: FileStatus;
}
export interface WorktreeDiff {
  patch: string;
  files: WorktreeFile[];
  /** The act a once-grant for apply() must be bound to. */
  actionId: string;
  argumentsDigest: string;
}
export interface WorktreeInfo {
  worktreeId: string;
  workspaceId: string;
  childId: string;
  baseRef: string;
  mode: "git" | "snapshot";
}

interface Meta extends WorktreeInfo {
  dir: string;
  workspaceRoot: string;
  /** Git top level of the workspace (git mode) or null (snapshot). */
  repoRoot: string | null;
  /** Workspace path inside the repo, "" or "sub/dir/". */
  prefix: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]{0,254}$/;
const MAX_OUTPUT = 1 << 28;
export const MAX_WORKTREE_DIFF_BYTES = 1 << 20;
const GIT_TIMEOUT_MS = 120_000;
const win = process.platform === "win32";
const DEVICE =
  /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

const checkId = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !ID.test(value))
    throw new WorktreeError("INVALID_ID", `${name} is not a valid id`);
  return value;
};

const ESCAPE = (path: string) =>
  new WorktreeError(
    "PATCH_REJECTED",
    "patch touches a path outside the workspace",
    {
      paths: [path],
    },
  );

/** One workspace-relative path a patch may touch. */
function checkPath(path: string): void {
  const segs = path.split("/");
  if (
    path === "" ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.includes(":") ||
    isAbsolute(path) ||
    segs.some(
      (s) =>
        s === "" ||
        s === "." ||
        s === ".." ||
        /[. ]$/.test(s) ||
        DEVICE.test(s) ||
        /^\.git$/i.test(s) ||
        /^git~\d+$/i.test(s),
    )
  )
    throw ESCAPE(path);
}

/** Git C-style quoted name ("a/x\303\251") or the raw name. */
function unquote(name: string): string {
  if (!name.startsWith('"')) return name;
  if (!name.endsWith('"') || name.length < 2) throw ESCAPE(name);
  const bytes: number[] = [];
  const body = name.slice(1, -1);
  const simple: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '"': 34,
    "\\": 92,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c));
      continue;
    }
    const next = body[++i] ?? "";
    const oct = /^[0-7]{3}/.exec(body.slice(i));
    if (oct) {
      bytes.push(Number.parseInt(oct[0], 8));
      i += 2;
    } else if (simple[next] !== undefined) bytes.push(simple[next]);
    else throw ESCAPE(name);
  }
  return Buffer.from(bytes).toString("utf8");
}

const stripSide = (name: string): string => {
  const n = unquote(name);
  if (!n.startsWith("a/") && !n.startsWith("b/")) throw ESCAPE(n);
  return n.slice(2);
};

/** Names in a `diff --git` header, unquoted and without the a/ b/ prefix. */
function headerNames(rest: string): string[] {
  if (rest.startsWith('"')) {
    const end = /^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0];
    if (!end) throw ESCAPE(rest);
    return [stripSide(end), stripSide(rest.slice(end.length + 1))];
  }
  const half = (rest.length - 1) / 2;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  if (Number.isInteger(half) && rest[half] === " " && a.slice(2) === b.slice(2))
    return [stripSide(a), stripSide(b)];
  // Rename-shaped header: judge every space/slash-separated piece.
  const pieces = rest.split(/[ /]/).filter((p) => p !== "a" && p !== "b");
  for (const p of pieces) checkPath(p);
  return [];
}

/**
 * Throws PATCH_REJECTED unless every path the patch names is a confined,
 * workspace-relative path and no entry is a symlink or submodule (mode 120000 /
 * 160000), which `git apply` would otherwise materialise in the parent.
 */
export function assertPatchConfined(patch: string): void {
  let header = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      for (const n of headerNames(line.slice(11))) checkPath(n);
      continue;
    }
    if (!header) continue;
    if (line.startsWith("@@") || line.startsWith("GIT binary patch")) {
      header = false;
      continue;
    }
    if (/\b1[26]0000\b/.test(line))
      throw new WorktreeError(
        "PATCH_REJECTED",
        "patch adds a symlink or submodule",
      );
    const side = /^(?:---|\+\+\+) (.*)$/.exec(line)?.[1];
    if (side !== undefined) {
      const name = side.replace(/\t.*$/, "");
      if (name !== "/dev/null") checkPath(stripSide(name));
      continue;
    }
    const moved = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line)?.[1];
    if (moved !== undefined) checkPath(unquote(moved));
  }
}

function git(
  args: readonly string[],
  cwd: string,
  input?: Buffer | string,
): Promise<Buffer> {
  return new Promise((done, fail) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !/^GIT_/i.test(k)) env[k] = v;
    const child = spawn("git", args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_OUTPUT) child.kill();
      else out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      if (err.length < 8192) err += c.toString("utf8");
    });
    // EPIPE when git exits before reading stdin; the exit status reports it.
    child.stdin.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") fail(e);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      const verb =
        args.find(
          (a, i) =>
            i > 0 && args[i - 1] !== "-c" && a !== "-c" && !a.startsWith("--"),
        ) ?? "";
      if (code === 0 && size <= MAX_OUTPUT) done(Buffer.concat(out));
      else
        fail(
          new GitError(
            verb,
            code,
            size > MAX_OUTPUT ? "output limit exceeded" : err.trim(),
          ),
        );
    });
    child.stdin.end(input);
  });
}

const gitFailed = (message: string, cause: unknown) =>
  new WorktreeError("GIT_FAILED", message, { cause });

const blobSha1 = (data: Buffer) =>
  createHash("sha1")
    .update(`blob ${String(data.length)}\0`)
    .update(data)
    .digest("hex");

const isBusy = (e: unknown) =>
  ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"].includes(
    (e as { code?: string }).code ?? "",
  );

export class WorktreeManager {
  private readonly base: string;
  private readonly opts: WorktreeManagerOptions;
  private readonly common: readonly string[];
  private readonly pending = new Map<string, number>();

  constructor(options: WorktreeManagerOptions) {
    const { cacheDir, maxPerWorkspace } = options;
    if (
      typeof cacheDir !== "string" ||
      !isAbsolute(cacheDir) ||
      resolve(cacheDir) !== cacheDir
    )
      throw new WorktreeError(
        "CACHE_DIR_INVALID",
        "cacheDir must be a canonical absolute path",
      );
    if (
      !Number.isInteger(maxPerWorkspace) ||
      maxPerWorkspace < 1 ||
      maxPerWorkspace > 64
    )
      throw new WorktreeError(
        "WORKTREE_LIMIT",
        "maxPerWorkspace must be an integer in 1..64",
      );
    this.opts = options;
    this.base = join(cacheDir, "worktrees");
    this.common = [
      "-c",
      "core.longpaths=true",
      "-c",
      `core.hooksPath=${join(this.base, ".no-hooks")}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.quotepath=false",
    ];
  }

  /** Git args for a worktree's own repo; snapshot repos are byte-exact. */
  private cfg(mode: Meta["mode"]): string[] {
    return mode === "git"
      ? [...this.common]
      : [
          ...this.common,
          "-c",
          "core.autocrlf=false",
          "-c",
          "core.safecrlf=false",
          "-c",
          "user.name=Splyce",
          "-c",
          "user.email=splyce@localhost",
          "-c",
          "commit.gpgsign=false",
        ];
  }

  private workspaceRoot(workspaceId: string): string {
    const path = this.opts.workspaces.workspace(workspaceId)?.canonicalPath;
    if (!path || !existsSync(path))
      throw new WorktreeError("WORKSPACE_UNKNOWN", "workspace is not admitted");
    const rel = relative(path, this.base);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
      throw new WorktreeError(
        "CACHE_DIR_INVALID",
        "cacheDir must be outside the workspace",
      );
    return path;
  }

  private wsDir(root: string): string {
    const key = win ? root.toLowerCase() : root;
    return join(
      this.base,
      createHash("sha256").update(key).digest("hex").slice(0, 16),
    );
  }

  private metas(wsDir: string): Meta[] {
    if (!existsSync(wsDir)) return [];
    return readdirSync(wsDir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => this.readMeta(join(wsDir, n)));
  }

  private assertWorktreeDir(dir: string): void {
    const invalid = () =>
      new WorktreeError("WORKTREE_PATH_INVALID", "invalid worktree directory");
    if (typeof dir !== "string" || resolve(dir) !== dir) throw invalid();
    const inside = (root: string, target: string) => {
      const rel = relative(root, target);
      return (
        rel !== "" &&
        rel !== ".." &&
        !rel.startsWith(`..${sep}`) &&
        !isAbsolute(rel)
      );
    };
    if (!inside(this.base, dir)) throw invalid();
    let probe = dir;
    while (!existsSync(probe) && dirname(probe) !== probe)
      probe = dirname(probe);
    if (!inside(realpathSync(this.base), realpathSync(probe))) throw invalid();
  }

  private readMeta(file: string): Meta {
    let meta: Meta;
    try {
      meta = JSON.parse(readFileSync(file, "utf8")) as Meta;
    } catch (cause) {
      throw new WorktreeError(
        "WORKTREE_PATH_INVALID",
        "invalid worktree metadata",
        { cause },
      );
    }
    if (
      !meta ||
      meta.dir !== file.slice(0, -5) ||
      meta.worktreeId !== file.slice(dirname(file).length + 1, -5)
    )
      throw new WorktreeError(
        "WORKTREE_PATH_INVALID",
        "invalid worktree metadata",
      );
    this.assertWorktreeDir(meta.dir);
    return meta;
  }

  private writeMeta(meta: Meta): void {
    const file = `${meta.dir}.json`;
    writeFileSync(`${file}.tmp`, JSON.stringify(meta));
    renameSync(`${file}.tmp`, file);
  }

  private meta(worktreeId: string): Meta | null {
    checkId(worktreeId, "worktreeId");
    if (!existsSync(this.base)) return null;
    for (const ws of readdirSync(this.base)) {
      const file = join(this.base, ws, `${worktreeId}.json`);
      if (existsSync(file)) return this.readMeta(file);
    }
    return null;
  }

  private known(worktreeId: string): Meta {
    const meta = this.meta(worktreeId);
    if (!meta) throw new WorktreeError("WORKTREE_UNKNOWN", "no such worktree");
    return meta;
  }

  private async toplevel(
    root: string,
  ): Promise<{ top: string; prefix: string } | null> {
    try {
      const [top, prefix] = (
        await git(
          [...this.common, "rev-parse", "--show-toplevel", "--show-prefix"],
          root,
        )
      )
        .toString("utf8")
        .split("\n");
      return { top: resolve(top!), prefix: prefix ?? "" };
    } catch (e) {
      if (e instanceof GitError && e.exitCode === 128) return null; // not a work tree
      throw gitFailed("git is unavailable", e);
    }
  }

  async create(input: {
    workspaceId: string;
    childId: string;
    baseRef?: string;
  }): Promise<{ worktreeId: string; root: string }> {
    const workspaceId = checkId(input.workspaceId, "workspaceId");
    const childId = checkId(input.childId, "childId");
    if (
      input.baseRef !== undefined &&
      (typeof input.baseRef !== "string" || !REF.test(input.baseRef))
    )
      throw new WorktreeError("BASE_REF_INVALID", "baseRef is not a valid ref");
    const workspaceRoot = this.workspaceRoot(workspaceId);
    const wsDir = this.wsDir(workspaceRoot);
    const pending = this.pending.get(wsDir) ?? 0;
    if (this.metas(wsDir).length + pending >= this.opts.maxPerWorkspace)
      throw new WorktreeError(
        "WORKTREE_LIMIT",
        "worktree limit reached for this workspace",
      );
    this.pending.set(wsDir, pending + 1);
    try {
      const repo = await this.toplevel(workspaceRoot);
      if (!repo && input.baseRef !== undefined)
        throw new WorktreeError(
          "BASE_REF_INVALID",
          "a non-git workspace has no refs",
        );
      mkdirSync(wsDir, { recursive: true });
      const worktreeId = `wt${randomBytes(8).toString("hex")}`;
      const meta: Meta = {
        worktreeId,
        workspaceId,
        childId,
        baseRef: "",
        mode: repo ? "git" : "snapshot",
        dir: join(wsDir, worktreeId),
        workspaceRoot,
        repoRoot: repo?.top ?? null,
        prefix: repo?.prefix ?? "",
      };
      // Meta first: a crash mid-create leaves something sweepOrphans can find.
      this.writeMeta(meta);
      try {
        if (repo) {
          let sha: string;
          try {
            sha = (
              await git(
                [
                  ...this.common,
                  "rev-parse",
                  "--verify",
                  "--quiet",
                  "--end-of-options",
                  `${input.baseRef ?? "HEAD"}^{commit}`,
                ],
                workspaceRoot,
              )
            )
              .toString("utf8")
              .trim();
          } catch (e) {
            throw new WorktreeError(
              "BASE_REF_INVALID",
              "baseRef does not name a commit",
              { cause: e },
            );
          }
          meta.baseRef = sha;
          this.writeMeta(meta);
          await git(
            [
              ...this.common,
              "worktree",
              "add",
              "--detach",
              "--",
              meta.dir,
              sha,
            ],
            repo.top,
          );
        } else {
          meta.baseRef = await this.snapshot(workspaceRoot, meta.dir);
          this.writeMeta(meta);
        }
      } catch (e) {
        try {
          await this.remove(meta);
        } catch (cleanup) {
          throw new AggregateError(
            [e, cleanup],
            "worktree create failed and its cleanup failed",
          );
        }
        throw e instanceof WorktreeError
          ? e
          : gitFailed("worktree create failed", e);
      }
      return { worktreeId, root: join(meta.dir, meta.prefix) };
    } finally {
      this.pending.set(wsDir, (this.pending.get(wsDir) ?? 1) - 1);
    }
  }

  private async snapshot(workspaceRoot: string, dir: string): Promise<string> {
    mkdirSync(dir);
    for (const rel of listWorkspaceFiles(workspaceRoot)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      copyFileSync(join(workspaceRoot, rel), join(dir, rel));
    }
    const cfg = this.cfg("snapshot");
    await git([...cfg, "init", "-q"], dir);
    await git([...cfg, "add", "-A", "-f"], dir);
    await git(
      [
        ...cfg,
        "commit",
        "-q",
        "--allow-empty",
        "--no-verify",
        "-m",
        "snapshot",
      ],
      dir,
    );
    return (await git([...cfg, "rev-parse", "HEAD"], dir))
      .toString("utf8")
      .trim();
  }

  private async compute(meta: Meta): Promise<{ buf: Buffer } & WorktreeDiff> {
    const cfg = this.cfg(meta.mode);
    const root = join(meta.dir, meta.prefix);
    const range = [
      "diff",
      "--cached",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      meta.prefix ? "--relative" : "--no-relative",
      meta.baseRef,
    ];
    let buf: Buffer;
    let names: string[];
    try {
      await git([...cfg, "add", "-A"], meta.dir);
      buf = await git(
        [
          ...cfg,
          ...range,
          "--binary",
          "--full-index",
          "--src-prefix=a/",
          "--dst-prefix=b/",
        ],
        root,
      );
      names = (await git([...cfg, ...range, "--name-status", "-z"], root))
        .toString("utf8")
        .split("\0");
    } catch (e) {
      throw gitFailed("worktree diff failed", e);
    }
    const files: WorktreeFile[] = [];
    for (let i = 0; i + 1 < names.length; i += 2) {
      const code = names[i]!;
      const path = names[i + 1]!;
      checkPath(path);
      files.push({
        path,
        status: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
      });
    }
    const patch = buf.toString("utf8");
    if (buf.byteLength > MAX_WORKTREE_DIFF_BYTES)
      throw new WorktreeError(
        "PATCH_TOO_LARGE",
        "child patch exceeds the byte limit",
      );
    assertPatchConfined(patch);
    return {
      buf,
      patch,
      files,
      actionId: `worktree.apply:${meta.worktreeId}`,
      argumentsDigest: createHash("sha256").update(buf).digest("hex"),
    };
  }

  async diff(worktreeId: string): Promise<WorktreeDiff> {
    const { buf: _buf, ...diff } = await this.compute(this.known(worktreeId));
    return diff;
  }

  /** Refuses when a touched parent file differs from the worktree's base. */
  private async assertClean(
    meta: Meta,
    files: readonly WorktreeFile[],
  ): Promise<void> {
    if (files.length === 0) return;
    let dirty: string[];
    if (meta.repoRoot) {
      // Whole-tree status filtered here: `status` has no --pathspec-from-file
      // and a path list on the command line would hit Windows' length limit.
      const out = await git(
        [
          ...this.common,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ],
        meta.repoRoot,
      ).catch((e: unknown) => {
        throw gitFailed("parent status failed", e);
      });
      const changed = new Set<string>();
      const entries = out.toString("utf8").split("\0");
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        if (!e) continue;
        changed.add(e.slice(3));
        if (e[0] === "R" || e[0] === "C") changed.add(entries[++i] ?? "");
      }
      dirty = files
        .map((f) => f.path)
        .filter((p) => changed.has(meta.prefix + p));
    } else {
      const tree = new Map<string, string>();
      const out = await git(
        [...this.cfg("snapshot"), "ls-tree", "-r", "-z", meta.baseRef],
        meta.dir,
      ).catch((e: unknown) => {
        throw gitFailed("snapshot tree read failed", e);
      });
      for (const entry of out.toString("utf8").split("\0").filter(Boolean)) {
        const tab = entry.indexOf("\t");
        tree.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]!);
      }
      dirty = files
        .filter((f) => {
          const abs = join(meta.workspaceRoot, f.path);
          let st;
          try {
            st = lstatSync(abs);
          } catch (e) {
            if ((e as { code?: string }).code !== "ENOENT") throw e;
            return f.status !== "added"; // modified/deleted file vanished
          }
          if (f.status === "added" || !st.isFile()) return true;
          return blobSha1(readFileSync(abs)) !== tree.get(f.path);
        })
        .map((f) => f.path);
    }
    if (dirty.length)
      throw new WorktreeError(
        "APPLY_CONFLICT",
        "parent workspace changed in touched files",
        { paths: dirty },
      );
  }

  async apply(
    worktreeId: string,
    input: { grantId: string },
  ): Promise<{ applied: true; files: WorktreeFile[] }> {
    return (await this.prepareApply(worktreeId))(input);
  }

  async prepareApply(
    worktreeId: string,
  ): Promise<
    (input: {
      grantId: string;
    }) => Promise<{ applied: true; files: WorktreeFile[] }>
  > {
    const meta = this.known(worktreeId);
    if (this.workspaceRoot(meta.workspaceId) !== meta.workspaceRoot)
      throw new WorktreeError(
        "WORKSPACE_UNKNOWN",
        "workspace root changed since create",
      );
    const diff = await this.compute(meta);
    await this.assertClean(meta, diff.files);
    const cwd = meta.repoRoot ?? meta.workspaceRoot;
    const args = [
      ...this.cfg(meta.mode),
      "apply",
      "--whitespace=nowarn",
      ...(meta.prefix ? [`--directory=${meta.prefix.slice(0, -1)}`] : []),
    ];
    try {
      await git([...args, "--check", "-"], cwd, diff.buf);
    } catch (e) {
      throw new WorktreeError(
        "APPLY_CONFLICT",
        "patch does not apply to the parent workspace",
        {
          cause: e,
          paths: diff.files.map((f) => f.path),
        },
      );
    }
    let used = false;
    return (input) => {
      if (used)
        throw new WorktreeError("GRANT_DENIED", "prepared apply already used");
      used = true;
      return this.applyChecked(input, diff, args, cwd);
    };
  }

  private async applyChecked(
    input: { grantId: string },
    diff: WorktreeDiff & { buf: Buffer },
    args: string[],
    cwd: string,
  ): Promise<{ applied: true; files: WorktreeFile[] }> {
    const grantId = checkId(input?.grantId, "grantId");
    try {
      await this.opts.consumeGrant(grantId, {
        actionId: diff.actionId,
        argumentsDigest: diff.argumentsDigest,
      });
    } catch (e) {
      throw new WorktreeError(
        "GRANT_DENIED",
        "apply needs a valid once-grant for this exact patch",
        { cause: e },
      );
    }
    try {
      await git([...args, "-"], cwd, diff.buf);
    } catch (e) {
      throw gitFailed(
        "patch apply failed after check (no partial write: git apply is atomic)",
        e,
      );
    }
    return { applied: true, files: diff.files };
  }

  private async remove(meta: Meta): Promise<void> {
    this.assertWorktreeDir(meta.dir);
    let gitError: unknown = null;
    const repo =
      meta.repoRoot && existsSync(meta.repoRoot) ? meta.repoRoot : null;
    if (repo && existsSync(meta.dir)) {
      try {
        await git(
          [
            ...this.common,
            "worktree",
            "remove",
            "--force",
            "--force",
            "--",
            meta.dir,
          ],
          repo,
        );
      } catch (e) {
        gitError = e; // locked or already detached: fall back to a plain delete
      }
    }
    try {
      // Node retries EBUSY/EPERM/ENOTEMPTY with linear backoff.
      await rm(meta.dir, {
        recursive: true,
        force: true,
        maxRetries: 6,
        retryDelay: 100,
      });
    } catch (e) {
      if (isBusy(e))
        throw new WorktreeError("WORKTREE_BUSY", "worktree files are locked", {
          cause: gitError ? new AggregateError([gitError, e]) : e,
        });
      throw e;
    }
    if (repo) await git([...this.common, "worktree", "prune"], repo);
    rmSync(`${meta.dir}.json`, { force: true });
  }

  /** Idempotent: an unknown or already-removed worktree is a no-op. */
  async discard(worktreeId: string): Promise<void> {
    const meta = this.meta(worktreeId);
    if (meta) await this.remove(meta);
  }

  list(workspaceId: string): WorktreeInfo[] {
    checkId(workspaceId, "workspaceId");
    return this.metas(this.wsDir(this.workspaceRoot(workspaceId)))
      .filter((m) => m.workspaceId === workspaceId)
      .map(({ worktreeId, workspaceId: ws, childId, baseRef, mode }) => ({
        worktreeId,
        workspaceId: ws,
        childId,
        baseRef,
        mode,
      }));
  }

  /** Startup: removes worktrees whose child is not live, and stray dirs. */
  async sweepOrphans(): Promise<{
    removed: string[];
    failed: { worktreeId: string; code: string }[];
  }> {
    const removed: string[] = [];
    const failed: { worktreeId: string; code: string }[] = [];
    if (!existsSync(this.base)) return { removed, failed };
    for (const ws of readdirSync(this.base)) {
      const wsDir = join(this.base, ws);
      if (!lstatSync(wsDir).isDirectory()) continue;
      const names = readdirSync(wsDir);
      for (const name of names) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : name;
        if (name.endsWith(".tmp") || !ID.test(id)) {
          rmSync(join(wsDir, name), { recursive: true, force: true });
          continue;
        }
        if (!name.endsWith(".json") && names.includes(`${name}.json`)) continue;
        try {
          const meta = name.endsWith(".json")
            ? this.readMeta(join(wsDir, name))
            : null;
          if (meta && this.opts.isChildLive(meta.childId)) continue;
          await this.remove(
            meta ?? ({ dir: join(wsDir, id), repoRoot: null } as Meta),
          );
          removed.push(id);
        } catch (e) {
          failed.push({
            worktreeId: id,
            code: (e as { code?: string }).code ?? "IO_ERROR",
          });
        }
      }
    }
    return { removed, failed };
  }
}
