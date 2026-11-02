// C2_agent_context_tools: read-only code-index and memory tools for the agent,
// on a real index over a temp repo and a real Memory over a temp Store.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CodeIndex,
  codeIndexTools,
} from "../../packages/splyce-index/dist/index.js";
import {
  captureMemoryAfterTurn,
  createAgentContextTools,
  MAX_OUTPUT_BYTES,
  type Redactor,
} from "../../packages/splyce-pi/dist/agent-context-tools.js";
import { redactSecrets } from "../../packages/splyce-retrieval/dist/retrieval.js";
import { commit, setup, turn } from "./memory-fixture.ts";

// Built at runtime: a fake credential, not a real one.
const SECRET = ["sk", "abcdefgh1234567890zzzz"].join("-");
const tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "c2-ctx-")));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

let n = 0;
async function repo(files: Record<string, string>) {
  n += 1;
  const root = join(tmpRoot, `r${String(n)}`, "ws");
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const index = await CodeIndex.open({
    root,
    cacheDir: join(tmpRoot, `r${String(n)}`, "cache"),
  });
  return { root, index };
}
const FILES = {
  "src/a.ts": "export function alphaWidget(): number {\n  return 1;\n}\n",
  "src/b.ts":
    'import { alphaWidget } from "./a";\nexport const betaUse = alphaWidget();\n',
  "src/conf.ts": `export const confLoader = 1;\nconst apiKey = "${SECRET}";\nalphaWidget("${SECRET}");\n`,
};
const build = async (
  files: Record<string, string> = FILES,
  redact: Redactor = redactSecrets,
) => {
  const { root, index } = await repo(files);
  const tools = createAgentContextTools({
    workspaceRoot: root,
    index,
    codeTools: codeIndexTools(index),
    redact,
  });
  const by = (name: string) => {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, name);
    return tool;
  };
  return { root, index, tools, by };
};
const json = async (
  tool: { execute: (a: Record<string, unknown>) => Promise<string> },
  args: Record<string, unknown>,
) => JSON.parse(await tool.execute(args)) as Record<string, unknown>;
const code = (expected: string) => (error: unknown) =>
  (error as { code?: unknown }).code === expected;

test("C2: code tools return index results and are all read-only", async () => {
  const { by, tools } = await build();
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "code_search",
      "code_outline",
      "code_related",
      "code_dependencies",
      "code_dependents",
      "code_symbol",
    ],
  );
  assert.ok(tools.every((t) => t.readOnly));
  const search = await json(by("code_search"), { query: "alphaWidget" });
  assert.ok(
    (search.results as { path: string }[]).some((h) => h.path === "src/a.ts"),
  );
  assert.match(
    JSON.stringify(await json(by("code_outline"), { path: "src/a.ts" })),
    /alphaWidget/,
  );
  assert.match(
    JSON.stringify(await json(by("code_dependencies"), { path: "src/b.ts" })),
    /src\/a\.ts/,
  );
  assert.match(
    JSON.stringify(await json(by("code_dependents"), { path: "src/a.ts" })),
    /src\/b\.ts/,
  );
  assert.match(
    JSON.stringify(await json(by("code_symbol"), { name: "alphaWidget" })),
    /src\/b\.ts/,
  );
  assert.match(
    JSON.stringify(await json(by("code_related"), { target: "src/a.ts" })),
    /src\/b\.ts/,
  );
  const r = await by("code_search").result({ query: "alphaWidget" });
  assert.equal(r.summary.truncated, false);
  assert.ok(r.summary.bytes > 0 && r.summary.preview.length > 0);
});

test("C2: paths outside the admitted root are rejected; a foreign index is refused", async () => {
  const { by, index } = await build();
  for (const [name, args] of [
    ["code_outline", { path: "../secret.ts" }],
    ["code_outline", { path: "src/../../x.ts" }],
    ["code_outline", { path: "/etc/passwd" }],
    ["code_outline", { path: "C:\\Windows\\win.ini" }],
    ["code_dependencies", { path: "..\\x.ts" }],
    ["code_related", { target: "../x.ts" }],
    ["code_search", { query: "a", pathGlob: "../**" }],
  ] as const)
    await assert.rejects(by(name).execute(args), code("WORKSPACE_ESCAPE"));
  await assert.rejects(
    by("code_outline").execute({ path: "" }),
    code("BAD_ARGS"),
  );
  const other = await repo({ "x.ts": "export const x = 1;\n" });
  assert.throws(
    () =>
      createAgentContextTools({
        workspaceRoot: other.root,
        index,
        codeTools: codeIndexTools(index),
        redact: redactSecrets,
      }),
    code("ROOT_MISMATCH"),
  );
});

