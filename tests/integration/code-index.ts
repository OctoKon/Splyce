// TD-43 / CTX_code_index — workspace code index on real fixture trees.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CACHE_VERSION,
  CodeIndex,
  codeIndexTools,
} from "../../packages/splyce-index/dist/index.js";

const tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "td43-index-")));
let counter = 0;
const fresh = (files: Record<string, string | Buffer>, git = false) => {
  counter += 1;
  const base = join(tmpRoot, `t${String(counter)}`);
  const root = join(base, "ws");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  mkdirSync(root, { recursive: true });
  if (git) execFileSync("git", ["init", "-q"], { cwd: root });
  return { root, cache: join(base, "cache"), base };
};
const paths = async (index: CodeIndex, query: string) =>
  (await index.search({ query })).map((h) => h.path);

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

test("gitignore is respected; binaries and oversized files are skipped", async () => {
  for (const git of [true, false]) {
    const { root, cache } = fresh(
      {
        ".gitignore": "dist/\n*.log\n",
        "src/a.ts": "export const zebraToken = 1;\n",
        "dist/out.js": "zebraToken\n",
        "build.log": "zebraToken\n",
        "img.bin": Buffer.from([
          0x7a,
          0,
          0x01,
          0x02,
          ...Buffer.from(" zebraToken"),
        ]),
        "big.txt": `zebraToken ${"x".repeat(5000)}`,
      },
      git,
    );
    const index = await CodeIndex.open({
      root,
      cacheDir: cache,
      maxFileBytes: 4096,
    });
    assert.deepEqual(
      await paths(index, "zebraToken"),
      ["src/a.ts"],
      `git=${String(git)}`,
    );
  }
});

test("an escaping junction/symlink is recorded as a link and never followed", async () => {
  for (const git of [true, false]) {
    const { root, cache, base } = fresh(
      { "inside.ts": "const ok = 1;\n" },
      git,
    );
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.ts"), "const outsideCanary = 1;\n");
    symlinkSync(outside, join(root, "escape"), "junction");
    const index = await CodeIndex.open({ root, cacheDir: cache });
    assert.deepEqual(
      await paths(index, "outsideCanary"),
      [],
      `git=${String(git)}`,
    );
    assert.deepEqual(
      index.links.map((l) => l.path),
      ["escape"],
    );
    assert.equal(index.outline("escape/secret.ts").status, "not_indexed");
  }
});

test("root must be canonical and absolute", async () => {
  const { root, cache } = fresh({ "a.ts": "x" });
  for (const bad of ["ws", `${root}\\..\\ws`, join(root, "missing")])
    await assert.rejects(CodeIndex.open({ root: bad, cacheDir: cache }), {
      code: "ROOT_NOT_CANONICAL",
    });
});

test("incremental refresh re-reads only changes and drops deleted files", async () => {
  const { root, cache } = fresh({
    "keep.ts": "const keepAlpha = 1;\n",
    "edit.ts": "const beforeBravo = 1;\n",
    "gone.ts": "const deletedCharlie = 1;\n",
  });
  const index = await CodeIndex.open({ root, cacheDir: cache });
  assert.deepEqual(await paths(index, "deletedCharlie"), ["gone.ts"]);
  writeFileSync(join(root, "edit.ts"), "const afterDelta = 22;\n");
  utimesSync(join(root, "edit.ts"), new Date(), new Date(Date.now() + 5000));
  rmSync(join(root, "gone.ts"));
  writeFileSync(join(root, "added.ts"), "const addedEcho = 1;\n");
  const report = await index.refresh();
  assert.deepEqual(report.reindexed.sort(), ["added.ts", "edit.ts"]);
  assert.deepEqual(report.removed, ["gone.ts"]);
  assert.equal(report.reused, 1);
  assert.deepEqual(await paths(index, "deletedCharlie"), []);
  assert.deepEqual(await paths(index, "beforeBravo"), []);
  assert.deepEqual(await paths(index, "afterDelta"), ["edit.ts"]);
  assert.deepEqual(await paths(index, "addedEcho"), ["added.ts"]);
  // Persisted: a reopened index reuses everything from cache.
  const reopened = await CodeIndex.open({ root, cacheDir: cache });
  assert.equal(reopened.cacheLoad, "loaded");
  assert.deepEqual(await paths(reopened, "afterDelta"), ["edit.ts"]);
  assert.deepEqual((await reopened.refresh()).reindexed, []);
});

