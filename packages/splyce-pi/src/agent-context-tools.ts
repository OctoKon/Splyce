// Read-only agent tools over the workspace code index (@splyce/index) and the
// optional memory module (@splyce/memory), in the same shape as the workspace
// tools (name, description, parameters, execute -> text, result -> text +
// summary). Everything is bound to one admitted workspace root, output is
// capped, and every output is scrubbed. The index and memory are passed in
// structurally: this package cannot import them (memory depends on it).

import { scrubSecrets } from "./workspace-tools.js";

export type Redactor = (text: string) => string | Promise<string>;

/** Matches turn.tool_outcome.summary; bytes is the raw size before the output cap. */
export interface ToolSummary {
  exitCode?: number | null;
  durationMs: number;
  bytes: number;
  truncated: boolean;
  preview: string;
}
export interface ToolResult {
  text: string;
  summary: ToolSummary;
}
export interface ContextTool {
  name: string;
  description: string;
  readOnly: true;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    actionId?: string,
  ): Promise<string>;
  result(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    actionId?: string,
  ): Promise<ToolResult>;
}

/** Structural view of @splyce/index codeIndexTools(index) output. */
export interface CodeIndexToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: unknown,
    prepareOutput?: (value: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}
/** Structural view of @splyce/memory Memory. */
export interface MemoryLike {
  query(
    scopeId: string,
    text: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<
    readonly {
      observationId: string;
      text: string;
      sourceIds: readonly string[];
      score: number;
      createdAt: string;
    }[]
  >;
  capture(scopeId: string, sessionId: string): readonly unknown[];
}

export type ContextToolErrorCode =
  | "WORKSPACE_ESCAPE"
  | "ROOT_MISMATCH"
  | "BAD_ARGS"
  | "ABORTED"
  | "REDACTION_UNAVAILABLE";
export class ContextToolError extends Error {
  /** A ContextToolErrorCode, or the original failure's code (e.g. ENOENT) with a generic message. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ContextToolError";
    this.code = code;
  }
}

export interface AgentContextToolsOptions {
  /** Admitted canonical absolute workspace root. */
  workspaceRoot: string;
  /** The code index; its root must be the admitted root. */
  index: { root: string };
  /** codeIndexTools(index). */
  codeTools: readonly CodeIndexToolLike[];
  /** Enables memory_search; omit when the memory module is not installed. */
  memory?: MemoryLike;
  /** Memory scope bound by the host, never supplied by the model. */
  scopeId?: string;
  /** Applied to original output before the built-in scrub. */
  redact: Redactor;
}

/** Same 64 KB cap as the index tools. */
export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MEMORY_MAX_RESULTS = 20;
export const MEMORY_MAX_TEXT_CHARS = 2000;
const PREVIEW = 2048;

const fail = (code: ContextToolErrorCode, message: string): never => {
  throw new ContextToolError(code, message);
};
const normRoot = (p: string): string => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s;
};
/** Relative, no `..` segment, no drive/UNC/absolute prefix, no NUL. */
const confined = (value: unknown, what: string): void => {
  if (typeof value !== "string" || value === "")
    return fail("BAD_ARGS", `${what} must be a non-empty string`);
  const v = value.replace(/\\/g, "/");
  if (
    v.includes("\0") ||
    v.startsWith("/") ||
    /^[a-z]:/i.test(v) ||
    v.split("/").includes("..")
  )
    fail("WORKSPACE_ESCAPE", `${what} escapes the workspace`);
};
/** Redacts every string value of a JSON-like tree, so escaping by JSON.stringify cannot hide a secret. */
const redactDeep = async (
  value: unknown,
  redact: Redactor,
  onPreviewTruncated: () => void,
): Promise<unknown> => {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value)
      out.push(await redactDeep(v, redact, onPreviewTruncated));
    return out;
  }
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([k, v]) => {
          let safe = await redactDeep(v, redact, onPreviewTruncated);
          if (k === "preview" && typeof safe === "string") {
            const preview = safe.trim();
            if (preview.length > 200) onPreviewTruncated();
            safe = preview.slice(0, 200);
          }
          return [await redact(k), safe];
        }),
      ),
    );
  return value;
};
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};
/** Keeps the original code (ENOENT, INVALID_ARGUMENT, ...) but never its message, which can carry absolute paths. */
const generic = (name: string, error: unknown): ContextToolError => {
  if (error instanceof ContextToolError) return error;
  const raw = (error as { code?: unknown } | null)?.code;
  const code =
    typeof raw === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(raw)
      ? raw
      : "TOOL_FAILED";
  return new ContextToolError(code, `${name} failed (${code})`);
};
const PATH_ARGS = ["path", "target", "pathGlob"] as const;

