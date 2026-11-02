// TD-40 M2: hybrid recall (BM25, dense port, entity-graph PPR, RRF) and the
// deletion lifecycle across every index, restart and restore.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  extractEntities,
  RetrievalIndex,
  rrf,
} from "../../packages/splyce-retrieval/dist/retrieval.js";
import { commit, fakeEmbedding, setup, turn } from "./memory-fixture.ts";

const code = (expected: string) => (error: unknown) =>
  (error as { code?: unknown }).code === expected;
const index = (options = {}) =>
  new RetrievalIndex(new DatabaseSync(":memory:"), options);

test("M2: lexical recall ranks the matching observation first and returns its citations", async (t) => {
  const fx = setup(t);
  commit(fx.store, [
    ...turn(
      "a",
      "src/auth/login.ts",
      "Login validates tokens before redirect.",
    ),
    ...turn("b", "src/db/pool.ts", "Database pool size raised to twenty."),
    ...turn("c", "README.md", "Docs mention the install steps."),
  ]);
  fx.memory.capture("w-demo", "s1");
  const [first] = await fx.memory.query("w-demo", "database pool size", 3);
  assert.equal(
    first?.text,
    "Tool fs.write on workspace (src/db/pool.ts: Database pool size raised to twenty.) -> success",
  );
  assert.deepEqual(first?.sourceIds, ["event:b-intent", "event:b-outcome"]);
  assert.ok((first?.signals.lexical?.score ?? 0) > 0);
});

test("M2: recall never crosses scopes", async (t) => {
  const fx = setup(t);
  commit(
    fx.store,
    turn("a", "src/secret.ts", "Secret rotation happens nightly.", "w-one"),
    "w-one",
  );
  commit(
    fx.store,
    turn("b", "src/other.ts", "Unrelated work.", "w-two"),
    "w-two",
  );
  fx.memory.capture("w-one", "s1");
  fx.memory.capture("w-two", "s1");
  assert.ok((await fx.memory.query("w-one", "secret rotation", 5)).length > 0);
  const leaked = await fx.memory.query(
    "w-two",
    "secret rotation src/secret.ts",
    5,
  );
  assert.ok(
    leaked.every(
      (hit) => hit.scopeId === "w-two" && !hit.text.includes("Secret"),
    ),
  );
});

test("M2: graph PPR ranks a 2-hop related observation above an unrelated lexical match", () => {
  const rx = index();
  rx.add([
    {
      id: "A",
      scopeId: "s",
      text: "Edited src/auth/login.ts to call validateToken.",
    },
    {
      id: "B",
      scopeId: "s",
      text: "validateToken reads jwtSecret from SessionVault.",
    },
    { id: "C", scopeId: "s", text: "The login page colours were refreshed." },
  ]);
  assert.ok(
    extractEntities("Edited src/auth/login.ts to call validateToken.").includes(
      "src/auth/login.ts",
    ),
  );
  const lexical = rx.lexical("s", "login", 10).map((hit) => hit.id);
  assert.ok(lexical.includes("C") && !lexical.includes("B"));
  const graph = rx.graph("s", "login", 10);
  assert.deepEqual(
    graph.map((hit) => hit.id),
    ["A", "B"],
  );
  const score = (id: string) => graph.find((hit) => hit.id === id)?.score ?? 0;
  assert.ok(score("B") > score("C"));
});

test("M2: RRF fuses best-first lists with 1/(k+rank) and keeps per-signal ranks", () => {
  const fused = rrf(
    {
      lexical: [
        { id: "x", score: 9 },
        { id: "y", score: 5 },
      ],
      graph: [
        { id: "y", score: 0.4 },
        { id: "z", score: 0.1 },
      ],
    },
    60,
  );
  assert.deepEqual(
    fused.map((hit) => hit.id),
    ["y", "x", "z"],
  );
  assert.equal(fused[0]?.score, 1 / 62 + 1 / 61);
  assert.equal(fused[1]?.score, 1 / 61);
  assert.deepEqual(fused[0]?.signals, {
    lexical: { rank: 2, score: 5 },
    graph: { rank: 1, score: 0.4 },
  });
});