test("atomic cutover: concurrent queries see the old or new generation, never half", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 60; i++)
    files[`f${String(i)}.ts`] = "const oldKilo = 1;\n";
  const { root, cache } = fresh(files);
  const index = await CodeIndex.open({ root, cacheDir: cache });
  for (let i = 0; i < 60; i++) {
    writeFileSync(join(root, `f${String(i)}.ts`), "const newLima = 2;;\n");
  }
  const seen = new Set<string>();
  let done = false;
  const refreshing = index.refresh().then(() => (done = true));
  while (!done) {
    const oldN = (await index.search({ query: "oldKilo", limit: 100 })).length;
    const newN = (await index.search({ query: "newLima", limit: 100 })).length;
    seen.add(`${String(oldN)}/${String(newN)}`);
    await new Promise((r) => setImmediate(r));
  }
  await refreshing;
  seen.add(
    `${String((await index.search({ query: "oldKilo", limit: 100 })).length)}/${String((await index.search({ query: "newLima", limit: 100 })).length)}`,
  );
  assert.ok(
    seen.size >= 2,
    `queries interleaved with refresh: ${[...seen].join(",")}`,
  );
  for (const s of seen)
    assert.ok(s === "60/0" || s === "0/60", `half index seen: ${s}`);
});

test("corrupt or version-mismatched cache is discarded and rebuilt", async () => {
  const { root, cache } = fresh({ "a.ts": "const realYankee = 1;\n" });
  const first = await CodeIndex.open({ root, cacheDir: cache });
  const file = first.cacheFile;
  writeFileSync(file, "{not json");
  const rebuilt = await CodeIndex.open({ root, cacheDir: cache });
  assert.equal(rebuilt.cacheLoad, "discarded");
  assert.deepEqual(await paths(rebuilt, "realYankee"), ["a.ts"]);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, CACHE_VERSION);
  // A stale-version cache whose entry matches mtime+size must not be reused.
  const valid = JSON.parse(readFileSync(file, "utf8"));
  valid.version = CACHE_VERSION + 1;
  valid.files[0].text = "const ghostZulu = 1;";
  writeFileSync(file, JSON.stringify(valid));
  const again = await CodeIndex.open({ root, cacheDir: cache });
  assert.equal(again.cacheLoad, "discarded");
  assert.deepEqual(await paths(again, "ghostZulu"), []);
  assert.deepEqual(await paths(again, "realYankee"), ["a.ts"]);
});

test("ranking, identifier splitting, phrase and path filters", async () => {
  const filler = "lorem ipsum dolor sit amet\n".repeat(40);
  const { root, cache } = fresh({
    "src/config/parser.ts":
      "export function parseConfig(text: string) {\n  return parseConfigLine(text);\n}\nexport const config_parser = parseConfig;\n",
    "src/util/strings.ts": `${filler}// parse a config value\n`,
    "docs/notes.md": `${filler}the config file\n`,
    "src/http.rs":
      "pub struct HTTPServer;\nimpl HTTPServer {}\npub async fn serve() {}\n",
  });
  const index = await CodeIndex.open({ root, cacheDir: cache });
  const hits = await index.search({ query: "parse config" });
  assert.equal(hits[0]?.path, "src/config/parser.ts");
  assert.equal(hits[0]?.line, 1);
  assert.ok(hits.length === 3 && hits[0]!.score > hits[1]!.score);
  assert.deepEqual(await paths(index, "server"), ["src/http.rs"]);
  const phrase = await index.search({ query: '"parse a config"' });
  assert.deepEqual(
    phrase.map((h) => [h.path, h.line, h.preview]),
    [["src/util/strings.ts", 41, "// parse a config value"]],
  );
  assert.deepEqual(
    (await index.search({ query: "config", pathGlob: "src/**/*.ts" }))
      .map((h) => h.path)
      .sort(),
    ["src/config/parser.ts", "src/util/strings.ts"],
  );
  await assert.rejects(index.search({ query: "x", limit: 0 }), {
    code: "INVALID_ARGUMENT",
  });
});

