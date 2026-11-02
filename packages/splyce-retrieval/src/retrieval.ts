// Reusable retrieval core (memory now, code index later): BM25 lexical,
// optional dense vectors through an injected EmbeddingPort, a HippoRAG-style
// entity graph ranked by Personalized PageRank, and Reciprocal Rank Fusion.
// All indexes live in the caller's node:sqlite database under `rx_` tables and
// are projections: `remove` purges a document from every one of them. Text is
// secret-redacted and length-capped before it reaches any index or the port.
// Stdlib only; this module never touches the network and does nothing at import.

import type { DatabaseSync } from "node:sqlite";

/** Embedding provider port; bound by the host to a profile `embed` role. */
export interface EmbeddingPort {
  readonly modelId: string;
  readonly dimensions: number;
  embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Float32Array[]>;
}
/** Same shape as the TD-16 provider-auth Redactor. */
export type Redactor = (text: string) => string;
export interface RetrievalDoc {
  id: string;
  scopeId: string;
  text: string;
}
export interface Scored {
  id: string;
  score: number;
}
export type SignalName = "lexical" | "dense" | "graph";
export interface FusedHit {
  id: string;
  /** RRF score. */
  score: number;
  signals: Partial<Record<SignalName, { rank: number; score: number }>>;
}
export interface RetrievalOptions {
  /** Dense retrieval is off unless a port is supplied. */
  embedding?: EmbeddingPort;
}

export class RetrievalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RetrievalError";
    this.code = code;
  }
}

export const LIMITS = Object.freeze({
  docChars: 8000,
  queryChars: 1000,
  queryTerms: 64,
  entitiesPerDoc: 32,
  seedEntities: 16,
  graphDocs: 500,
  pprIterations: 20,
});

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]{0,40}KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}KEY-----|$)/g,
    "[REDACTED]",
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "[REDACTED]",
  ],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, "[REDACTED]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]"],
  [
    // No `.` in the key: `token.ts: summary` is a file path, not a credential.
    /\b([A-Za-z0-9_-]{0,40}(?:key|secret|token|password|passwd|pwd)[A-Za-z0-9_-]{0,40})(\s{0,4}[:=]\s{0,4})("[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s,;&]+)/gi,
    "$1$2[REDACTED]",
  ],
];
/** Built-in redaction of common secret shapes (tokens, keys, PEM blocks, key=value credentials). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    out = out.replace(pattern, replacement);
  return out;
}

export const tokens = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
const queryText = (text: string): string => text.slice(0, LIMITS.queryChars);
const queryTerms = (text: string): string[] =>
  [...new Set(tokens(queryText(text)))].slice(0, LIMITS.queryTerms);

const FILE_EXTENSION =
  /\.(?:ts|tsx|js|mjs|cjs|rs|svelte|json|md|py|toml|ya?ml|css|html|sql)$/i;
/**
 * Entities: file paths, identifiers, named things, quoted terms and decisions.
 * Lowercased, `/`-normalized. Every pattern is a single bounded pass (no
 * nested quantifiers), and input is capped, so cost is linear in the text.
 */
