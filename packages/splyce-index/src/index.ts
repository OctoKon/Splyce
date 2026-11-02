// TD-43 / CTX_code_index — lexical + graph (+ optional dense) index of the
// agent's workspace. The caller (native host / engine, never the renderer)
// passes a canonical absolute workspace root and an app-data cache dir. Links
// are recorded and never followed (same rule as src/snapshots.ts); a refresh
// builds a whole new generation (text, postings, graph, vectors) and swaps it
// in one assignment, so a query never sees a half index. Stdlib only.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isSecretPath } from "../../splyce-pi/dist/secret-path.js";
export { isSecretPath } from "../../splyce-pi/dist/secret-path.js";
import {
  type Chunk,
  chunkRanges,
  chunkText,
  decodeVec,
  dot,
  type EmbeddingPort,
  embedChecked,
  encodeVec,
  reciprocalRankFusion,
} from "./dense.js";
import {
  buildGraph,
  type CodeGraph,
  type Definition,
  extOf,
  extractImports,
  extractSymbols,
  fileNode,
  languageOf,
  type OutlineSymbol,
  personalizedPageRank,
  symbolNode,
} from "./graph.js";

export type { EmbeddingPort } from "./dense.js";
export type { Definition, OutlineSymbol } from "./graph.js";

// v3: secret-shaped files are never cached; a v2 cache may hold their text.
export const CACHE_VERSION = 3;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const K1 = 1.2;
const B = 0.75;
const DENSE_CANDIDATES = 100;
const MAX_REFERENCES = 200;
const MAX_LIST = 200;
const MAX_GLOB = 256;
const DEFAULT_MAX_FILES = 50_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export class CodeIndexError extends Error {
  readonly code:
    "ROOT_NOT_CANONICAL" | "CACHE_DIR_INVALID" | "INVALID_ARGUMENT";
  constructor(code: CodeIndexError["code"], message: string) {
    super(message);
    this.name = "CodeIndexError";
    this.code = code;
  }
}

export interface IndexedLink {
  path: string;
  target: string;
}
export interface SearchInput {
  query: string;
  pathGlob?: string;
  limit?: number;
}
export interface SignalScore {
  rank: number;
  score: number;
}
export interface SearchHit {
  path: string;
  line: number;
  preview: string;
  /** BM25 score when lexical only; RRF score when dense is enabled. */
  score: number;
  signals: { bm25?: SignalScore; dense?: SignalScore };
}
export type OutlineResult =
  | {
      status: "ok";
      language: string;
      symbols: OutlineSymbol[];
      truncated?: true;
    }
  | { status: "unsupported"; language: string }
  | { status: "not_indexed" };
export type DependenciesResult =
  | {
      status: "ok";
      resolved: string[];
      unresolved: string[];
      truncated?: true;
    }
  | { status: "unsupported"; language: string }
  | { status: "not_indexed" };
export type DependentsResult =
  | { status: "ok"; dependents: string[]; truncated?: true }
  | { status: "not_indexed" };
export interface Reference {
  path: string;
  line: number;
  preview: string;
}
export interface SymbolResult {
  definitions: Definition[];
  references: Reference[];
  truncated: boolean;
}
export interface RelatedNode {
  kind: "file" | "symbol";
  path: string;
  name?: string;
  line?: number;
  score: number;
}
export type RelatedResult =
  { status: "ok"; results: RelatedNode[] } | { status: "not_found" };
export interface RefreshReport {
  reindexed: string[];
  removed: string[];
  reused: number;
  skipped: string[];
  links: readonly IndexedLink[];
  /** Chunks sent to the embedding port in this refresh. */
  embedded: number;
  /** True when the file cap stopped indexing before every candidate. */
  truncated: boolean;
}
export type CacheLoad = "loaded" | "absent" | "discarded";

interface FileDoc {
  readonly mtimeMs: number;
  readonly size: number;
  readonly text: string;
  readonly lines: readonly string[];
  readonly tf: ReadonlyMap<string, number>;
  readonly len: number;
  readonly symbols: readonly OutlineSymbol[] | null;
  readonly imports: readonly string[] | null;
  readonly idents: ReadonlySet<string>;
}
interface DenseState {
  readonly modelId: string;
  readonly dimensions: number;
  readonly chunks: ReadonlyMap<string, readonly Chunk[]>;
}
interface Generation {
  readonly files: ReadonlyMap<string, FileDoc>;
  readonly postings: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly avgLen: number;
  readonly links: readonly IndexedLink[];
  readonly graph: CodeGraph;
  readonly dense: DenseState | null;
}