test("outline and tool surface", async () => {
  const { root, cache } = fresh({
    "a.ts":
      "export async function go() {}\nexport class Box {}\n  const inner = 1;\ntype T = 1;\n",
    "b.py": "class Model:\n    def inner(self): pass\ndef main():\n    pass\n",
    "c.go": "func (s *S) Run() {}\nfunc main() {}\ntype S struct{}\n",
    "d.rs": "pub fn top() {}\nimpl Foo for Bar {\n}\n",
    "e.md": "# hi\n",
  });
  const index = await CodeIndex.open({ root, cacheDir: cache });
  const names = (p: string) => {
    const r = index.outline(p);
    return r.status === "ok"
      ? r.symbols.map((s) => `${s.kind}:${s.name}@${String(s.line)}`)
      : r.status;
  };
  assert.deepEqual(names("a.ts"), ["function:go@1", "class:Box@2", "type:T@4"]);
  assert.deepEqual(names("b.py"), ["class:Model@1", "def:main@3"]);
  assert.deepEqual(names("c.go"), ["method:Run@1", "func:main@2", "type:S@3"]);
  assert.deepEqual(names("d.rs"), ["fn:top@1", "impl:Foo for Bar@2"]);
  assert.deepEqual(index.outline("e.md"), {
    status: "unsupported",
    language: "md",
  });

  const [search, outline] = codeIndexTools(index);
  assert.equal(search?.name, "code_search");
  writeFileSync(join(root, "later.ts"), "const agentWrote = 1;\n");
  const out = (await search!.execute({ query: "agentWrote" })) as {
    results: { path: string }[];
  };
  assert.deepEqual(
    out.results.map((r) => r.path),
    ["later.ts"],
  );
  assert.deepEqual(await outline!.execute({ path: "later.ts" }), {
    status: "ok",
    language: "typescript",
    symbols: [{ name: "agentWrote", kind: "const", line: 1 }],
  });
  await assert.rejects(search!.execute({ query: 5 }), {
    code: "INVALID_ARGUMENT",
  });
});

const GRAPH_REPO = {
  "src/main.ts":
    'import { helper } from "./lib/helper.js";\nimport fs from "node:fs";\nhelper();\n',
  "src/lib/helper.ts":
    'import { deep } from "./deep";\nexport function helper() {\n  return deep();\n}\n',
  "src/lib/deep.ts": "export function deep() {\n  return 42;\n}\n",
  "src/unrelated.ts": "export function lonely() {}\n",
  "py/__init__.py": "",
  "py/app.py": "from .util import thing\nimport os\nthing()\n",
  "py/util.py": "def thing():\n    pass\n",
  "src/lib.rs": "mod net;\nuse crate::net::Socket;\n",
  "src/net.rs": "pub struct Socket;\n",
  "go.mod": "module example.com/demo\n\ngo 1.22\n",
  "cmd/main.go":
    'package main\n\nimport (\n\t"fmt"\n\t"example.com/demo/pkg/store"\n)\n\nfunc main() { store.Open(); fmt.Println() }\n',
  "pkg/store/store.go": "package store\n\nfunc Open() {}\n",
  "notes.md": "# notes\n",
};