test("C2: a secret inside an indexed file never appears in any tool output", async () => {
  const { by } = await build();
  const outputs = await Promise.all([
    by("code_search").execute({ query: "apiKey confLoader" }),
    by("code_search").execute({ query: SECRET }),
    by("code_symbol").execute({ name: "alphaWidget" }),
    by("code_symbol").execute({ name: "confLoader" }),
    by("code_outline").execute({ path: "src/conf.ts" }),
  ]);
  for (const text of outputs) assert.ok(!text.includes(SECRET), text);
  assert.ok(outputs.some((t) => t.includes("conf")));
});

test("C2: native scrub guard is live for credentials outside the built-in patterns", async () => {
  const credential = "native fixture credential";
  const files = { "src/native.ts": `alphaWidget('${credential}');` };
  const protectedTools = await build(files, (text) =>
    text.replaceAll(credential, "[X]"),
  );
  const control = await build(files, (text) => text);
  assert.ok(
    !(
      await protectedTools.by("code_symbol").execute({ name: "alphaWidget" })
    ).includes(credential),
  );
  assert.ok(
    (await control.by("code_symbol").execute({ name: "alphaWidget" })).includes(
      credential,
    ),
  );
});

for (const name of ["code_search", "code_symbol"])
  for (const tail of [100, MAX_OUTPUT_BYTES + 100])
    test(`C2: ${name} redacts real index previews before the 200-char cut (tail=${tail})`, async () => {
      const credential = ["boundaryLeft", "boundaryRight"].join(" ");
      const prefix = "alphaWidget('".padEnd(195, ".");
      const line = `${prefix}${credential}${"z".repeat(tail)}');`;
      const inputs: string[] = [];
      const { by } = await build({ "src/cut.ts": line }, (text) => {
        inputs.push(text);
        return text.replaceAll(credential, "[X]");
      });
      const r = await by(name).result(
        name === "code_search"
          ? { query: "alphaWidget" }
          : { name: "alphaWidget" },
      );
      const value = JSON.parse(r.text);
      const hits = name === "code_search" ? value.results : value.references;
      assert.equal(hits.length, 1);
      assert.ok(
        inputs.includes(line),
        "native redactor receives the full line",
      );
      assert.ok(!JSON.stringify(r).includes("bound"));
      assert.ok(hits[0].preview.includes("[X]"));
      assert.equal(hits[0].preview.length, 200);
      assert.equal(r.summary.truncated, true);
    });

test("C2: native redaction sees overlapping secret shapes before the built-in scrub", async () => {
  const credential = ["left", "right-tail"].join(" ");
  const { by } = await build(
    { "src/overlap.ts": `alphaWidget('token=${credential}');` },
    async (text) => text.replaceAll(credential, "[X]"),
  );
  for (const name of ["code_search", "code_symbol"]) {
    const r = await by(name).result(
      name === "code_search"
        ? { query: "alphaWidget" }
        : { name: "alphaWidget" },
    );
    assert.ok(!JSON.stringify(r).includes("right-tail"));
    assert.ok(r.text.includes("[REDACTED]"));
  }
});

test("C2: output is capped at the index 64 KB, also for oversized tool text", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 400; i += 1)
    files[`src/m${String(i)}.ts`] =
      `export const marker${String(i)} = "${"y".repeat(300)}";\n// bulkword\n`;
  const { by, root, index } = await build(files);
  const r = await by("code_search").result({ query: "bulkword", limit: 200 });
  assert.ok(Buffer.byteLength(r.text) <= MAX_OUTPUT_BYTES);
  assert.equal(MAX_OUTPUT_BYTES, 64 * 1024);
  const [tool] = createAgentContextTools({
    workspaceRoot: root,
    index,
    codeTools: [
      {
        name: "big",
        description: "d",
        parameters: {},
        execute: async () => "z".repeat(200 * 1024),
      },
    ],
    redact: redactSecrets,
  });
  assert.ok(tool);
  const big = await tool.result({});
  assert.equal(Buffer.byteLength(big.text), MAX_OUTPUT_BYTES);
  assert.equal(big.summary.truncated, true);
  assert.ok(big.summary.bytes > MAX_OUTPUT_BYTES);
});

