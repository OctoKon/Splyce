// TD-43 code graph: file + top-level symbol nodes; import, definition and
// reference edges; Personalized PageRank for "related". Regex parsers only;
// import extraction is per language and honest about what it cannot see.

import { posix } from "node:path";

export interface OutlineSymbol {
  name: string;
  kind: string;
  line: number;
}

type OutlineRule = { re: RegExp; kind?: string };
const TS_RULES: OutlineRule[] = [
  {
    re: /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?<kind>function\*?|class|interface|type|enum|const|let|var|namespace)\s+(?<name>[A-Za-z_$][\w$]*)/,
  },
];
type Language = "typescript" | "javascript" | "python" | "rust" | "go";
const LANG_BY_EXT: Record<string, Language> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
};
const RULES: Record<Language, OutlineRule[]> = {
  typescript: TS_RULES,
  javascript: TS_RULES,
  python: [{ re: /^(?:async\s+)?(?<kind>def|class)\s+(?<name>\w+)/ }],
  rust: [
    {
      re: /^(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|unsafe|const|extern(?:\s+"[^"]*")?)\s+)*(?<kind>fn|struct|enum|trait|mod|type|const|static|union)\s+(?<name>\w+)/,
    },
    {
      re: /^(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?<name>[^{]+?)\s*(?:\{|where\b|$)/,
      kind: "impl",
    },
    { re: /^macro_rules!\s*(?<name>\w+)/, kind: "macro" },
  ],
  go: [
    { re: /^func\s+\([^)]*\)\s*(?<name>\w+)/, kind: "method" },
    { re: /^func\s+(?<name>\w+)/, kind: "func" },
    { re: /^type\s+(?<name>\w+)/, kind: "type" },
    { re: /^(?<kind>var|const)\s+(?<name>\w+)/ },
  ],
};

export function extOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot + 1).toLowerCase() : "";
}
export function languageOf(path: string): Language | null {
  return LANG_BY_EXT[extOf(path)] ?? null;
}

/** Top-level (column-0) symbols; null when the language is unsupported. */
export function extractSymbols(
  path: string,
  lines: readonly string[],
): OutlineSymbol[] | null {
  const lang = languageOf(path);
  if (!lang) return null;
  const symbols: OutlineSymbol[] = [];
  lines.forEach((line, i) => {
    for (const rule of RULES[lang]) {
      const m = rule.re.exec(line);
      if (!m?.groups?.name) continue;
      symbols.push({
        name: m.groups.name.trim(),
        kind: rule.kind ?? m.groups.kind!.replace("*", ""),
        line: i + 1,
      });
      break;
    }
  });
  return symbols;
}