test("import graph: ts/js, py, rs and go edges resolve; unsupported is honest", async () => {
  const { root, cache } = fresh(GRAPH_REPO);
  const index = await CodeIndex.open({ root, cacheDir: cache });
  assert.deepEqual(index.dependencies("src/main.ts"), {
    status: "ok",
    resolved: ["src/lib/helper.ts"],
    unresolved: ["node:fs"],
  });
  assert.deepEqual(index.dependencies("src/lib/helper.ts"), {
    status: "ok",
    resolved: ["src/lib/deep.ts"],
    unresolved: [],
  });
  assert.deepEqual(index.dependencies("py/app.py"), {
    status: "ok",
    resolved: ["py/util.py"],
    unresolved: ["os"],
  });
  assert.deepEqual(index.dependencies("src/lib.rs"), {
    status: "ok",
    resolved: ["src/net.rs"],
    unresolved: [],
  });
  assert.deepEqual(index.dependencies("cmd/main.go"), {
    status: "ok",
    resolved: ["pkg/store/store.go"],
    unresolved: ["fmt"],
  });
  assert.deepEqual(index.dependencies("notes.md"), {
    status: "unsupported",
    language: "md",
  });
  assert.deepEqual(index.dependents("src/lib/deep.ts"), {
    status: "ok",
    dependents: ["src/lib/helper.ts"],
  });
  assert.deepEqual(index.dependents("nope.ts"), { status: "not_indexed" });
});

test("related() ranks a transitively imported file above an unrelated one", async () => {
  const { root, cache } = fresh(GRAPH_REPO);
  const index = await CodeIndex.open({ root, cacheDir: cache });
  const r = index.related("src/main.ts", 100);
  assert.equal(r.status, "ok");
  const files =
    r.status === "ok"
      ? r.results.filter((n) => n.kind === "file").map((n) => n.path)
      : [];
  const deep = files.indexOf("src/lib/deep.ts");
  const lonely = files.indexOf("src/unrelated.ts");
  assert.ok(deep >= 0, `transitive import missing: ${files.join(",")}`);
  assert.ok(
    lonely === -1 || deep < lonely,
    `unrelated outranks transitive: ${files.join(",")}`,
  );
  assert.equal(files[0], "src/lib/helper.ts");
  assert.equal(index.related("noSuchThing").status, "not_found");
  // Symbol seed: its definition file and its referencing file lead.
  const bySym = index.related("deep");
  assert.deepEqual(
    bySym.status === "ok"
      ? bySym.results
          .filter((n) => n.kind === "file")
          .slice(0, 2)
          .map((n) => n.path)
          .sort()
      : null,
    ["src/lib/deep.ts", "src/lib/helper.ts"],
  );
});

test("symbol() returns definitions and references", async () => {
  const { root, cache } = fresh(GRAPH_REPO);
  const index = await CodeIndex.open({ root, cacheDir: cache });
  const s = index.symbol("helper");
  assert.deepEqual(s.definitions, [
    { path: "src/lib/helper.ts", name: "helper", kind: "function", line: 2 },
  ]);
  assert.deepEqual(
    s.references.map((r) => `${r.path}:${String(r.line)}`),
    ["src/main.ts:1", "src/main.ts:3"],
  );
  assert.equal(s.truncated, false);
});

test("incremental update keeps the graph consistent after delete and rename", async () => {
  const { root, cache } = fresh(GRAPH_REPO);
  const index = await CodeIndex.open({ root, cacheDir: cache });
  rmSync(join(root, "src/lib/deep.ts"));
  await index.refresh();
  assert.deepEqual(index.dependencies("src/lib/helper.ts"), {
    status: "ok",
    resolved: [],
    unresolved: ["./deep"],
  });
  assert.deepEqual(index.dependents("src/lib/deep.ts"), {
    status: "not_indexed",
  });
  assert.deepEqual(index.symbol("deep").definitions, []);
  // Rename: the file comes back as deeper.ts and the importer follows.
  writeFileSync(join(root, "src/lib/deeper.ts"), GRAPH_REPO["src/lib/deep.ts"]);
  writeFileSync(
    join(root, "src/lib/helper.ts"),
    GRAPH_REPO["src/lib/helper.ts"].replace('"./deep"', '"./deeper"'),
  );
  await index.refresh();
  assert.deepEqual(index.dependencies("src/lib/helper.ts"), {
    status: "ok",
    resolved: ["src/lib/deeper.ts"],
    unresolved: [],
  });
  assert.deepEqual(index.dependents("src/lib/deeper.ts"), {
    status: "ok",
    dependents: ["src/lib/helper.ts"],
  });
  assert.deepEqual(
    index.symbol("deep").definitions.map((d) => d.path),
    ["src/lib/deeper.ts"],
  );
  const r = index.related("src/main.ts", 100);
  const files = r.status === "ok" ? r.results.map((n) => n.path) : [];
  assert.ok(
    files.includes("src/lib/deeper.ts") && !files.includes("src/lib/deep.ts"),
  );
});

