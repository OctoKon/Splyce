import { RUN_STATES } from "./contracts.js";

export const PAGE_READ_OPS = [
  "sessions.list",
  "memory.list",
  "memory.search",
  "usage.read",
] as const;
export type PageReadOp = (typeof PAGE_READ_OPS)[number];
export interface PageReadRequest {
  requestId: string;
  workspaceId: string;
  query?: string;
}
export interface SessionSummary {
  sessionId: string;
  branchAnchorId: string | null;
  createdAt: string;
  updatedAt: string;
  state: "idle" | (typeof RUN_STATES)[number];
}
export interface MemorySummary {
  observationId: string;
  sessionId: string;
  createdAt: string;
  sourceCount: number;
}
export interface PageReadResults {
  "sessions.list": { sessions: SessionSummary[]; truncated: boolean };
  "memory.list": { entries: MemorySummary[]; truncated: boolean };
  "memory.search": { entries: MemorySummary[]; truncated: boolean };
  "usage.read": {
    semantics: "unavailable";
    inputTokens: null;
    outputTokens: null;
    costUsd: null;
    sessionCount: number;
    runCount: number;
  };
}
export class PageReadError extends Error {
  constructor(
    public readonly code: "PAGE_READ_INVALID" | "PAGE_READ_UNAVAILABLE",
  ) {
    super("Page data unavailable");
    this.name = "PageReadError";
  }
}
const invalid = (): never => {
  throw new PageReadError("PAGE_READ_INVALID");
};
function fields(
  raw: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(raw, key))
  )
    invalid();
  return raw as Record<string, unknown>;
}
const id = (raw: unknown): raw is string =>
  typeof raw === "string" &&
  raw.length > 0 &&
  new TextEncoder().encode(raw).length <= 128 &&
  !/[\s\p{Cc}\\/]/u.test(raw);
const uint = (raw: unknown) =>
  Number.isSafeInteger(raw) && (raw as number) >= 0;
const date = (raw: unknown) =>
  typeof raw === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw) &&
  Number.isFinite(Date.parse(raw)) &&
  new Date(raw).toISOString() === raw;

export function validatePageReadRequest(
  op: PageReadOp,
  raw: unknown,
): PageReadRequest {
  if (!PAGE_READ_OPS.includes(op)) invalid();
  const value = fields(
    raw,
    op === "memory.search"
      ? ["requestId", "workspaceId", "query"]
      : ["requestId", "workspaceId"],
  );
  if (!id(value.requestId) || !id(value.workspaceId)) invalid();
  if (
    op === "memory.search" &&
    (typeof value.query !== "string" ||
      !value.query.trim() ||
      new TextEncoder().encode(value.query).length > 1024 ||
      /\p{Cc}/u.test(value.query))
  )
    invalid();
  return value as unknown as PageReadRequest;
}

export function validatePageReadResult<O extends PageReadOp>(
  op: O,
  raw: unknown,
): PageReadResults[O] {
  if (!PAGE_READ_OPS.includes(op)) invalid();
  if (op === "usage.read") {
    const v = fields(raw, [
      "semantics",
      "inputTokens",
      "outputTokens",
      "costUsd",
      "sessionCount",
      "runCount",
    ]);
    if (
      v.semantics !== "unavailable" ||
      v.inputTokens !== null ||
      v.outputTokens !== null ||
      v.costUsd !== null ||
      !uint(v.sessionCount) ||
      !uint(v.runCount)
    )
      invalid();
  } else {
    const key = op === "sessions.list" ? "sessions" : "entries";
    const v = fields(raw, [key, "truncated"]);
    const rows = v[key];
    if (
      !Array.isArray(rows) ||
      rows.length > (op === "memory.search" ? 50 : 100) ||
      typeof v.truncated !== "boolean"
    )
      invalid();
    const seen = new Set<string>();
    for (const row of rows as unknown[]) {
      if (op === "sessions.list") {
        const s = fields(row, [
          "sessionId",
          "branchAnchorId",
          "createdAt",
          "updatedAt",
          "state",
        ]);
        if (
          !id(s.sessionId) ||
          !(s.branchAnchorId === null || id(s.branchAnchorId)) ||
          !date(s.createdAt) ||
          !date(s.updatedAt) ||
          !["idle", ...RUN_STATES].includes(s.state as "idle") ||
          seen.has(s.sessionId)
        )
          invalid();
        seen.add(s.sessionId as string);
      } else {
        const m = fields(row, [
          "observationId",
          "sessionId",
          "createdAt",
          "sourceCount",
        ]);
        if (
          !id(m.observationId) ||
          !id(m.sessionId) ||
          !date(m.createdAt) ||
          !uint(m.sourceCount) ||
          seen.has(m.observationId)
        )
          invalid();
        seen.add(m.observationId as string);
      }
    }
  }
  return raw as PageReadResults[O];
}