/** Words plus their camelCase / snake_case parts, lowercased. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) {
    const lower = m[0].toLowerCase();
    out.push(lower);
    for (const part of m[0].split(
      /_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/,
    )) {
      const p = part.toLowerCase();
      if (p && p !== lower) out.push(p);
    }
  }
  return out;
}

function segMatch(p: string, s: string): boolean {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    const c = p[pi];
    if (c === "*") {
      star = pi++;
      mark = si;
    } else if (pi < p.length && (c === "?" || c === s[si])) {
      pi++;
      si++;
    } else if (star >= 0) {
      pi = star + 1;
      si = ++mark;
    } else return false;
  }
  while (p[pi] === "*") pi++;
  return pi === p.length;
}

/**
 * `*` within a segment, `**` (a whole segment) across segments, `?` one char.
 * Matches segment by segment with greedy last-star backtracking: no regular
 * expression, so no catastrophic backtracking; cost is polynomial in the
 * (capped) glob and path lengths.
 */
export function globMatcher(glob: string): (path: string) => boolean {
  if (glob.length > MAX_GLOB)
    throw new CodeIndexError(
      "INVALID_ARGUMENT",
      `glob must be at most ${String(MAX_GLOB)} characters`,
    );
  const segs: string[] = [];
  for (const raw of glob.split("/")) {
    const seg = /^\*{2,}$/.test(raw) ? "**" : raw.replace(/\*+/g, "*");
    if (seg !== "**" || segs.at(-1) !== "**") segs.push(seg);
  }
  return (path) => {
    const ps = path.split("/");
    let gi = 0;
    let pi = 0;
    let star = -1;
    let mark = 0;
    while (pi < ps.length) {
      const g = segs[gi];
      if (g === "**") {
        star = gi++;
        mark = pi;
      } else if (g !== undefined && segMatch(g, ps[pi]!)) {
        gi++;
        pi++;
      } else if (star >= 0) {
        gi = star + 1;
        pi = ++mark;
      } else return false;
    }
    while (segs[gi] === "**") gi++;
    return gi === segs.length;
  };
}

const PEM_PRIVATE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

function makeDoc(
  path: string,
  text: string,
  mtimeMs: number,
  size: number,
): FileDoc {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const lines = text.split(/\r?\n/);
  return {
    mtimeMs,
    size,
    text,
    lines,
    tf,
    len: tokens.length,
    symbols: extractSymbols(path, lines),
    imports: extractImports(path, text),
    idents: new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []),
  };
}

// ponytail: postings and graph are reassembled from per-file facts on every
// generation (O(total terms + idents)); only changed files are re-read and
// re-parsed. Patch them incrementally if very large workspaces need it.
function finalize(
  files: ReadonlyMap<string, FileDoc>,
  links: readonly IndexedLink[],
  dense: DenseState | null,
): Generation {
  const postings = new Map<string, Map<string, number>>();
  let total = 0;
  for (const [path, doc] of files) {
    total += doc.len;
    for (const [t, f] of doc.tf) {
      let post = postings.get(t);
      if (!post) postings.set(t, (post = new Map()));
      post.set(path, f);
    }
  }
  const goModule =
    /^module\s+(\S+)/m.exec(files.get("go.mod")?.text ?? "")?.[1] ?? null;
  return Object.freeze({
    files,
    postings,
    avgLen: files.size ? total / files.size : 0,
    links: Object.freeze([...links]),
    graph: buildGraph(files, goModule),
    dense,
  });
}

function canonicalRoot(root: unknown): string {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root)
    throw new CodeIndexError(
      "ROOT_NOT_CANONICAL",
      "root must be a canonical absolute path",
    );
  let real: string;
  try {
    real = realpathSync.native(root);
  } catch {
    throw new CodeIndexError("ROOT_NOT_CANONICAL", "root does not exist");
  }
  const same =
    process.platform === "win32"
      ? real.toLowerCase() === root.toLowerCase()
      : real === root;
  if (!same || !lstatSync(root).isDirectory())
    throw new CodeIndexError(
      "ROOT_NOT_CANONICAL",
      "root must be a canonical directory (no links)",
    );
  return root;
}

const lstatOrNull = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null; // vanished between listing and stat: not a candidate
  }
};