// Deterministic fake: bag of hashed tokens, with a tiny synonym table so the
// dense signal can find what lexical search cannot.
const SYNONYMS: Record<string, string> = { automobile: "car", vehicle: "car" };
const fakePort = (modelId: string, dimensions: number) => {
  const port = {
    modelId,
    dimensions,
    texts: 0,
    broken: false,
    async embed(texts: readonly string[]) {
      port.texts += texts.length;
      return texts.map((t) => {
        const v = new Float32Array(port.broken ? dimensions + 1 : dimensions);
        for (const raw of t.toLowerCase().match(/[a-z]+/g) ?? []) {
          const tok = SYNONYMS[raw] ?? raw;
          let h = 2166136261;
          for (const ch of tok) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
          v[(h >>> 0) % dimensions]! += 1;
        }
        return v;
      });
    },
  };
  return port;
};

test("hybrid search: dense signal via injected port, fused by RRF; off without a port", async () => {
  const { root, cache, base } = fresh({
    "car.ts":
      "export function startEngine() {\n  // the car ignition sequence\n}\n",
    "json.ts": "export function parseJson(text: string) {\n  return text;\n}\n",
  });
  const lexical = await CodeIndex.open({ root, cacheDir: join(base, "lex") });
  assert.deepEqual(await lexical.search({ query: "automobile" }), []);
  assert.equal(lexical.denseModel, null);

  const port = fakePort("fake-a", 32);
  const index = await CodeIndex.open({
    root,
    cacheDir: cache,
    embedding: port,
  });
  const hits = await index.search({ query: "automobile" });
  assert.equal(hits[0]?.path, "car.ts");
  assert.ok(hits[0]!.signals.dense && !hits[0]!.signals.bm25);
  const both = await index.search({ query: "parseJson" });
  assert.equal(both[0]?.path, "json.ts");
  assert.ok(both[0]!.signals.bm25 && both[0]!.signals.dense);
  assert.ok(both[0]!.score > (both[1]?.score ?? 0));

  // A port that breaks its contract fails the refresh; the old generation stays.
  port.broken = true;
  writeFileSync(join(root, "car.ts"), "export function brandNewTruck() {}\n");
  await assert.rejects(index.refresh(), /not Float32Array\[32\]/);
  port.broken = false;
  assert.equal(
    (await index.search({ query: "startEngine" }))[0]?.path,
    "car.ts",
  );
  await index.refresh();
  const after = await index.search({ query: "brandNewTruck" });
  assert.equal(after[0]?.path, "car.ts");
  assert.ok(after[0]!.signals.bm25);
});

