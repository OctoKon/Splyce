// TD-39 M1: capture of committed durable events into cited observations.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractive } from "../../packages/splyce-memory/dist/memory.js";
import { commit, memoryRecords, setup, turn } from "./memory-fixture.ts";

const code = (expected: string) => (error: unknown) =>
  (error as { code?: unknown }).code === expected;

test("M1: capture cites committed source events and stays idempotent across store and memory reopen", (t) => {
  const fx = setup(t);
  const [intent] = turn("a", "src/auth/login.ts", "validate tokens");
  if (intent === undefined) throw new Error("fixture");
  const events = commit(fx.store, [
    ...turn("a", "src/auth/login.ts", "validate tokens"),
    {
      ...intent,
      eventId: "a-failed",
      kind: "turn.failed",
      payload: {
        runId: "r1",
        error: {
          code: "TIMEOUT",
          message: "provider timed out",
          correlationId: "c1",
          retryable: true,
        },
      },
    },
  ]);
  const captured = fx.memory.capture("w-demo", "s1");
  assert.deepEqual(
    captured.map((o) => o.text),
    [
      "Tool fs.write on workspace (src/auth/login.ts: validate tokens) -> success",
      "Run r1 failed: TIMEOUT provider timed out",
    ],
  );
  assert.deepEqual(captured[0]?.sourceIds, [
    "event:a-intent",
    "event:a-outcome",
  ]);
  const eventIds = new Set(events.map((e) => `event:${e.eventId}`));
  for (const observation of captured) {
    assert.ok(observation.sourceIds.length > 0);
    assert.ok(observation.sourceIds.every((id) => eventIds.has(id)));
  }
  const receipts = memoryRecords(fx.store);
  assert.equal(receipts.length, 2);
  for (const entry of receipts) {
    const record = entry.record as {
      sourceIds: string[];
      claimArtifactId: string;
      extractionRevision: string;
    };
    assert.ok(record.sourceIds.every((id) => eventIds.has(id)));
    assert.equal(fx.store.get(record.claimArtifactId).kind, "artifact");
    assert.equal(record.extractionRevision, "extractive-v1");
  }
  assert.equal(
    fx.memory.cursor("w-demo", "s1"),
    fx.store.eventCursor("w-demo", "s1"),
  );

  const reopened = fx.reopen();
  assert.deepEqual(reopened.capture("w-demo", "s1"), []);
  assert.equal(memoryRecords(fx.store).length, 2);
  commit(fx.store, turn("b", "src/db/pool.ts", "Pool size raised."));
  assert.equal(reopened.capture("w-demo", "s1").length, 1);
  assert.equal(memoryRecords(fx.store).length, 3);
});

test("M1: a crash after the store commit but before the projection commit never duplicates receipts", async (t) => {
  const fx = setup(t);
  commit(
    fx.store,
    turn("a", "src/auth/login.ts", "Login now validates tokens."),
  );
  fx.closeMemory();
  const before = join(fx.dir, "memory-before.db");
  fx.copyMemoryTo(before);
  fx.openMemory().capture("w-demo", "s1");
  fx.closeMemory();
  fx.replaceMemoryWith(before); // projection and cursor lost, store receipts kept
  const memory = fx.openMemory();
  assert.equal(memory.cursor("w-demo", "s1"), 0);
  assert.equal(memory.capture("w-demo", "s1").length, 1);
  assert.equal(memoryRecords(fx.store).length, 1);
  assert.equal(
    memory.cursor("w-demo", "s1"),
    fx.store.eventCursor("w-demo", "s1"),
  );
  const [hit] = await memory.query("w-demo", "login", 1);
  assert.match(hit?.text ?? "", /login/);
});

test("M1: capture continues after a mid-session deletion and never reads the deleted event", async (t) => {
  const fx = setup(t);
  commit(fx.store, turn("a", "src/canary.ts", "canary plan zebra"));
  assert.equal(fx.memory.capture("w-demo", "s1").length, 1);
  commit(fx.store, turn("b", "src/bravo.ts", "bravo work"));
  fx.store.noteDeletion("event:a-outcome");
  commit(fx.store, turn("c", "src/charlie.ts", "charlie work"));
  const captured = fx.memory.capture("w-demo", "s1");
  assert.deepEqual(
    captured.map((o) => o.sourceIds),
    [
      ["event:b-intent", "event:b-outcome"],
      ["event:c-intent", "event:c-outcome"],
    ],
  );
  assert.equal(
    fx.memory.cursor("w-demo", "s1"),
    fx.store.eventCursor("w-demo", "s1"),
  );
  assert.deepEqual(await fx.memory.query("w-demo", "canary zebra", 5), []);
  assert.equal(
    (await fx.memory.query("w-demo", "charlie", 1))[0]?.sourceIds[0],
    "event:c-intent",
  );
  const reopened = fx.reopen();
  assert.deepEqual(reopened.capture("w-demo", "s1"), []);
  assert.deepEqual(await reopened.query("w-demo", "canary zebra", 5), []);
});

test("M1: uncited or foreign-cited drafts are rejected and commit nothing", (t) => {
  for (const sourceIds of [[], ["event:not-in-this-session"]]) {
    const fx = setup(t, {
      extract: () => [{ text: "unsupported claim", sourceIds }],
    });
    commit(fx.store, turn("a", "src/a.ts", "Done."));
    assert.throws(
      () => fx.memory.capture("w-demo", "s1"),
      code("UNCITED_OBSERVATION"),
    );
    assert.equal(memoryRecords(fx.store).length, 0);
    assert.equal(fx.memory.cursor("w-demo", "s1"), 0);
  }
});

test("M1: a summary that lands after a deletion of its source is rejected", async (t) => {
  let fx: ReturnType<typeof setup>;
  fx = setup(t, {
    extract: (events, after) => {
      const drafts = extractive(events, after);
      fx.store.noteDeletion(drafts[0]?.sourceIds[0] ?? ""); // deletion races the slow summarizer
      return drafts;
    },
  });
  commit(fx.store, turn("a", "src/a.ts", "Done."));
  assert.throws(
    () => fx.memory.capture("w-demo", "s1"),
    code("STALE_DELETION_EPOCH"),
  );
  assert.equal(fx.memory.cursor("w-demo", "s1"), 0);
  assert.deepEqual(await fx.memory.query("w-demo", "src a done", 5), []);
});

test("M1: optional memory imports are limited to request-time native host loading", () => {
  const root = new URL("../../", import.meta.url);
  const importsOptional =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'][^"']*(?:splyce-memory|splyce-retrieval|@splyce\/(?:memory|retrieval))/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "target")
        continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mts|mjs|js|svelte)$/.test(name)) {
        const source = readFileSync(path, "utf8");
        // The native provider loads selected memory on request; startup is independently checked by a runtime import guard.
        const checked =
          name === "native-host.mjs"
            ? source.replace(/\bimport\s*\(\s*["'][^"']+["']\s*\)/g, "")
            : source;
        if (importsOptional.test(checked)) offenders.push(path);
      }
    }
  };
  for (const dir of ["packages/splyce-pi/src", "apps/desktop/src"])
    walk(fileURLToPath(new URL(dir, root)));
  if (
    importsOptional.test(
      readFileSync(
        fileURLToPath(new URL("scripts/build-engine.mjs", root)),
        "utf8",
      ),
    )
  )
    offenders.push("scripts/build-engine.mjs");
  assert.deepEqual(offenders, []);
});