interface Candidate {
  rel: string;
  size: number;
  mtimeMs: number;
}

/** `git ls-files` when the root is in a work tree; null otherwise. */
function gitList(root: string): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1 << 28,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    return out.split("\0").filter(Boolean);
  } catch {
    return null; // not a git work tree (or git absent): root .gitignore fallback
  }
}

// ponytail: non-git fallback honours only the root .gitignore, without `!`
// negation; git work trees use git's own matcher.
function rootIgnore(root: string): (rel: string, dir: boolean) => boolean {
  const file = join(root, ".gitignore");
  const rules = (existsSync(file) ? readFileSync(file, "utf8") : "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l && l.length <= MAX_GLOB && !l.startsWith("#") && !l.startsWith("!"),
    )
    .map((l) => {
      const dirOnly = l.endsWith("/");
      let p = dirOnly ? l.slice(0, -1) : l;
      const anchored = p.includes("/");
      if (p.startsWith("/")) p = p.slice(1);
      return { dirOnly, anchored, match: globMatcher(p) };
    });
  return (rel, dir) =>
    rules.some(
      (r) =>
        (!r.dirOnly || dir) &&
        r.match(r.anchored ? rel : rel.slice(rel.lastIndexOf("/") + 1)),
    );
}

/**
 * Workspace-relative files the index would list (gitignore-aware, links never
 * followed) minus secret-shaped paths; the TD-70 non-git snapshot source.
 */
export function listWorkspaceFiles(root: string): string[] {
  return listCandidates(canonicalRoot(root))
    .files.map((f) => f.rel)
    .filter((rel) => !isSecretPath(rel));
}

function listCandidates(root: string): {
  files: Candidate[];
  links: IndexedLink[];
} {
  const files: Candidate[] = [];
  const links: IndexedLink[] = [];
  const classify = (rel: string, st: Stats) => {
    if (st.isSymbolicLink())
      links.push({ path: rel, target: readlinkSync(join(root, rel)) });
    else if (st.isFile())
      files.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
  };
  const listed = gitList(root);
  if (listed) {
    // A listed path under a link (git may list through a junction) is never
    // read: every ancestor directory is lstat'ed once.
    const dirOk = new Map<string, boolean>([["", true]]);
    const okDir = (rel: string): boolean => {
      const known = dirOk.get(rel);
      if (known !== undefined) return known;
      const cut = rel.lastIndexOf("/");
      let ok = okDir(cut < 0 ? "" : rel.slice(0, cut));
      if (ok) {
        const st = lstatOrNull(join(root, rel));
        if (st?.isSymbolicLink()) {
          classify(rel, st);
          ok = false;
        } else ok = st?.isDirectory() ?? false;
      }
      dirOk.set(rel, ok);
      return ok;
    };
    for (const rel of listed) {
      const cut = rel.lastIndexOf("/");
      if (!okDir(cut < 0 ? "" : rel.slice(0, cut))) continue;
      const st = lstatOrNull(join(root, rel));
      if (st) classify(rel, st);
    }
  } else {
    const ignored = rootIgnore(root);
    const walk = (dir: string, prefix: string) => {
      for (const name of readdirSync(dir)) {
        if (name === ".git") continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        const st = lstatOrNull(join(dir, name));
        if (!st || ignored(rel, st.isDirectory())) continue;
        if (st.isDirectory()) walk(join(dir, name), rel);
        else classify(rel, st);
      }
    };
    walk(root, "");
  }
  return { files, links };
}

interface CacheChunk {
  start: number;
  end: number;
  vec: string;
}
interface CacheFile {
  version: number;
  root: string;
  files: { path: string; mtimeMs: number; size: number; text: string }[];
  dense?: {
    modelId: string;
    dimensions: number;
    files: { path: string; chunks: CacheChunk[] }[];
  };
}

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