test("C2: memory_search returns cited results after capture and is scope-bound", async (t) => {
  const fx = setup(t);
  commit(
    fx.store,
    turn("a", "src/db/pool.ts", "Database pool size raised to twenty."),
  );
  commit(
    fx.store,
    turn("o", "src/other.ts", "Unrelated pool tuning elsewhere.", "w-other"),
    "w-other",
  );
  const { root, index } = await repo(FILES);
  const tools = createAgentContextTools({
    workspaceRoot: root,
    index,
    codeTools: codeIndexTools(index),
    memory: fx.memory,
    scopeId: "w-demo",
    redact: redactSecrets,
  });
  const memory = tools.find((x) => x.name === "memory_search");
  assert.ok(memory?.readOnly);
  const before = await json(memory, { query: "database pool" });
  assert.deepEqual(before.results, []);
  assert.equal(captureMemoryAfterTurn(fx.memory, "w-demo", "s1"), 1);
  const after = (await json(memory, { query: "database pool", limit: 5 })) as {
    results: { text: string; sourceIds: string[] }[];
  };
  assert.equal(after.results.length, 1);
  assert.match(after.results[0]?.text ?? "", /Database pool size raised/);
  assert.deepEqual(after.results[0]?.sourceIds, [
    "event:a-intent",
    "event:a-outcome",
  ]);
  await assert.rejects(
    memory.execute({ query: "x", limit: 99 }),
    code("BAD_ARGS"),
  );
  await assert.rejects(memory.execute({ query: "" }), code("BAD_ARGS"));
  assert.throws(
    () =>
      createAgentContextTools({
        workspaceRoot: root,
        index,
        codeTools: [],
        memory: fx.memory,
        redact: redactSecrets,
      }),
    code("BAD_ARGS"),
  );
});

test("C2: memory output is scrubbed and each observation text is capped", async () => {
  const { root, index } = await repo(FILES);
  const tools = createAgentContextTools({
    workspaceRoot: root,
    index,
    codeTools: [],
    memory: {
      capture: () => [],
      query: async () => [
        {
          observationId: "o1",
          text: `leak ${SECRET} ${"w".repeat(5000)}`,
          sourceIds: ["event:x"],
          score: 1,
          createdAt: "2026-10-27T00:00:00.000Z",
        },
      ],
    },
    scopeId: "w-demo",
    redact: redactSecrets,
  });
  const text = await tools[0]?.execute({ query: "leak" });
  assert.ok(text && !text.includes(SECRET));
  assert.ok(text.length < 2500);
});

// A credential the JSON encoder would escape: quote and backslash.
const ODD = 'pw"x\\y-1234567890';
const exact = (text: string) => text.split(ODD).join("[X]");
const fakeTool = (execute: () => Promise<unknown>) => ({
  name: "fake",
  description: "d",
  parameters: { type: "object", properties: { a: { type: "string" } } },
  execute,
});
const memoryHit = (text: string) => ({
  observationId: "o1",
  text,
  sourceIds: ["event:x"],
  score: 1,
  createdAt: "2026-10-27T00:00:00.000Z",
});

test("C2: a secret with quote and backslash is redacted before JSON encoding", async () => {
  const { root, index } = await repo({
    ...FILES,
    "src/q.ts": `alphaWidget('${ODD}');\n`,
  });
  const tools = createAgentContextTools({
    workspaceRoot: root,
    index,
    codeTools: codeIndexTools(index),
    memory: {
      capture: () => [],
      query: async () => [memoryHit(`note ${ODD} end`)],
    },
    scopeId: "w-demo",
    redact: exact,
  });
  const by = (n: string) => tools.find((t) => t.name === n);
  const sym = await by("code_symbol")?.execute({ name: "alphaWidget" });
  assert.ok(sym?.includes("[X]"), sym);
  assert.ok(!sym?.includes("pw"), sym);
  const mem = await by("memory_search")?.execute({ query: "note" });
  assert.ok(mem?.includes("[X]") && !mem.includes("pw"), mem);
});

test("C2: memory text is redacted before the 2000-char cut", async () => {
  const { root, index } = await repo(FILES);
  const tools = createAgentContextTools({
    workspaceRoot: root,
    index,
    codeTools: [],
    memory: {
      capture: () => [],
      query: async () => [memoryHit(`${"w".repeat(1995)}${ODD}tail`)],
    },
    scopeId: "w-demo",
    redact: exact,
  });
  const text = (await tools[0]?.execute({ query: "w" })) ?? "";
  assert.ok(!text.includes("pw"), text);
});

test("C2: scrub runs before the output cap", async () => {
  const { root, index } = await repo(FILES);
  const [tool] = createAgentContextTools({
    workspaceRoot: root,
    index,
    codeTools: [
      fakeTool(async () => `${"a".repeat(MAX_OUTPUT_BYTES - 16)}${ODD}tail`),
    ],
    redact: exact,
  });
  const r = await tool?.result({});
  assert.ok(r && !r.text.includes("pw"), r?.text.slice(-40));
  assert.ok(Buffer.byteLength(r.text) <= MAX_OUTPUT_BYTES);
});