export function extractEntities(input: string): string[] {
  const text = input.slice(0, LIMITS.docChars);
  const found = new Set<string>();
  const add = (raw: string) => {
    if (raw.length > 240) return;
    const entity = raw
      .replace(/\\/g, "/")
      .replace(/^[/.]+|[/.,;:-]+$/g, "")
      .toLowerCase();
    if (entity.length > 1 && entity.length <= 120) found.add(entity);
  };
  for (const [run] of text.matchAll(/[\w.\\/-]+/g))
    if (/[\\/]/.test(run) || FILE_EXTENSION.test(run)) add(run);
  let named: string[] = [];
  let namedEnd = -1;
  const flushNamed = () => {
    if (named.length > 1) add(named.join(" "));
    named = [];
  };
  for (const match of text.matchAll(/[A-Za-z0-9_]+/g)) {
    const word = match[0];
    if (
      /^[a-z]+[A-Z]/.test(word) ||
      /^[A-Z][a-z0-9]+[A-Z]/.test(word) ||
      /^[A-Z][A-Z0-9_]{2,}$/.test(word) ||
      (/^[a-z0-9][a-z0-9_]*$/.test(word) && /[a-z0-9]_[a-z0-9]/.test(word))
    )
      add(word);
    const gap = text.slice(namedEnd, match.index);
    if (/^[A-Z][a-z]+$/.test(word)) {
      if (namedEnd < 0 || !/^\s{1,4}$/.test(gap)) flushNamed();
      named.push(word);
    } else flushNamed();
    namedEnd = match.index + word.length;
  }
  flushNamed();
  for (const match of text.matchAll(/`([^`\n]{1,80})`|"([^"\n]{2,60})"/g))
    add(match[1] ?? match[2] ?? "");
  for (const match of text.matchAll(
    /\b(?:decided|decision|chose|switched to|will use)\b[^.\n]{0,80}/gi,
  ))
    add(`decision:${match[0]}`);
  // ponytail: cap keeps co-occurrence edges O(32^2) per doc; raise with a relation extractor.
  return [...found].slice(0, LIMITS.entitiesPerDoc);
}

/** Reciprocal Rank Fusion; each list must be best-first. */
export function rrf(
  lists: Partial<Record<SignalName, Scored[]>>,
  k = 60,
): FusedHit[] {
  const fused = new Map<string, FusedHit>();
  for (const [name, list] of Object.entries(lists) as Array<
    [SignalName, Scored[]]
  >)
    list.forEach(({ id, score }, index) => {
      const hit = fused.get(id) ?? { id, score: 0, signals: {} };
      hit.score += 1 / (k + index + 1);
      hit.signals[name] = { rank: index + 1, score };
      fused.set(id, hit);
    });
  return [...fused.values()].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
}

const top = (scores: Map<string, number>, limit: number): Scored[] =>
  [...scores]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id, score]) => ({ id, score }));

export class RetrievalIndex {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: RetrievalOptions = {},
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS rx_docs (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, text TEXT NOT NULL, length INTEGER NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS rx_docs_scope ON rx_docs (scope_id);" +
        "CREATE TABLE IF NOT EXISTS rx_postings (term TEXT NOT NULL, doc_id TEXT NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY (term, doc_id));" +
        "CREATE TABLE IF NOT EXISTS rx_doc_entities (doc_id TEXT NOT NULL, entity TEXT NOT NULL, PRIMARY KEY (doc_id, entity));" +
        "CREATE INDEX IF NOT EXISTS rx_entity_docs ON rx_doc_entities (entity);" +
        "CREATE TABLE IF NOT EXISTS rx_edges (doc_id TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (doc_id, a, b));" +
        "CREATE TABLE IF NOT EXISTS rx_vectors (doc_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS rx_vector_stamp (scope_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, dimensions INTEGER NOT NULL);",
    );
  }

  /** Adds redacted, capped documents to the lexical and graph indexes (idempotent per id). Run inside the caller's transaction for atomicity; vectors are built lazily. */
  add(docs: readonly RetrievalDoc[]): void {
    for (const doc of docs) {
      const text = redactSecrets(doc.text).slice(0, LIMITS.docChars);
      const terms = tokens(text);
      const inserted = this.db
        .prepare(
          "INSERT OR IGNORE INTO rx_docs (id, scope_id, text, length) VALUES (?, ?, ?, ?)",
        )
        .run(doc.id, doc.scopeId, text, terms.length);
      if (Number(inserted.changes) === 0) continue;
      const tf = new Map<string, number>();
      for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
      for (const [term, count] of tf)
        this.db
          .prepare(
            "INSERT INTO rx_postings (term, doc_id, tf) VALUES (?, ?, ?)",
          )
          .run(term, doc.id, count);
      const entities = extractEntities(text);
      for (const entity of entities)
        this.db
          .prepare("INSERT INTO rx_doc_entities (doc_id, entity) VALUES (?, ?)")
          .run(doc.id, entity);
      entities.forEach((a, i) =>
        entities
          .slice(i + 1)
          .forEach((b) =>
            this.db
              .prepare(
                "INSERT OR IGNORE INTO rx_edges (doc_id, a, b) VALUES (?, ?, ?)",
              )
              .run(doc.id, a, b),
          ),
      );
    }
  }

  /** Purges documents from every index: lexical, graph and vectors. */
  remove(ids: readonly string[]): void {
    for (const id of ids)
      for (const table of [
        "rx_postings",
        "rx_doc_entities",
        "rx_edges",
        "rx_vectors",
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE doc_id = ?`).run(id);
    for (const id of ids)
      this.db.prepare("DELETE FROM rx_docs WHERE id = ?").run(id);
  }

  has(id: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM rx_docs WHERE id = ?").get(id) !==
      undefined
    );
  }

  /** BM25 (k1 1.2, b 0.75) within one scope. */
  lexical(scopeId: string, text: string, limit: number): Scored[] {
    const stats = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(AVG(length), 0) AS avg FROM rx_docs WHERE scope_id = ?",
      )
      .get(scopeId) as { n: number; avg: number };
    const scores = new Map<string, number>();
    for (const term of queryTerms(text)) {
      const rows = this.db
        .prepare(
          "SELECT p.doc_id AS id, p.tf AS tf, d.length AS len FROM rx_postings p JOIN rx_docs d ON d.id = p.doc_id WHERE p.term = ? AND d.scope_id = ?",
        )
        .all(term, scopeId) as Array<{ id: string; tf: number; len: number }>;
      const idf = Math.log(
        1 + (stats.n - rows.length + 0.5) / (rows.length + 0.5),
      );
      for (const { id, tf, len } of rows)
        scores.set(
          id,
          (scores.get(id) ?? 0) +
            (idf * tf * 2.2) /
              (tf + 1.2 * (0.25 + (0.75 * len) / (stats.avg || 1))),
        );
    }
    return top(scores, limit);
  }

  /**
   * HippoRAG-style recall: Personalized PageRank over entity and passage nodes
   * (passage-entity and entity co-occurrence edges), seeded by the top entities
   * matching the query, run on the bounded 2-hop neighbourhood of those seeds
   * and read back on passage nodes.
   */
  graph(scopeId: string, text: string, limit: number): Scored[] {
    const terms = queryTerms(text);
    const queryEntities = new Set(extractEntities(queryText(text)));
    const candidates = new Set<string>(queryEntities);
    // ponytail: LIKE scans the scope's entity rows per term; add an entity-term table if scopes grow past ~50k docs.
    for (const term of terms)
      for (const row of this.db
        .prepare(
          "SELECT DISTINCT e.entity AS entity FROM rx_doc_entities e JOIN rx_docs d ON d.id = e.doc_id WHERE d.scope_id = ? AND instr(e.entity, ?) > 0 LIMIT 64",
        )
        .all(scopeId, term) as Array<{ entity: string }>)
        candidates.add(row.entity);
    const termSet = new Set(terms);
    const seeds = new Map(
      [...candidates]
        .map((entity): [string, number] => {
          const parts = tokens(entity);
          const hits = parts.filter((part) => termSet.has(part)).length;
          return [
            `e:${entity}`,
            queryEntities.has(entity) ? 1 : hits / Math.max(parts.length, 1),
          ];
        })
        .filter(([, weight]) => weight > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, LIMITS.seedEntities),
    );
    const total = [...seeds.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    for (const [node, weight] of seeds) seeds.set(node, weight / total);

    const json = (values: Iterable<string>) => JSON.stringify([...values]);
    const docsOf = (entities: Iterable<string>) =>
      (
        this.db
          .prepare(
            "SELECT DISTINCT e.doc_id AS doc FROM rx_doc_entities e JOIN rx_docs d ON d.id = e.doc_id WHERE d.scope_id = ? AND e.entity IN (SELECT value FROM json_each(?)) LIMIT ?",
          )
          .all(scopeId, json(entities), LIMITS.graphDocs) as Array<{
          doc: string;
        }>
      ).map((row) => row.doc);
    const hop1 = docsOf([...seeds.keys()].map((node) => node.slice(2)));
    const bridge = (
      this.db
        .prepare(
          "SELECT DISTINCT entity FROM rx_doc_entities WHERE doc_id IN (SELECT value FROM json_each(?))",
        )
        .all(json(hop1)) as Array<{ entity: string }>
    ).map((row) => row.entity);
    const docs = json(new Set([...hop1, ...docsOf(bridge)]));
    const links = this.db
      .prepare(
        "SELECT doc_id AS doc, entity FROM rx_doc_entities WHERE doc_id IN (SELECT value FROM json_each(?))",
      )
      .all(docs) as Array<{ doc: string; entity: string }>;
    const edges = this.db
      .prepare(
        "SELECT a, b FROM rx_edges WHERE doc_id IN (SELECT value FROM json_each(?))",
      )
      .all(docs) as Array<{ a: string; b: string }>;

    const adjacency = new Map<string, Map<string, number>>();
    const link = (a: string, b: string) => {
      for (const [x, y] of [
        [a, b],
        [b, a],
      ] as const) {
        const row = adjacency.get(x) ?? new Map<string, number>();
        row.set(y, (row.get(y) ?? 0) + 1);
        adjacency.set(x, row);
      }
    };
    for (const { doc, entity } of links) link(`d:${doc}`, `e:${entity}`);
    for (const { a, b } of edges) link(`e:${a}`, `e:${b}`);

    const restart = 0.5;
    const degree = new Map(
      [...adjacency].map(([node, row]) => [
        node,
        [...row.values()].reduce((a, b) => a + b, 0),
      ]),
    );
    let rank = new Map(seeds);
    for (let i = 0; i < LIMITS.pprIterations; i += 1) {
      const next = new Map<string, number>();
      for (const [node, weight] of seeds) next.set(node, restart * weight);
      for (const [node, value] of rank)
        for (const [neighbor, weight] of adjacency.get(node) ?? [])
          next.set(
            neighbor,
            (next.get(neighbor) ?? 0) +
              ((1 - restart) * value * weight) / (degree.get(node) ?? 1),
          );
      rank = next;
    }
    const passages = new Map<string, number>();
    for (const [node, value] of rank)
      if (node.startsWith("d:")) passages.set(node.slice(2), value);
    return top(passages, limit);
  }

  /** Calls the port; a provider failure surfaces with its message redacted. */
  private async embed(
    port: EmbeddingPort,
    texts: string[],
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    try {
      return await port.embed(texts, signal);
    } catch (error) {
      throw new RetrievalError(
        "EMBEDDING_FAILED",
        redactSecrets(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Embeds documents lacking a vector for the current port; a model or dimension change drops and rebuilds the scope's vectors. */
  async embedPending(scopeId: string, signal?: AbortSignal): Promise<number> {
    const port = this.options.embedding;
    if (port === undefined) return 0;
    if (!Number.isSafeInteger(port.dimensions) || port.dimensions < 1)
      throw new RetrievalError(
        "EMBEDDING_CONTRACT",
        "embedding dimensions must be a positive integer",
      );
    const stamp = this.db
      .prepare(
        "SELECT model_id, dimensions FROM rx_vector_stamp WHERE scope_id = ?",
      )
      .get(scopeId) as { model_id: string; dimensions: number } | undefined;
    if (
      stamp === undefined ||
      stamp.model_id !== port.modelId ||
      stamp.dimensions !== port.dimensions
    ) {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db
          .prepare(
            "DELETE FROM rx_vectors WHERE doc_id IN (SELECT id FROM rx_docs WHERE scope_id = ?)",
          )
          .run(scopeId);
        this.db
          .prepare(
            "INSERT INTO rx_vector_stamp (scope_id, model_id, dimensions) VALUES (?, ?, ?) ON CONFLICT(scope_id) DO UPDATE SET model_id = excluded.model_id, dimensions = excluded.dimensions",
          )
          .run(scopeId, port.modelId, port.dimensions);
        this.db.exec("COMMIT;");
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
        throw error;
      }
    }
    const pending = this.db
      .prepare(
        "SELECT id, text FROM rx_docs WHERE scope_id = ? AND id NOT IN (SELECT doc_id FROM rx_vectors) ORDER BY id",
      )
      .all(scopeId) as Array<{ id: string; text: string }>;
    let written = 0;
    for (let start = 0; start < pending.length; start += 64) {
      const batch = pending.slice(start, start + 64);
      const vectors = await this.embed(
        port,
        batch.map((doc) => doc.text),
        signal,
      );
      if (vectors.length !== batch.length)
        throw new RetrievalError(
          "EMBEDDING_CONTRACT",
          "embedding count does not match input count",
        );
      batch.forEach((doc, index) => {
        const vector = vectors[index];
        if (
          !(vector instanceof Float32Array) ||
          vector.length !== port.dimensions ||
          !vector.every(Number.isFinite)
        )
          throw new RetrievalError(
            "EMBEDDING_CONTRACT",
            "embedding has the wrong dimension or a non-finite value",
          );
        // Only for docs still present: a removal during the await is never undone.
        const result = this.db
          .prepare(
            "INSERT OR REPLACE INTO rx_vectors (doc_id, model_id, dimensions, vector) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM rx_docs WHERE id = ?)",
          )
          .run(
            doc.id,
            port.modelId,
            port.dimensions,
            new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
            doc.id,
          );
        written += Number(result.changes);
      });
    }
    return written;
  }

  /** Cosine similarity over the scope's vectors for the current port; [] when dense is off. */
  async dense(
    scopeId: string,
    text: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Scored[]> {
    const port = this.options.embedding;
    if (port === undefined) return [];
    await this.embedPending(scopeId, signal);
    const [query] = await this.embed(
      port,
      [redactSecrets(queryText(text))],
      signal,
    );
    if (!(query instanceof Float32Array) || query.length !== port.dimensions)
      throw new RetrievalError(
        "EMBEDDING_CONTRACT",
        "query embedding has the wrong dimension",
      );
    const norm = (v: Float32Array) =>
      Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
    const queryNorm = norm(query);
    // ponytail: brute-force O(n) cosine scan; add an ANN index past ~50k vectors.
    const rows = this.db
      .prepare(
        "SELECT v.doc_id AS id, v.vector AS vector FROM rx_vectors v JOIN rx_docs d ON d.id = v.doc_id WHERE d.scope_id = ? AND v.model_id = ? AND v.dimensions = ?",
      )
      .all(scopeId, port.modelId, port.dimensions) as Array<{
      id: string;
      vector: Uint8Array;
    }>;
    const scores = new Map<string, number>();
    for (const row of rows) {
      const bytes = row.vector.slice();
      const vector = new Float32Array(bytes.buffer, 0, port.dimensions);
      const dot = vector.reduce((sum, x, i) => sum + x * (query[i] ?? 0), 0);
      scores.set(row.id, dot / (norm(vector) * queryNorm));
    }
    return top(scores, limit);
  }

  /** Hybrid recall: RRF over BM25, dense (when a port is bound) and graph PPR. */
  async query(
    scopeId: string,
    text: string,
    limit = 10,
    signal?: AbortSignal,
  ): Promise<FusedHit[]> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RetrievalError(
        "INVALID_LIMIT",
        "limit must be a positive integer",
      );
    const depth = Math.max(limit * 3, 20);
    const lists: Partial<Record<SignalName, Scored[]>> = {
      lexical: this.lexical(scopeId, text, depth),
      graph: this.graph(scopeId, text, depth),
    };
    if (this.options.embedding !== undefined)
      lists.dense = await this.dense(scopeId, text, depth, signal);
    return rrf(lists).slice(0, limit);
  }
}