function loadCache(
  file: string,
  root: string,
  port: EmbeddingPort | null,
): {
  status: CacheLoad;
  files: Map<string, FileDoc>;
  dense: DenseState | null;
} {
  const files = new Map<string, FileDoc>();
  const empty = (status: CacheLoad) => ({
    status,
    files: new Map<string, FileDoc>(),
    dense: null,
  });
  if (!existsSync(file)) return empty("absent");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return empty("discarded"); // corrupt: rebuild from source
  }
  const c = raw as Partial<CacheFile> | null;
  if (
    !c ||
    c.version !== CACHE_VERSION ||
    c.root !== root ||
    !Array.isArray(c.files) ||
    !c.files.every(
      (f) =>
        f &&
        typeof f.path === "string" &&
        isNum(f.mtimeMs) &&
        isNum(f.size) &&
        typeof f.text === "string",
    )
  )
    return empty("discarded");
  // Cached entries are only reused for paths the next walk lists with the
  // same mtime+size, so the cache cannot introduce a path.
  for (const f of c.files)
    files.set(f.path, makeDoc(f.path, f.text, f.mtimeMs, f.size));
  // Vectors are reused only under the same model stamp; anything else
  // (no port, other model/dims, malformed vectors) is re-embedded.
  let dense: DenseState | null = null;
  const d = c.dense;
  if (
    port &&
    d &&
    d.modelId === port.modelId &&
    d.dimensions === port.dimensions &&
    Array.isArray(d.files)
  ) {
    const chunks = new Map<string, Chunk[]>();
    for (const f of d.files) {
      if (!f || typeof f.path !== "string" || !Array.isArray(f.chunks))
        return empty("discarded");
      const list: Chunk[] = [];
      for (const ch of f.chunks) {
        const vec =
          ch && isNum(ch.start) && isNum(ch.end) && typeof ch.vec === "string"
            ? decodeVec(ch.vec, d.dimensions)
            : null;
        if (!vec) return empty("discarded");
        list.push({ start: ch.start, end: ch.end, vec });
      }
      chunks.set(f.path, list);
    }
    dense = { modelId: d.modelId, dimensions: d.dimensions, chunks };
  }
  return { status: "loaded", files, dense };
}

const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new CodeIndexError(
      "INVALID_ARGUMENT",
      `${what} must be 1-${String(max)} characters`,
    );
  return v.trim();
};
const intIn = (v: unknown, dflt: number, max: number, what: string): number => {
  const n = v ?? dflt;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > max)
    throw new CodeIndexError(
      "INVALID_ARGUMENT",
      `${what} must be an integer 1-${String(max)}`,
    );
  return n as number;
};
const relPath = (v: unknown) => str(v, 1024, "path").replace(/\\/g, "/");

export interface CodeIndexOptions {
  /** Canonical absolute workspace root, supplied by native/engine. */
  root: string;
  /** Absolute cache directory under app data. */
  cacheDir: string;
  maxFileBytes?: number;
  /** Most files indexed (default 50 000); the rest are left out and flagged. */
  maxFiles?: number;
  /** Enables the dense signal; absent = lexical + graph only. */
  embedding?: EmbeddingPort;
}