test("dense vectors persist under a model stamp; a model swap re-embeds everything", async () => {
  const { root, cache } = fresh({
    "a.ts": "export function alpha() {}\nexport function beta() {}\n",
    "b.py": "def gamma():\n    pass\n",
  });
  const a = fakePort("fake-a", 16);
  await CodeIndex.open({ root, cacheDir: cache, embedding: a });
  const chunks = a.texts;
  assert.ok(chunks >= 3);
  const a2 = fakePort("fake-a", 16);
  await CodeIndex.open({ root, cacheDir: cache, embedding: a2 });
  assert.equal(a2.texts, 0, "same model stamp must reuse persisted vectors");
  const b = fakePort("fake-b", 24);
  const swapped = await CodeIndex.open({ root, cacheDir: cache, embedding: b });
  assert.equal(b.texts, chunks, "model swap must re-embed every chunk");
  assert.deepEqual(swapped.denseModel, { modelId: "fake-b", dimensions: 24 });
  assert.equal(
    JSON.parse(readFileSync(swapped.cacheFile, "utf8")).dense.modelId,
    "fake-b",
  );
  const b2 = fakePort("fake-b", 24);
  await CodeIndex.open({ root, cacheDir: cache, embedding: b2 });
  assert.equal(b2.texts, 0);
});

// ---- review hardening: glob ReDoS, secret files, graph/output bounds ----

test("pathGlob is linear: a crafted glob cannot backtrack; semantics hold", async () => {
  const { root, cache } = fresh({
    [`${"a".repeat(60)}.ts`]: "export const globAnchor = 1;\n",
    "src/a+b.ts": "export const globAnchor = 2;\n",
    "src/deep/x.ts": "export const globAnchor = 3;\n",
    "top.ts": "export const globAnchor = 4;\n",
  });
  const index = await CodeIndex.open({ root, cacheDir: cache });
  const started = Date.now();
  const none = await index.search({
    query: "globAnchor",
    pathGlob: `${"*a".repeat(60)}*b`,
  });
  assert.deepEqual(none, []);
  const stars = await index.search({
    query: "globAnchor",
    pathGlob: `${"**/".repeat(40)}*${"*".repeat(40)}b`,
  });
  assert.deepEqual(stars, []);
  // load slack only: the old backtracking glob hangs for >100s
  assert.ok(Date.now() - started < 5000, "crafted globs must not backtrack");
  const g = async (pathGlob: string) =>
    (await index.search({ query: "globAnchor", pathGlob }))
      .map((h) => h.path)
      .sort();
  assert.deepEqual(await g("src/*.ts"), ["src/a+b.ts"]);
  assert.deepEqual(await g("**/x.ts"), ["src/deep/x.ts"]);
  assert.deepEqual(await g("src/**"), ["src/a+b.ts", "src/deep/x.ts"]);
  assert.deepEqual(await g("t?p.ts"), ["top.ts"]);
  assert.deepEqual(await g("src/a+b.ts"), ["src/a+b.ts"]);
  assert.deepEqual(await g("src/a??b.ts"), []);
  assert.deepEqual(await g("src/a?b.ts"), ["src/a+b.ts"]);
  await assert.rejects(
    index.search({ query: "x", pathGlob: "a".repeat(257) }),
    { code: "INVALID_ARGUMENT" },
  );
});

test("secret-shaped files are never indexed, read or cached", async () => {
  const marker = ["secret", "marker", "quebec"].join("");
  const pemHead = `-----BEGIN ${"RSA"} PRIVATE ${"KEY"}-----`;
  const secretPaths = [
    ".env",
    ".env.production",
    "server.pem",
    "deploy.key",
    "id_rsa",
    "id_ed25519",
    "store.p12",
    "store.pfx",
    "credentials.json",
    "gcp-credentials-prod.json",
    ".npmrc",
    ".netrc",
    ".aws/config",
  ];
  for (const git of [true, false]) {
    const files: Record<string, string> = {
      "notes/innocent.txt": `${pemHead}\n${marker}\n-----END KEY-----\n`,
      ".env.example": `TOKEN=exampleOk${marker}\n`,
      "id_rsa.pub": `pubOk${marker}\n`,
      "src/keys.ts": `export const keyboardOk${marker} = 1;\n`,
    };
    for (const p of secretPaths) files[p] = `value ${marker}\n`;
    const { root, cache } = fresh(files, git);
    const index = await CodeIndex.open({ root, cacheDir: cache });
    const report = await index.refresh();
    assert.deepEqual(
      await paths(index, marker),
      [],
      `git=${String(git)}: bare marker only occurs in secret files`,
    );
    const ok = (
      await Promise.all(
        ["exampleOk", "pubOk", "keyboardOk"].map((p) =>
          paths(index, `${p}${marker}`),
        ),
      )
    ).flat();
    assert.deepEqual([...new Set(ok)].sort(), [
      ".env.example",
      "id_rsa.pub",
      "src/keys.ts",
    ]);
    assert.equal(index.fileCount, 3);
    for (const p of [...secretPaths, "notes/innocent.txt"])
      assert.ok(report.skipped.includes(p), `${p} must be skipped`);
    const cached = readFileSync(index.cacheFile, "utf8");
    assert.ok(!cached.includes("PRIVATE"), "PEM content never reaches cache");
    assert.ok(!cached.includes("value "), "secret files never reach cache");
  }
});