const encoder = new TextEncoder();
function cap(text: string): {
  text: string;
  truncated: boolean;
  bytes: number;
} {
  const bytes = encoder.encode(text);
  if (bytes.length <= MAX_OUTPUT_BYTES)
    return { text, truncated: false, bytes: bytes.length };
  return {
    text: new TextDecoder().decode(bytes.slice(0, MAX_OUTPUT_BYTES)),
    truncated: true,
    bytes: bytes.length,
  };
}

export function createAgentContextTools(
  options: AgentContextToolsOptions,
): readonly ContextTool[] {
  const { workspaceRoot, index, codeTools, memory, scopeId, redact } = options;
  const clean = async (text: string): Promise<string> => {
    try {
      const safe = await redact(text);
      if (typeof safe === "string") return scrubSecrets(safe);
    } catch {
      // Never publish the input or an untrusted redactor error.
    }
    return fail("REDACTION_UNAVAILABLE", "[unavailable]");
  };
  if (normRoot(index.root) !== normRoot(workspaceRoot))
    fail("ROOT_MISMATCH", "code index is not bound to the admitted workspace");

  const tool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<{ value: unknown; truncated?: boolean }>,
  ): ContextTool => {
    const result = async (
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<ToolResult> => {
      if (signal?.aborted) fail("ABORTED", "aborted");
      if (!args || typeof args !== "object" || Array.isArray(args))
        fail("BAD_ARGS", "tool arguments must be an object");
      const started = Date.now();
      // Redact string fields before JSON escaping, then the whole text, and only then cap:
      // a secret straddling the cut is never half-kept. A throwing redactor is generic too.
      const out = await run(args, signal)
        .then(async ({ value, truncated = false }) => {
          const safe = await redactDeep(value, clean, () => {
            truncated = true;
          });
          const out = cap(await clean(JSON.stringify(safe)));
          return { ...out, truncated: truncated || out.truncated };
        })
        .catch((error: unknown) => {
          throw generic(name, error);
        });
      return {
        text: out.text,
        summary: {
          durationMs: Date.now() - started,
          bytes: out.bytes,
          truncated: out.truncated,
          preview: out.text.slice(0, PREVIEW),
        },
      };
    };
    return deepFreeze({
      name,
      description,
      readOnly: true,
      parameters: deepFreeze(JSON.parse(JSON.stringify(parameters))),
      execute: async (args, signal) => (await result(args, signal)).text,
      result,
    });
  };

  const code = codeTools.map((t) =>
    tool(t.name, t.description, t.parameters, async (args) => {
      for (const k of PATH_ARGS)
        if (args[k] !== undefined) confined(args[k], k);
      let truncated = false;
      const value = await t.execute(args, (output) =>
        redactDeep(output, clean, () => {
          truncated = true;
        }),
      );
      truncated ||=
        value !== null &&
        typeof value === "object" &&
        "truncated" in value &&
        value.truncated === true;
      return { value, truncated };
    }),
  );
  if (memory === undefined) return Object.freeze(code);
  if (scopeId === undefined || scopeId === "")
    return fail("BAD_ARGS", "scopeId is required with memory");
  return Object.freeze([
    ...code,
    tool(
      "memory_search",
      "Search cited memory observations captured from earlier turns of this workspace (read-only). Each result lists the source event ids it cites.",
      {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 512 },
          limit: { type: "integer", minimum: 1, maximum: MEMORY_MAX_RESULTS },
        },
      },
      async (args, signal) => {
        const { query, limit = 5 } = args;
        if (typeof query !== "string" || query === "" || query.length > 512)
          return fail("BAD_ARGS", "query must be a string of 1-512 chars");
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > MEMORY_MAX_RESULTS
        )
          return fail(
            "BAD_ARGS",
            `limit must be an integer 1-${MEMORY_MAX_RESULTS}`,
          );
        const hits = await memory.query(scopeId, query, limit, signal);
        const results = [];
        let truncated = hits.length > MEMORY_MAX_RESULTS;
        for (const h of hits.slice(0, MEMORY_MAX_RESULTS)) {
          const text = await clean(h.text);
          truncated ||= text.length > MEMORY_MAX_TEXT_CHARS;
          results.push({
            observationId: h.observationId,
            text: text.slice(0, MEMORY_MAX_TEXT_CHARS),
            sourceIds: h.sourceIds,
            score: h.score,
            createdAt: h.createdAt,
          });
        }
        return { value: { results }, truncated };
      },
    ),
  ]);
}

/**
 * After-turn memory capture: folds the session's newly committed durable
 * events into cited observations. Returns how many were captured. Errors
 * propagate; the caller decides whether a capture failure blocks the turn.
 *
 * Wired by native factory: not called from anywhere in this package.
 */
export function captureMemoryAfterTurn(
  memory: Pick<MemoryLike, "capture">,
  scopeId: string,
  sessionId: string,
): number {
  return memory.capture(scopeId, sessionId).length;
}