test("M2: dense recall is off without a port, uses the injected port, and a model swap rebuilds without mixing", async () => {
  const db = new DatabaseSync(":memory:");
  const docs = [
    { id: "d1", scopeId: "s", text: "alpha beta gamma" },
    { id: "d2", scopeId: "s", text: "delta epsilon" },
  ];
  const off = new RetrievalIndex(db);
  off.add(docs);
  assert.deepEqual(await off.dense("s", "alpha", 5), []);
  assert.equal((await off.query("s", "alpha", 5))[0]?.signals.dense, undefined);

  const portA = fakeEmbedding("fake-a");
  const a = new RetrievalIndex(db, { embedding: portA });
  const [top] = await a.dense("s", "alpha gamma", 5);
  assert.equal(top?.id, "d1");
  assert.equal(await a.embedPending("s"), 0);
  assert.ok((await a.query("s", "alpha gamma", 5))[0]?.signals.dense);

  const b = new RetrievalIndex(db, { embedding: fakeEmbedding("fake-b", 16) });
  assert.equal(await b.embedPending("s"), 2);
  const models = db
    .prepare("SELECT DISTINCT model_id AS m, dimensions AS d FROM rx_vectors")
    .all();
  assert.deepEqual(JSON.parse(JSON.stringify(models)), [
    { m: "fake-b", d: 16 },
  ]);

  const bad = new RetrievalIndex(db, {
    embedding: {
      modelId: "bad",
      dimensions: 4,
      embed: async (texts) => texts.map(() => new Float32Array(3)),
    },
  });
  await assert.rejects(bad.embedPending("s"), code("EMBEDDING_CONTRACT"));
});

test("M2: a deleted source is purged from lexical, vector and graph indexes and never resurrects across restart or restore", async (t) => {
  const embedding = fakeEmbedding();
  const fx = setup(t, { embedding });
  commit(fx.store, [
    ...turn("keep", "src/keep.ts", "Kept answer about caching."),
    ...turn("gone", "src/canary/secret.ts", "Canary answer about rotation."),
  ]);
  fx.memory.capture("w-demo", "s1");
  const before = await fx.memory.query(
    "w-demo",
    "canary rotation src/canary/secret.ts",
    10,
  );
  const doomed = before
    .filter((hit) => hit.text.includes("anary"))
    .map((hit) => hit.observationId);
  assert.equal(doomed.length, 1);
  assert.ok(
    before.some(
      (hit) => hit.signals.dense && hit.signals.graph && hit.signals.lexical,
    ),
  );
  const storeBackup = join(fx.dir, "store-before.db");
  fx.store.backup(storeBackup);
  fx.closeMemory();
  const memoryBackup = join(fx.dir, "memory-before.db");
  fx.copyMemoryTo(memoryBackup);
  assert.ok(
    readFileSync(memoryBackup).toString("latin1").includes("Canary answer"),
  );
  fx.openMemory();

  fx.store.noteDeletion("event:gone-outcome");
  assert.equal(fx.memory.syncDeletions(), 1);
  const residue = () => {
    const db = new DatabaseSync(fx.memoryPath);
    try {
      return [
        "rx_docs WHERE id",
        "rx_postings WHERE doc_id",
        "rx_doc_entities WHERE doc_id",
        "rx_edges WHERE doc_id",
        "rx_vectors WHERE doc_id",
        "observations WHERE observation_id",
      ].map(
        (clause) =>
          (
            db
              .prepare(`SELECT COUNT(*) AS n FROM ${clause} = ?`)
              .get(doomed[0]) as { n: number }
          ).n,
      );
    } finally {
      db.close();
    }
  };
  assert.deepEqual(residue(), [0, 0, 0, 0, 0, 0]);
  const absent = async () => {
    const hits = await fx.memory.query(
      "w-demo",
      "canary rotation src/canary/secret.ts",
      10,
    );
    assert.ok(hits.every((hit) => !hit.text.includes("anary")));
    const kept = await fx.memory.query("w-demo", "kept caching", 1);
    assert.match(kept[0]?.text ?? "", /Kept answer about caching/);
  };
  await absent();

  fx.reopen();
  await absent();
  assert.deepEqual(fx.memory.capture("w-demo", "s1"), []); // replay past the tombstone; nothing re-derived
  await absent();
  assert.throws(() => fx.store.restore(storeBackup), code("STALE_RESTORE"));

  fx.closeMemory();
  fx.replaceMemoryWith(memoryBackup); // projection restored from before the deletion
  fx.openMemory();
  assert.deepEqual(residue(), [0, 0, 0, 0, 0, 0]);
  await absent();
  // source (1) + observation/claim receipts (2), re-tombstoned when the restored projection was re-purged (2)
  assert.equal(fx.store.deletionEpoch(), 5);
  // secure_delete: purged text is overwritten on disk, not left in free pages.
  fx.closeMemory();
  const bytes = ["", "-wal"]
    .filter((suffix) => existsSync(fx.memoryPath + suffix))
    .map((suffix) => readFileSync(fx.memoryPath + suffix).toString("latin1"))
    .join("");
  assert.equal(bytes.includes("Canary answer"), false);
  assert.equal(bytes.includes("Kept answer"), true);
});