const bigRepo = (n: number) => {
  const files: Record<string, string> = {
    "hub.ts": "export const hubValue = 1;\n",
  };
  for (let i = 0; i < n; i++)
    files[`m/f${String(i)}.ts`] =
      'import { hubValue } from "../hub.js";\nexport function handler() { return hubValue; }\nhandler();\n';
  return files;
};

test("graph build is near-linear and output is bounded on a large repo", async () => {
  // Load-robust: compare rebuild time at 4x the files (min of 3 runs each).
  // Linear => ratio ~4, quadratic => ~16; absolute ceiling is only a hang guard.
  const rebuild = async (n: number) => {
    const { root, cache } = fresh(bigRepo(n));
    const idx = await CodeIndex.open({ root, cacheDir: cache });
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      await idx.refresh(); // every file reused: this times the graph rebuild
      best = Math.min(best, performance.now() - t0);
    }
    return { idx, best };
  };
  const small = await rebuild(2000);
  const { idx: index, best: large } = await rebuild(8000);
  assert.ok(large < 30000, `graph rebuild hung: ${String(large)}ms`);
  const ratio = large / Math.max(small.best, 1);
  assert.ok(
    ratio < 8,
    `graph rebuild superlinear: 4x files took ${ratio.toFixed(1)}x`,
  );
  const related = index.related("hub.ts");
  assert.ok(related.status === "ok" && related.results.length === 50);
  const dep = index.dependents("hub.ts");
  assert.ok(dep.status === "ok");
  assert.equal(dep.dependents.length, 200);
  assert.equal((dep as { truncated?: boolean }).truncated, true);
  const sym = index.symbol("handler");
  assert.equal(sym.definitions.length, 200);
  assert.equal(sym.truncated, true);
});

test("result limits: default 50, max 200, bounded tool output, file cap flagged", async () => {
  const long = "d".repeat(90);
  const files: Record<string, string> = {};
  for (let i = 0; i < 260; i++)
    files[`${long}/${long}/f${String(i)}.ts`] =
      `// ${"commonWord ".repeat(30)}\nexport const v${String(i)} = 1;\n`;
  const { root, cache } = fresh(files);
  const index = await CodeIndex.open({ root, cacheDir: cache });
  assert.equal((await index.search({ query: "commonWord" })).length, 50);
  assert.equal(
    (await index.search({ query: "commonWord", limit: 200 })).length,
    200,
  );
  await assert.rejects(index.search({ query: "commonWord", limit: 201 }), {
    code: "INVALID_ARGUMENT",
  });
  const [search] = codeIndexTools(index);
  const out = (await search!.execute({ query: "commonWord", limit: 200 })) as {
    results: unknown[];
    truncated?: boolean;
  };
  assert.ok(JSON.stringify(out).length <= 64 * 1024, "tool output is capped");
  assert.ok(out.results.length < 200 && out.truncated === true);

  const capped = await CodeIndex.open({
    root,
    cacheDir: join(cache, "capped"),
    maxFiles: 25,
  });
  assert.equal(capped.fileCount, 25);
  assert.equal(capped.truncated, true);
  assert.equal((await capped.refresh()).truncated, true);
  assert.equal(index.truncated, false);
});