/** Raw import specifiers; null when the language is unsupported. */
export function extractImports(path: string, text: string): string[] | null {
  const lang = languageOf(path);
  if (!lang) return null;
  const out: string[] = [];
  const all = (re: RegExp, src = text) => {
    for (const m of src.matchAll(re)) out.push(m[1]!);
  };
  if (lang === "typescript" || lang === "javascript") {
    all(
      /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"'\n]+)["']/g,
    );
    all(/\b(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g);
  } else if (lang === "python") {
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm))
      for (const part of m[1]!.split(",")) {
        const name = /^\s*([\w.]+)/.exec(part)?.[1];
        if (name) out.push(name);
      }
    for (const m of text.matchAll(
      /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\(?([^\n#)]+)/gm,
    )) {
      const mod = m[1]!;
      if (/^\.+$/.test(mod))
        for (const part of m[2]!.split(",")) {
          const name = /^\s*(\w+)/.exec(part)?.[1];
          if (name) out.push(mod + name);
        }
      else out.push(mod);
    }
  } else if (lang === "rust") {
    for (const m of text.matchAll(
      /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm,
    ))
      out.push(`mod:${m[1]!}`);
    all(
      /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+((?:crate|self|super)(?:::\w+)+)/gm,
    );
  } else {
    all(/^import[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"/gm);
    for (const m of text.matchAll(/^import[ \t]*\(([\s\S]*?)\)/gm))
      all(/"([^"]+)"/g, m[1]!);
  }
  return [...new Set(out)];
}

export interface ResolveContext {
  files: ReadonlySet<string>;
  /** `module` path from the root go.mod, if any. */
  goModule: string | null;
  goDirs: ReadonlyMap<string, string[]>;
}

const dirOf = (p: string) => {
  const d = posix.dirname(p);
  return d === "." ? "" : d;
};
const inRoot = (p: string) => (p.startsWith("../") || p === ".." ? null : p);
const joinRel = (...parts: string[]) => {
  const j = posix.normalize(posix.join(...parts.filter(Boolean)));
  return j === "." ? "" : j;
};

const TS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Resolve one specifier to indexed files (empty = external/unresolved). */
export function resolveImport(
  from: string,
  spec: string,
  ctx: ResolveContext,
): string[] {
  const lang = languageOf(from);
  const first = (cands: string[]) => {
    const hit = cands.find((c) => ctx.files.has(c));
    return hit ? [hit] : [];
  };
  if (lang === "typescript" || lang === "javascript") {
    if (!spec.startsWith(".")) return [];
    const base = inRoot(joinRel(dirOf(from), spec));
    if (base === null) return [];
    const swapped = base.replace(/\.(m|c)?js(x?)$/, ".$1ts$2");
    return first([
      base,
      swapped,
      ...TS_EXTS.map((e) => base + e),
      ...TS_EXTS.map((e) => `${base}/index${e}`),
    ]);
  }
  if (lang === "python") {
    const dots = /^\.*/.exec(spec)![0].length;
    const rest = spec.slice(dots).replace(/\./g, "/");
    const bases: string[] = [];
    if (dots > 0) {
      let d = dirOf(from);
      for (let i = 1; i < dots; i++) d = dirOf(d);
      bases.push(d);
    } else {
      // Absolute module: try every ancestor of the importing file (src layout).
      for (let d = dirOf(from); ; d = dirOf(d)) {
        bases.push(d);
        if (!d) break;
      }
    }
    for (const b of bases) {
      const p = joinRel(b, rest);
      const hit = first(
        rest ? [`${p}.py`, `${p}/__init__.py`] : [`${p}/__init__.py`],
      );
      if (hit.length) return hit;
    }
    return [];
  }
  if (lang === "rust") {
    const modDir = (f: string) =>
      ["mod.rs", "lib.rs", "main.rs"].includes(posix.basename(f))
        ? dirOf(f)
        : joinRel(dirOf(f), posix.basename(f, ".rs"));
    if (spec.startsWith("mod:")) {
      const m = spec.slice(4);
      const d = modDir(from);
      return first([joinRel(d, `${m}.rs`), joinRel(d, m, "mod.rs")]);
    }
    const [head, ...segs] = spec.split("::");
    let base: string | null;
    if (head === "crate") {
      base = null;
      for (let d = dirOf(from); ; d = dirOf(d)) {
        if (
          ctx.files.has(joinRel(d, "lib.rs")) ||
          ctx.files.has(joinRel(d, "main.rs"))
        ) {
          base = d;
          break;
        }
        if (!d) break;
      }
      if (base === null) return [];
    } else if (head === "self") base = modDir(from);
    else base = dirOf(modDir(from)); // super
    for (let n = segs.length; n > 0; n--) {
      const p = joinRel(base, ...segs.slice(0, n));
      const hit = first([`${p}.rs`, `${p}/mod.rs`]);
      if (hit.length) return hit;
    }
    return [];
  }
  if (lang === "go") {
    const mod = ctx.goModule;
    if (!mod || (spec !== mod && !spec.startsWith(`${mod}/`))) return [];
    return ctx.goDirs.get(spec === mod ? "" : spec.slice(mod.length + 1)) ?? [];
  }
  return [];
}

export interface FileFacts {
  symbols: readonly OutlineSymbol[] | null;
  imports: readonly string[] | null;
  idents: ReadonlySet<string>;
}
export interface Definition {
  path: string;
  name: string;
  kind: string;
  line: number;
}
export interface Dependencies {
  resolved: string[];
  unresolved: string[];
}
export interface CodeGraph {
  readonly deps: ReadonlyMap<string, Dependencies>;
  readonly dependents: ReadonlyMap<string, readonly string[]>;
  readonly defs: ReadonlyMap<string, readonly Definition[]>;
  /** Undirected weighted adjacency; node ids `f:<path>` / `s:<path>#<name>`. */
  readonly adj: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly degree: ReadonlyMap<string, number>;
}

const IMPORT_W = 1;
const DEF_W = 1;
const REF_W = 0.5;
const MIN_REF_NAME = 3;
/** A name defined in more files than this (`main`, `handler`) is too generic to link by reference. */
const MAX_REF_DEFS = 50;

const push = <V>(m: Map<string, V[]>, k: string, v: V) => {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
};

export const fileNode = (p: string) => `f:${p}`;
export const symbolNode = (d: { path: string; name: string }) =>
  `s:${d.path}#${d.name}`;

// ponytail: graph is rebuilt from per-file facts on every generation
// (O(files + idents)); per-file facts are only recomputed for changed files.
export function buildGraph(
  files: ReadonlyMap<string, FileFacts>,
  goModule: string | null,
): CodeGraph {
  const paths = new Set(files.keys());
  const goDirs = new Map<string, string[]>();
  for (const p of paths)
    if (p.endsWith(".go") && !p.endsWith("_test.go")) {
      const d = dirOf(p);
      push(goDirs, d, p);
    }
  const ctx: ResolveContext = { files: paths, goModule, goDirs };
  const adj = new Map<string, Map<string, number>>();
  const link = (a: string, b: string, w: number) => {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      let m = adj.get(x);
      if (!m) adj.set(x, (m = new Map()));
      m.set(y, (m.get(y) ?? 0) + w);
    }
  };
  const deps = new Map<string, Dependencies>();
  const dependents = new Map<string, string[]>();
  const defs = new Map<string, Definition[]>();
  for (const [path, f] of files) {
    adj.set(fileNode(path), adj.get(fileNode(path)) ?? new Map());
    for (const s of f.symbols ?? []) {
      const d = { path, name: s.name, kind: s.kind, line: s.line };
      push(defs, s.name, d);
      link(symbolNode(d), fileNode(path), DEF_W);
    }
    if (!f.imports) continue;
    const resolved = new Set<string>();
    const unresolved: string[] = [];
    for (const spec of f.imports) {
      const hit = resolveImport(path, spec, ctx).filter((h) => h !== path);
      if (!hit.length) unresolved.push(spec);
      for (const h of hit) resolved.add(h);
    }
    deps.set(path, { resolved: [...resolved].sort(), unresolved });
    for (const r of resolved) {
      push(dependents, r, path);
      link(fileNode(path), fileNode(r), IMPORT_W);
    }
  }
  for (const [path, f] of files)
    for (const id of f.idents) {
      if (id.length < MIN_REF_NAME) continue;
      const ds = defs.get(id);
      if (!ds || ds.length > MAX_REF_DEFS) continue;
      for (const d of ds)
        if (d.path !== path) link(fileNode(path), symbolNode(d), REF_W);
    }
  const degree = new Map<string, number>();
  for (const [n, m] of adj) {
    let t = 0;
    for (const w of m.values()) t += w;
    degree.set(n, t);
  }
  for (const list of dependents.values()) list.sort();
  return { deps, dependents, defs, adj, degree };
}

/** Personalized PageRank (power iteration) restarting at `seeds`. */
export function personalizedPageRank(
  g: CodeGraph,
  seeds: readonly string[],
  alpha = 0.15,
  iterations = 40,
): Map<string, number> {
  const restart = 1 / seeds.length;
  let rank = new Map(seeds.map((s) => [s, restart]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    const add = (n: string, v: number) => next.set(n, (next.get(n) ?? 0) + v);
    for (const s of seeds) add(s, alpha * restart);
    for (const [u, mass] of rank) {
      const out = g.adj.get(u);
      const deg = g.degree.get(u) ?? 0;
      if (!out || deg === 0) {
        for (const s of seeds) add(s, (1 - alpha) * mass * restart);
        continue;
      }
      for (const [v, w] of out) add(v, ((1 - alpha) * mass * w) / deg);
    }
    rank = next;
  }
  return rank;
}