test("C2: tools and their schemas are deeply frozen", async () => {
  const { tools } = await build();
  for (const t of tools as unknown as Record<string, unknown>[]) {
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.parameters));
    assert.throws(() => (t.execute = async () => ""), TypeError);
    assert.throws(() => (t.readOnly = false), TypeError);
    const props = (t.parameters as { properties: object }).properties;
    assert.ok(Object.isFrozen(props));
    assert.throws(() => ((props as Record<string, unknown>).x = 1), TypeError);
  }
});

test("C2: tool failures surface a generic error without paths", async () => {
  const { root, index } = await repo(FILES);
  const enoent = () =>
    Object.assign(new Error("ENOENT: open 'C:\\Users\\victim\\vault\\f.ts'"), {
      code: "ENOENT",
    });
  const tools = createAgentContextTools({
    workspaceRoot: root,
    index,
    codeTools: [
      fakeTool(async () => {
        throw enoent();
      }),
    ],
    memory: {
      capture: () => [],
      query: async () => {
        throw enoent();
      },
    },
    scopeId: "w-demo",
    redact: redactSecrets,
  });
  for (const [t, args] of [
    [tools[0], {}],
    [tools[1], { query: "q" }],
  ] as const) {
    await assert.rejects(
      async () => await t?.execute(args),
      (e: Error & { code?: string }) =>
        e.name === "ContextToolError" &&
        e.code === "ENOENT" &&
        !/Users|victim|vault/.test(e.message),
    );
  }
});

test("C2: a throwing redactor surfaces a generic error without its message", async () => {
  const { by } = await build(FILES, () => {
    throw new Error("boom C:Users\victimws");
  });
  await assert.rejects(
    async () => await by("code_search").execute({ query: "alphaWidget" }),
    (e: Error & { code?: string }) =>
      e.name === "ContextToolError" &&
      e.code === "REDACTION_UNAVAILABLE" &&
      e.message === "[unavailable]",
  );
});

for (const spaced of [false, true])
  test(`C2: async redaction precedes memory and output cuts (space=${spaced})`, async () => {
    const credential = ["vaultAAA", "vaultZZZ"].join(spaced ? " " : "");
    const { root, index } = await repo(FILES);
    const inputs: string[] = [];
    const tools = createAgentContextTools({
      workspaceRoot: root,
      index,
      codeTools: [
        fakeTool(async () => ({
          nested: [
            `${" ".repeat(51_192)}${credential}${" ".repeat(MAX_OUTPUT_BYTES)}`,
          ],
        })),
      ],
      memory: {
        capture: () => [],
        query: async () => [
          memoryHit(`${" ".repeat(1992)}${credential}${" ".repeat(100)}`),
        ],
      },
      scopeId: "w-demo",
      redact: async (text) => {
        await Promise.resolve();
        inputs.push(text);
        return text.replaceAll(credential, "[X]");
      },
    });
    for (const [tool, args] of [
      [tools[0]!, {}],
      [tools[1]!, { query: "fixture" }],
    ] as const) {
      const r = await tool.result(args);
      const published = JSON.stringify(r);
      assert.ok(
        !published.includes("vaultAAA") && !published.includes("vaultZZZ"),
      );
      assert.equal(r.summary.truncated, true);
    }
    assert.ok(inputs.some((text) => text.includes(credential)));
  });

test("C2: async redaction covers JSON keys before escaping", async () => {
  const { root, index } = await repo(FILES);
  const [tool] = createAgentContextTools({
    workspaceRoot: root,
    index,
    codeTools: [fakeTool(async () => ({ [ODD]: { [ODD]: ODD } }))],
    redact: async (text) => exact(text),
  });
  const r = await tool!.result({});
  assert.deepEqual(JSON.parse(r.text), { "[X]": { "[X]": "[X]" } });
  assert.ok(!JSON.stringify(r).includes("pw"));
});

for (const [kind, redact] of [
  [
    "reject",
    async () => {
      throw new Error("private redactor failure");
    },
  ],
  ["non-string", () => null],
  ["async non-string", async () => 123],
] as const)
  test(`C2: redactor ${kind} suppresses all code and memory output`, async () => {
    const { root, index } = await repo(FILES);
    const tools = createAgentContextTools({
      workspaceRoot: root,
      index,
      codeTools: [fakeTool(async () => ({ nested: ["private output"] }))],
      memory: {
        capture: () => [],
        query: async () => [memoryHit("private output")],
      },
      scopeId: "w-demo",
      redact: redact as unknown as Redactor,
    });
    for (const [tool, args] of [
      [tools[0]!, {}],
      [tools[1]!, { query: "private" }],
    ] as const)
      await assert.rejects(
        () => tool.result(args),
        (e: Error & { code?: string }) =>
          e.code === "REDACTION_UNAVAILABLE" && e.message === "[unavailable]",
      );
  });
