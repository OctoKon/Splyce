// Shared TD-39/TD-40 fixture: a real Store and memory file in a temp dir, and
// event drafts shaped like the engine's committed turn evidence.
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Memory,
  type MemoryOptions,
} from "../../packages/splyce-memory/dist/memory.js";
import type { SplyceEventDraft } from "../../packages/splyce-pi/dist/contracts.js";
import { Store } from "../../packages/splyce-pi/dist/store.js";
import type { EmbeddingPort } from "../../packages/splyce-retrieval/dist/retrieval.js";

const records = JSON.parse(
  readFileSync(
    new URL("../fixtures/contracts/records.json", import.meta.url),
    "utf8",
  ),
);
export const caller = (sessionId = "s1") => ({
  sessionId,
  configRevision: "cfg-0",
  profileRevision: "profile1",
  policyRevision: "policy1",
  resolveReference: () => true,
});
const base = (eventId: string, scopeId: string, sessionId: string) => ({
  schemaVersion: 1 as const,
  protocolVersion: 2 as const,
  eventId,
  recordId: `run-${scopeId}`,
  createdAt: "2026-10-27T00:00:00.000Z",
  sourceIds: [`run-${scopeId}`],
  sessionId,
  scopeId,
  durable: true,
});
/** One committed tool call (intent + outcome) writing `path` with a summary. */
export function turn(
  id: string,
  path: string,
  summary: string,
  scopeId = "w-demo",
  sessionId = "s1",
): SplyceEventDraft[] {
  return [
    {
      ...base(`${id}-intent`, scopeId, sessionId),
      kind: "turn.tool_intent",
      payload: {
        runId: "r1",
        actionId: `${id}-act`,
        capabilityId: "fs.write",
        target: "workspace",
        argsSummary: `${path}: ${summary}`,
      },
    },
    {
      ...base(`${id}-outcome`, scopeId, sessionId),
      kind: "turn.tool_outcome",
      payload: { runId: "r1", actionId: `${id}-act`, status: "success" },
    },
  ];
}
/** Commits drafts, first creating the scope's source run receipt if needed. */
export function commit(
  store: Store,
  drafts: SplyceEventDraft[],
  scopeId = "w-demo",
  sessionId = "s1",
) {
  const runId = `run-${scopeId}`;
  let receipts: Array<{ kind: "run"; record: unknown }> = [];
  try {
    store.get(runId);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "STORE_NOT_FOUND") throw error;
    receipts = [
      {
        kind: "run",
        record: {
          ...records.run,
          recordId: runId,
          scopeId,
          workspaceId: scopeId,
        },
      },
    ];
  }
  return store.commitEvents(receipts, drafts, caller(sessionId)).events;
}

/** Deterministic bag-of-words hash embedding; a port fixture, not the system under test. */
export function fakeEmbedding(
  modelId = "fake-a",
  dimensions = 32,
): EmbeddingPort & { calls: number } {
  return {
    modelId,
    dimensions,
    calls: 0,
    async embed(texts) {
      this.calls += 1;
      return texts.map((text) => {
        const vector = new Float32Array(dimensions);
        for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          let hash = modelId.length;
          for (const char of token)
            hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
          vector[hash % dimensions] = (vector[hash % dimensions] ?? 0) + 1;
        }
        return vector;
      });
    },
  };
}

export function setup(
  t: { after: (fn: () => void) => void },
  options: MemoryOptions = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "splyce-memory-"));
  const storePath = join(dir, "store.db");
  const memoryPath = join(dir, "memory.db");
  let store = Store.open(storePath);
  let memory: Memory | undefined = Memory.open(store, memoryPath, options);
  t.after(() => {
    memory?.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    storePath,
    memoryPath,
    get store() {
      return store;
    },
    get memory(): Memory {
      if (memory === undefined) throw new Error("memory is closed");
      return memory;
    },
    closeMemory() {
      memory?.close();
      memory = undefined;
    },
    /** Closes both, then reopens the real store and memory files. */
    reopen(next: MemoryOptions = options) {
      memory?.close();
      store.close();
      store = Store.open(storePath);
      memory = Memory.open(store, memoryPath, next);
      return memory;
    },
    openMemory(next: MemoryOptions = options) {
      memory = Memory.open(store, memoryPath, next);
      return memory;
    },
    copyMemoryTo(target: string) {
      copyFileSync(memoryPath, target);
    },
    replaceMemoryWith(source: string) {
      for (const suffix of ["-wal", "-shm"])
        if (existsSync(memoryPath + suffix)) rmSync(memoryPath + suffix);
      copyFileSync(source, memoryPath);
    },
  };
}

export const memoryRecords = (store: Store, scopeId = "w-demo") =>
  store
    .list(scopeId)
    .records.filter((entry) => entry.kind === "memoryObservation");