export class CodeIndex {
  readonly root: string;
  readonly cacheFile: string;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  /** What happened to the persisted cache when this index was opened. */
  readonly cacheLoad: CacheLoad;
  readonly #port: EmbeddingPort | null;
  #gen: Generation;
  #truncated = false;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    root: string,
    cacheFile: string,
    maxFileBytes: number,
    maxFiles: number,
    port: EmbeddingPort | null,
    loaded: ReturnType<typeof loadCache>,
  ) {
    this.root = root;
    this.cacheFile = cacheFile;
    this.maxFileBytes = maxFileBytes;
    this.maxFiles = maxFiles;
    this.#port = port;
    this.cacheLoad = loaded.status;
    this.#gen = finalize(loaded.files, [], loaded.dense);
  }

  static async open(options: CodeIndexOptions): Promise<CodeIndex> {
    const root = canonicalRoot(options.root);
    if (typeof options.cacheDir !== "string" || !isAbsolute(options.cacheDir))
      throw new CodeIndexError(
        "CACHE_DIR_INVALID",
        "cacheDir must be absolute",
      );
    const port = options.embedding ?? null;
    if (
      port &&
      (!port.modelId ||
        !Number.isInteger(port.dimensions) ||
        port.dimensions < 1)
    )
      throw new CodeIndexError(
        "INVALID_ARGUMENT",
        "embedding port needs a modelId and positive dimensions",
      );
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    if (!Number.isInteger(maxFiles) || maxFiles < 1)
      throw new CodeIndexError(
        "INVALID_ARGUMENT",
        "maxFiles must be a positive integer",
      );
    mkdirSync(options.cacheDir, { recursive: true });
    const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
    const cacheFile = join(options.cacheDir, `code-index-${key}.json`);
    const index = new CodeIndex(
      root,
      cacheFile,
      maxFileBytes,
      maxFiles,
      port,
      loadCache(cacheFile, root, port),
    );
    await index.refresh();
    return index;
  }

  get links(): readonly IndexedLink[] {
    return this.#gen.links;
  }
  /** True when the last refresh hit `maxFiles` and left files out. */
  get truncated(): boolean {
    return this.#truncated;
  }
  get fileCount(): number {
    return this.#gen.files.size;
  }
  /** Model stamp of the vectors in the live generation, or null. */
  get denseModel(): { modelId: string; dimensions: number } | null {
    const d = this.#gen.dense;
    return d ? { modelId: d.modelId, dimensions: d.dimensions } : null;
  }

  /** Re-index changed files, drop deleted ones, then swap generations. */
  refresh(): Promise<RefreshReport> {
    const run = this.#queue.then(() => this.#refresh());
    this.#queue = run.catch(() => undefined); // the caller still sees `run` reject
    return run;
  }

  async #refresh(): Promise<RefreshReport> {
    const old = this.#gen;
    const { files, links } = listCandidates(this.root);
    const next = new Map<string, FileDoc>();
    const reindexed: string[] = [];
    const skipped: string[] = [];
    let reused = 0;
    let truncated = false;
    for (const { rel, size, mtimeMs } of files) {
      if (isSecretPath(rel)) {
        skipped.push(rel); // by name: never read
        continue;
      }
      if (next.size >= this.maxFiles) {
        truncated = true;
        break;
      }
      if (size > this.maxFileBytes) {
        skipped.push(rel);
        continue;
      }
      // ponytail: mtime+size change detection; add a content hash if a
      // same-size same-mtime edit ever matters.
      const prev = old.files.get(rel);
      if (prev && prev.mtimeMs === mtimeMs && prev.size === size) {
        next.set(rel, prev);
        reused++;
        continue;
      }
      let buf: Buffer;
      try {
        buf = await readFile(join(this.root, rel));
      } catch {
        skipped.push(rel); // vanished or unreadable since listing
        continue;
      }
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        skipped.push(rel);
        continue;
      }
      const text = buf.toString("utf8");
      if (PEM_PRIVATE.test(text)) {
        skipped.push(rel); // private key material under an innocent name
        continue;
      }
      next.set(rel, makeDoc(rel, text, mtimeMs, size));
      reindexed.push(rel);
    }
    const removed = [...old.files.keys()].filter((p) => !next.has(p));
    const { dense, embedded } = await this.#embed(old, next);
    this.#gen = finalize(next, links, dense); // atomic cutover
    this.#truncated = truncated;
    this.#save();
    return {
      reindexed,
      removed,
      reused,
      skipped,
      links: this.#gen.links,
      embedded,
      truncated,
    };
  }

  async #embed(
    old: Generation,
    next: ReadonlyMap<string, FileDoc>,
  ): Promise<{ dense: DenseState | null; embedded: number }> {
    const port = this.#port;
    if (!port) return { dense: null, embedded: 0 };
    const reuse =
      old.dense?.modelId === port.modelId &&
      old.dense.dimensions === port.dimensions
        ? old.dense
        : null;
    const chunks = new Map<string, readonly Chunk[]>();
    const added = new Map<string, Chunk[]>();
    const pending: {
      path: string;
      start: number;
      end: number;
      text: string;
    }[] = [];
    for (const [path, doc] of next) {
      const kept =
        old.files.get(path) === doc ? reuse?.chunks.get(path) : undefined;
      if (kept) {
        chunks.set(path, kept);
        continue;
      }
      for (const r of chunkRanges(doc.lines, doc.symbols))
        pending.push({ path, ...r, text: chunkText(path, doc.lines, r) });
    }
    const vecs = await embedChecked(
      port,
      pending.map((p) => p.text),
    );
    pending.forEach((p, i) => {
      const c = { start: p.start, end: p.end, vec: vecs[i]! };
      const list = added.get(p.path);
      if (list) list.push(c);
      else added.set(p.path, [c]);
    });
    for (const [path, list] of added) chunks.set(path, list);
    return {
      dense: { modelId: port.modelId, dimensions: port.dimensions, chunks },
      embedded: pending.length,
    };
  }

  #save(): void {
    const g = this.#gen;
    const body: CacheFile = {
      version: CACHE_VERSION,
      root: this.root,
      files: [...g.files].map(([path, d]) => ({
        path,
        mtimeMs: d.mtimeMs,
        size: d.size,
        text: d.text,
      })),
    };
    if (g.dense)
      body.dense = {
        modelId: g.dense.modelId,
        dimensions: g.dense.dimensions,
        files: [...g.dense.chunks].map(([path, list]) => ({
          path,
          chunks: list.map((c) => ({
            start: c.start,
            end: c.end,
            vec: encodeVec(c.vec),
          })),
        })),
      };
    const tmp = `${this.cacheFile}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(body));
    renameSync(tmp, this.cacheFile);
  }

  /**
   * BM25 over files, fused by RRF with dense chunk cosine when an embedding
   * port is configured. `"quoted"` parts are required exact phrases.
   */
  async search(input: SearchInput): Promise<SearchHit[]> {
    const g = this.#gen; // one generation for the whole query
    const i = input as Partial<SearchInput> | null;
    if (!i || typeof i !== "object")
      throw new CodeIndexError(
        "INVALID_ARGUMENT",
        "search input must be an object",
      );
    const query = str(i.query, 512, "query");
    const glob =
      i.pathGlob === undefined
        ? null
        : globMatcher(str(i.pathGlob, MAX_GLOB, "pathGlob"));
    const limit = intIn(i.limit, DEFAULT_LIMIT, MAX_LIMIT, "limit");
    const phrases = [...query.matchAll(/"([^"]+)"/g)].map((m) =>
      m[1]!.toLowerCase(),
    );
    const terms = [...new Set(tokenize(query.replace(/"/g, " ")))];
    const allowed = (path: string) => {
      if (glob && !glob(path)) return false;
      if (!phrases.length) return true;
      const text = g.files.get(path)!.text.toLowerCase();
      return phrases.every((p) => text.includes(p));
    };

    const n = g.files.size;
    const scores = new Map<string, number>();
    for (const t of terms) {
      const post = g.postings.get(t);
      if (!post) continue;
      const idf = Math.log(1 + (n - post.size + 0.5) / (post.size + 0.5));
      for (const [path, f] of post) {
        const d = g.files.get(path)!;
        const s =
          (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / g.avgLen));
        scores.set(path, (scores.get(path) ?? 0) + s);
      }
    }
    const byScore = (a: [string, number], b: [string, number]) =>
      b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
    const lexical = [...scores].filter(([p]) => allowed(p)).sort(byScore);

    const denseBest = new Map<string, { score: number; line: number }>();
    if (this.#port && g.dense) {
      const [q] = await embedChecked(this.#port, [query]);
      for (const [path, list] of g.dense.chunks) {
        if (!g.files.has(path) || !allowed(path)) continue;
        for (const c of list) {
          const s = dot(q!, c.vec);
          if (s > 0 && s > (denseBest.get(path)?.score ?? 0))
            denseBest.set(path, { score: s, line: c.start });
        }
      }
    }
    const dense = [...denseBest]
      .map(([p, v]) => [p, v.score] as [string, number])
      .sort(byScore)
      .slice(0, DENSE_CANDIDATES);

    const hit = (
      path: string,
      score: number,
      signals: SearchHit["signals"],
    ): SearchHit => {
      const d = g.files.get(path)!;
      const li = signals.bm25
        ? bestLine(d.lines, terms, phrases)
        : (denseBest.get(path)?.line ?? 1) - 1;
      return {
        path,
        line: li + 1,
        preview: d.lines[li] ?? "",
        score,
        signals,
      };
    };
    const round = (x: number) => Math.round(x * 1e6) / 1e6;
    if (!this.#port)
      return lexical
        .slice(0, limit)
        .map(([p, s], r) =>
          hit(p, round(s), { bm25: { rank: r + 1, score: round(s) } }),
        );
    const lexScore = new Map(lexical);
    const fused = reciprocalRankFusion({
      bm25: lexical.map(([p]) => p),
      dense: dense.map(([p]) => p),
    });
    return [...fused]
      .sort((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([path, f]) => {
        const signals: SearchHit["signals"] = {};
        if (f.ranks.bm25)
          signals.bm25 = {
            rank: f.ranks.bm25,
            score: round(lexScore.get(path)!),
          };
        if (f.ranks.dense)
          signals.dense = {
            rank: f.ranks.dense,
            score: round(denseBest.get(path)!.score),
          };
        return hit(path, round(f.score), signals);
      });
  }

  /** Top-level symbols for an indexed file (path relative to root). */
  outline(path: unknown): OutlineResult {
    const rel = relPath(path);
    // Lookup only: never touches the filesystem, so it cannot escape the root.
    const doc = this.#gen.files.get(rel);
    if (!doc) return { status: "not_indexed" };
    if (!doc.symbols)
      return { status: "unsupported", language: extOf(rel) || "none" };
    const symbols = doc.symbols.slice(0, MAX_LIST);
    return {
      status: "ok",
      language: languageOf(rel)!,
      symbols,
      ...(symbols.length < doc.symbols.length
        ? { truncated: true as const }
        : {}),
    };
  }

  /** Indexed files this file imports, plus specifiers that did not resolve. */
  dependencies(path: unknown): DependenciesResult {
    const rel = relPath(path);
    const g = this.#gen;
    if (!g.files.has(rel)) return { status: "not_indexed" };
    const d = g.graph.deps.get(rel);
    if (!d) return { status: "unsupported", language: extOf(rel) || "none" };
    const resolved = d.resolved.slice(0, MAX_LIST);
    const unresolved = d.unresolved.slice(0, MAX_LIST);
    return {
      status: "ok",
      resolved,
      unresolved,
      ...(resolved.length < d.resolved.length ||
      unresolved.length < d.unresolved.length
        ? { truncated: true as const }
        : {}),
    };
  }

  /** Indexed files that import this file. */
  dependents(path: unknown): DependentsResult {
    const rel = relPath(path);
    const g = this.#gen;
    if (!g.files.has(rel)) return { status: "not_indexed" };
    const all = g.graph.dependents.get(rel) ?? [];
    const dependents = all.slice(0, MAX_LIST);
    return {
      status: "ok",
      dependents,
      ...(dependents.length < all.length ? { truncated: true as const } : {}),
    };
  }

  /** Top-level definitions of `name` and whole-identifier references to it. */
  symbol(name: unknown): SymbolResult {
    const id = str(name, 256, "name");
    const g = this.#gen;
    const allDefs = g.graph.defs.get(id) ?? [];
    const definitions = allDefs.slice(0, MAX_LIST);
    const defLines = new Set(
      definitions.map((d) => `${d.path}:${String(d.line)}`),
    );
    const re = new RegExp(
      `(?<![\\w$])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`,
    );
    const references: Reference[] = [];
    let truncated = definitions.length < allDefs.length;
    for (const [path, doc] of [...g.files].sort((a, b) =>
      a[0] < b[0] ? -1 : 1,
    )) {
      if (!doc.idents.has(id)) continue;
      doc.lines.forEach((l, i) => {
        if (
          truncated ||
          !re.test(l) ||
          defLines.has(`${path}:${String(i + 1)}`)
        )
          return;
        if (references.length === MAX_REFERENCES) truncated = true;
        else
          references.push({
            path,
            line: i + 1,
            preview: l,
          });
      });
    }
    return { definitions, references, truncated };
  }

  /**
   * Personalized PageRank over the code graph seeded at a file path or at
   * every definition of a symbol name.
   */
  related(target: unknown, limit?: unknown): RelatedResult {
    const t = str(target, 1024, "target").replace(/\\/g, "/");
    const max = intIn(limit, DEFAULT_LIMIT, MAX_LIMIT, "limit");
    const g = this.#gen;
    const seeds = g.files.has(t)
      ? [fileNode(t)]
      : (g.graph.defs.get(t) ?? []).map((d) => symbolNode(d));
    if (!seeds.length) return { status: "not_found" };
    const skip = new Set(seeds);
    const results = [...personalizedPageRank(g.graph, seeds)]
      .filter(([node, s]) => !skip.has(node) && s > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, max)
      .map(([node, s]): RelatedNode => {
        const score = Math.round(s * 1e6) / 1e6;
        if (node.startsWith("f:"))
          return { kind: "file", path: node.slice(2), score };
        const body = node.slice(2);
        const hash = body.lastIndexOf("#");
        const path = body.slice(0, hash);
        const name = body.slice(hash + 1);
        const line = g.graph.defs.get(name)?.find((d) => d.path === path)?.line;
        return line === undefined
          ? { kind: "symbol", path, name, score }
          : { kind: "symbol", path, name, line, score };
      });
    return { status: "ok", results };
  }
}

function bestLine(
  lines: readonly string[],
  terms: string[],
  phrases: string[],
): number {
  if (phrases.length) {
    const i = lines.findIndex((l) => l.toLowerCase().includes(phrases[0]!));
    if (i >= 0) return i;
  }
  let best = 0;
  let bestHits = 0;
  lines.forEach((l, i) => {
    const toks = new Set(tokenize(l));
    const hits = terms.filter((t) => toks.has(t)).length;
    if (hits > bestHits) {
      best = i;
      bestHits = hits;
    }
  });
  return best;
}

export interface CodeIndexTool {
  name: string;
  description: string;
  readOnly: true;
  /** JSON Schema for the model-supplied arguments. */
  parameters: Record<string, unknown>;
  execute(
    args: unknown,
    prepareOutput?: (value: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

/**
 * Keeps a tool response under MAX_OUTPUT_BYTES by halving its longest array
 * until it fits, flagging `truncated`; adds `indexTruncated` when the index
 * hit its file cap.
 */
function capOutput(result: unknown, indexTruncated: boolean): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return result;
  const out: Record<string, unknown> = {
    ...(result as Record<string, unknown>),
  };
  if (indexTruncated) out.indexTruncated = true;
  while (Buffer.byteLength(JSON.stringify(out)) > MAX_OUTPUT_BYTES) {
    let key: string | null = null;
    let len = 0;
    for (const [k, v] of Object.entries(out))
      if (Array.isArray(v) && v.length > len) [key, len] = [k, v.length];
    if (key === null) break; // nothing left to trim
    out[key] = (out[key] as unknown[]).slice(0, len >> 1);
    out.truncated = true;
  }
  return out;
}

const obj = (args: unknown): Record<string, unknown> => {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new CodeIndexError(
      "INVALID_ARGUMENT",
      "tool arguments must be an object",
    );
  return args as Record<string, unknown>;
};
const schema = (required: string[], properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});
const PATH = { type: "string", minLength: 1, maxLength: 1024 };

/**
 * Read-only agent tools over one workspace index. Each call refreshes first
 * (incremental), so results reflect the agent's own edits.
 */
// ponytail: refresh-per-call (git ls-files + lstat); add a watcher if
// latency on very large workspaces matters.
export function codeIndexTools(index: CodeIndex): readonly CodeIndexTool[] {
  const tool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (a: Record<string, unknown>) => unknown,
  ): CodeIndexTool => ({
    name,
    description,
    readOnly: true,
    parameters,
    async execute(args, prepareOutput) {
      const a = obj(args);
      await index.refresh();
      const value = await run(a);
      // Prepare complete previews before the structured output cap can discard hits.
      return capOutput(
        prepareOutput ? await prepareOutput(value) : value,
        index.truncated,
      );
    },
  });
  return Object.freeze([
    tool(
      "code_search",
      'Search the workspace by identifiers and words (camelCase/snake_case aware, BM25; fused with semantic search when enabled). Wrap text in "double quotes" to require an exact phrase; pathGlob filters paths relative to the workspace root (e.g. "src/**/*.ts").',
      schema(["query"], {
        query: { type: "string", minLength: 1, maxLength: 512 },
        pathGlob: { type: "string", minLength: 1, maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      }),
      async (a) => ({
        results: await index.search(a as unknown as SearchInput),
      }),
    ),
    tool(
      "code_outline",
      "List top-level symbols of a workspace file (path relative to the root). Supports ts/js/py/rs/go; other files report unsupported.",
      schema(["path"], { path: PATH }),
      (a) => index.outline(a.path),
    ),
    tool(
      "code_related",
      "Files and symbols most related to a file path or symbol name, ranked by Personalized PageRank over imports, definitions and references.",
      schema(["target"], {
        target: PATH,
        limit: { type: "integer", minimum: 1, maximum: 200 },
      }),
      (a) => index.related(a.target, a.limit),
    ),
    tool(
      "code_dependencies",
      "Workspace files a file imports, plus import specifiers that are external or unresolved.",
      schema(["path"], { path: PATH }),
      (a) => index.dependencies(a.path),
    ),
    tool(
      "code_dependents",
      "Workspace files that import the given file.",
      schema(["path"], { path: PATH }),
      (a) => index.dependents(a.path),
    ),
    tool(
      "code_symbol",
      "Top-level definitions of a symbol name and the lines that reference it.",
      schema(["name"], {
        name: { type: "string", minLength: 1, maxLength: 256 },
      }),
      (a) => index.symbol(a.name),
    ),
  ]);
}