// Secret-shaped fixtures are assembled at runtime so no literal credential sits in the repo.
const shaped = (...parts: string[]) => parts.join("");

test("M2: secrets are redacted before any index, the memory file or the embedding port", async (t) => {
  const inputs: string[] = [];
  const port = fakeEmbedding();
  const embedding = {
    modelId: port.modelId,
    dimensions: port.dimensions,
    embed: (texts: readonly string[]) => {
      inputs.push(...texts);
      return port.embed(texts);
    },
  };
  const secrets = [
    shaped("sk", "-live-", "4f9a8b7c6d5e4f3a2b1c"),
    shaped("gh", "p_", "abcdefghijklmnopqrstuvwxyz0123"),
    shaped("github", "_pat_", "11ABCDEFG0123456789_abcdefghij"),
    shaped("xo", "xb-", "1234567890-abcdefghij"),
    shaped("AK", "IA", "QWERTYUIOP123456"),
    shaped(
      "ey",
      "JhbGciOiJIUzI1NiJ9.",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
      "dozjgNryP4J3jVmNHl0w5N",
    ),
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    "hunter2-db-pass",
    "Zx9-opaque-bearer",
    "custom-vault-secret-42",
  ];
  const fx = setup(t, {
    embedding,
    redact: (text) => text.replaceAll("custom-vault-secret-42", "[VAULT]"),
  });
  const pem = shaped(
    "-----BEGIN ",
    "PRIVATE KEY-----\n",
    secrets[6] ?? "",
    "\n-----END ",
    "PRIVATE KEY-----",
  );
  commit(
    fx.store,
    turn(
      "s",
      "src/deploy.ts",
      `curl -H "Authorization: ${shaped("Bea", "rer ")}Zx9-opaque-bearer" OPENAI=${secrets[0]} gh=${secrets[1]} pat ${secrets[2]} slack ${secrets[3]} aws ${secrets[4]} jwt ${secrets[5]} ${pem} db_password=hunter2-db-pass vault ${secrets[9]} deploy finished`,
    ),
  );
  const [observation] = fx.memory.capture("w-demo", "s1");
  assert.match(observation?.text ?? "", /deploy finished/);
  assert.ok((await fx.memory.query("w-demo", "deploy finished", 5)).length > 0);
  const db = new DatabaseSync(fx.memoryPath);
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'rx_%' OR name = 'observations')",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  const dump = tables
    .map((name) => JSON.stringify(db.prepare(`SELECT * FROM ${name}`).all()))
    .join("\n")
    .toLowerCase();
  db.close();
  assert.ok(inputs.length > 0);
  for (const secret of secrets) {
    assert.equal(dump.includes(secret.toLowerCase()), false, secret);
    assert.equal(
      inputs.some((input) => input.includes(secret)),
      false,
      secret,
    );
    assert.equal(observation?.text.includes(secret), false, secret);
  }

  const failing = new RetrievalIndex(new DatabaseSync(":memory:"), {
    embedding: {
      modelId: "fails",
      dimensions: 4,
      embed: async () => {
        throw new Error(
          `upstream 401 for ${shaped("Bea", "rer ")}${secrets[0]}`,
        );
      },
    },
  });
  failing.add([{ id: "x", scopeId: "s", text: "hello" }]);
  await assert.rejects(
    failing.embedPending("s"),
    (error: unknown) =>
      code("EMBEDDING_FAILED")(error) &&
      !(error as Error).message.includes(secrets[0] ?? "?"),
  );
});

test("M2: oversized documents and queries stay bounded", () => {
  const rx = index();
  const started = Date.now();
  const huge = "a-".repeat(100_000) + "/ src/real/path.ts tail";
  rx.add([{ id: "big", scopeId: "s", text: huge }]);
  extractEntities(huge);
  const query = Array.from({ length: 50_000 }, (_, i) => `t${i}`).join(" ");
  rx.lexical("s", query, 5);
  rx.graph("s", query, 5);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `took ${elapsed}ms`);
  const stored = new DatabaseSync(":memory:");
  new RetrievalIndex(stored).add([{ id: "big", scopeId: "s", text: huge }]);
  const row = stored
    .prepare("SELECT length(text) AS n FROM rx_docs WHERE id = 'big'")
    .get() as { n: number };
  assert.equal(row.n, 8000);
  assert.ok(extractEntities(huge).length <= 32);
});
