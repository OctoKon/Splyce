// TD-43 optional dense signal: symbol-level chunks, injected embedding port,
// brute-force cosine, Reciprocal Rank Fusion.
// ponytail: EmbeddingPort and RRF duplicate packages/splyce-retrieval (~50
// lines); unify onto that package after the expo.

import type { OutlineSymbol } from "./graph.js";

export interface EmbeddingPort {
  readonly modelId: string;
  readonly dimensions: number;
  embed(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Float32Array[]>;
}

export interface Chunk {
  /** 1-based inclusive line range. */
  readonly start: number;
  readonly end: number;
  /** Unit-normalized. */
  readonly vec: Float32Array;
}

const MAX_CHUNK_LINES = 80;
const PLAIN_CHUNK_LINES = 60;
const MAX_CHUNK_CHARS = 2000;
export const EMBED_BATCH = 64;
export const RRF_K = 60;

/** One chunk per top-level symbol (capped), else fixed windows. */
export function chunkRanges(
  lines: readonly string[],
  symbols: readonly OutlineSymbol[] | null,
): { start: number; end: number }[] {
  const n = lines.length;
  const starts = symbols?.length ? symbols.map((s) => s.line) : [];
  if (!starts.length) {
    const out: { start: number; end: number }[] = [];
    for (let s = 1; s <= n; s += PLAIN_CHUNK_LINES)
      out.push({ start: s, end: Math.min(n, s + PLAIN_CHUNK_LINES - 1) });
    return out;
  }
  if (starts[0]! > 1) starts.unshift(1); // header/imports before first symbol
  return starts.map((start, i) => ({
    start,
    end: Math.min((starts[i + 1] ?? n + 1) - 1, start + MAX_CHUNK_LINES - 1),
  }));
}

export function chunkText(
  path: string,
  lines: readonly string[],
  r: { start: number; end: number },
): string {
  return `${path}\n${lines.slice(r.start - 1, r.end).join("\n")}`.slice(
    0,
    MAX_CHUNK_CHARS,
  );
}

/** Validate port output and unit-normalize; throws on a contract breach. */
export async function embedChecked(
  port: EmbeddingPort,
  texts: readonly string[],
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const vecs = await port.embed(batch);
    if (!Array.isArray(vecs) || vecs.length !== batch.length)
      throw new Error(
        `embedding port returned ${String(vecs?.length)} vectors for ${String(batch.length)} texts`,
      );
    for (const v of vecs) {
      if (
        !(v instanceof Float32Array) ||
        v.length !== port.dimensions ||
        !v.every(Number.isFinite)
      )
        throw new Error(
          `embedding port returned a vector that is not Float32Array[${String(port.dimensions)}]`,
        );
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm);
      out.push(norm ? v.map((x) => x / norm) : new Float32Array(v.length));
    }
  }
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export const encodeVec = (v: Float32Array): string =>
  Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");

export function decodeVec(s: string, dims: number): Float32Array | null {
  const buf = Buffer.from(s, "base64");
  if (buf.byteLength !== dims * 4) return null;
  const v = new Float32Array(dims);
  new Uint8Array(v.buffer).set(buf);
  return v.every(Number.isFinite) ? v : null;
}

/** RRF over ranked id lists; returns fused score plus each signal's rank. */
export function reciprocalRankFusion(
  lists: Readonly<Record<string, readonly string[]>>,
  k = RRF_K,
): Map<string, { score: number; ranks: Record<string, number> }> {
  const fused = new Map<
    string,
    { score: number; ranks: Record<string, number> }
  >();
  for (const [signal, ids] of Object.entries(lists))
    ids.forEach((id, i) => {
      const e = fused.get(id) ?? { score: 0, ranks: {} };
      e.score += 1 / (k + i + 1);
      e.ranks[signal] = i + 1;
      fused.set(id, e);
    });
  return fused;
}
