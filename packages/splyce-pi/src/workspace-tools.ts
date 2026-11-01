// Admission-wrapped coding tools (read, ls, find, grep, edit, write, bash,
// powershell) for the agent loop. Every path is confined to the admitted
// workspace root; fs.write and shell.run need a one-time grant bound to the
// exact target, consumed before the effect, with one receipt per effect.
// fs.read runs on a session-scoped grant that is checked on every call but never
// consumed, and reads leave no receipt: only effects (writes, shell) do.
// Pi's own tool implementations are not imported: they need the built
// coding-agent package and @types/node, which this package's tsconfig excludes.

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { isSecretPath } from "./secret-path.js";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  rename,
  rm,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
export type Redactor = (text: string) => string | Promise<string>;

export type Capability = "fs.read" | "fs.write" | "shell.run";
export type GrantDenial = "GRANT_REQUIRED" | "GRANT_CONSUMED" | "GRANT_REVOKED";

export interface WorkspacePort {
  workspace(
    workspaceId: string,
  ):
    | { workspaceId: string; canonicalPath: string; revision: number }
    | undefined;
}
export interface Act {
  /** The tool call id; a once-grant is bound to it together with the digest. */
  actionId: string;
  /** sha256 hex of the canonical JSON of the call arguments. */
  argumentsDigest: string;
}
export interface Intent extends Act {
  capability: Capability;
  workspaceId: string;
  sessionId: string;
  /** Redacted effect target; the exact command stays in the transient grant request. */
  target: string;
  summary: string;
}
export interface GrantPort {
  check(
    req: {
      workspaceId: string;
      sessionId: string;
      capability: Capability;
      target: string;
    } & Act,
  ):
    | { ok: true; grantId: string; scope: "session" | "once" }
    | { ok: false; reason: GrantDenial };
  /** Atomic; must throw if the grant is already consumed or revoked. */
  consume(grantId: string, intent: Intent): void;
}
export interface ReceiptPort {
  record(effect: Intent & { ok: boolean }): string;
}

export type ErrorCode =
  | GrantDenial
  | "WORKSPACE_ESCAPE"
  | "WORKSPACE_UNKNOWN"
  | "STALE_REVISION"
  | "SHELL_TIMEOUT"
  | "SHELL_START_FAILED"
  | "EDIT_NOT_FOUND"
  | "EDIT_AMBIGUOUS"
  | "BAD_ARGS"
  | "PATTERN_REJECTED"
  | "GREP_BUDGET"
  | "RECEIPT_FAILED"
  | "REDACTION_UNAVAILABLE"
  | "ABORTED"
  | "IO_ERROR";

export class WorkspaceToolError extends Error {
  readonly code: ErrorCode;
  /** Set when a command was started and then killed. */
  readonly summary?: ToolSummary;
  constructor(code: ErrorCode, message: string, summary?: ToolSummary) {
    super(message);
    this.name = "WorkspaceToolError";
    this.code = code;
    if (summary) this.summary = summary;
  }
}

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
  /** Files a search skipped for size; kept outside summary, which is a strict wire shape. */
  skipped?: number;
}
export interface WorkspaceTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Shared canonical confinement check before dispatch can grant a file operation. */
  validatePath?(args: Record<string, unknown>): Promise<void>;
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    actionId?: string,
  ): Promise<string>;
  /** Same call as execute, with the structured summary beside the text. */
  result(
    args: Record<string, unknown>,
    signal?: AbortSignal,
    actionId?: string,
  ): Promise<ToolResult>;
}

export interface WorkspaceToolsOptions {
  workspaces: WorkspacePort;
  grants: GrantPort;
  receipts: ReceiptPort;
  sessionId: string;
  workspaceId: string;
  limits?: { timeoutMs: number; maxOutputBytes: number };
  /** TD-16 redactor for active credentials; applied to original text before the built-in scrub. */
  redact?: Redactor;
}

const MASK = "[REDACTED]";
// Built-in scrub for secret-shaped text in tool output (previews, model text, errors).
// shortcut: pattern list, not entropy detection; a bare unlabeled secret is not caught.
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    MASK,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, MASK],
  [/\bxox[a-z]-[A-Za-z0-9-]{8,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\beyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]*/g, MASK],
  [
    /(?<![\w.-])([\w.-]*(?:key|secret|token|passw(?:or)?d|pwd)[\w.-]*["']?[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi,
    `$1${MASK}`,
  ],
];
export const scrubSecrets = (text: string): string =>
  SECRET_PATTERNS.reduce((t, [re, to]) => t.replace(re, to), text);

const ENV_ALLOW = new Set(
  "PATH PATHEXT SYSTEMROOT WINDIR COMSPEC TEMP TMP TMPDIR HOME LANG TERM OS PROCESSOR_ARCHITECTURE NUMBER_OF_PROCESSORS".split(
    " ",
  ),
);
const SECRET = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_API_/i;
const win = process.platform === "win32";
const DEVICE =
  /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const MAX_READ_BYTES = 8 << 20;
const MAX_WALK_FILE_BYTES = 1 << 20;
const MAX_PATTERN = 256;
const GREP_FILE_MS = 400;
const MATCH_WORKER = `const { parentPort, workerData } = require("node:worker_threads");
const re = new RegExp(workerData.source, workerData.flags);
parentPort.postMessage("ready");
parentPort.on("message", (m) => {
  const hits = [];
  const ls = m.text.split("\\n");
  for (let i = 0; i < ls.length && hits.length < m.room; i++)
    if (re.test(ls[i].slice(0, m.maxLine))) hits.push(i);
  parentPort.postMessage(hits);
});`;
const MAX_GREP_SCAN_BYTES = 8 << 20;
// shortcut: lines are matched on their first 4096 chars to bound backtracking input.
const MAX_GREP_LINE = 4096;
// shortcut: flat check only; overlapping alternation like (a|aa)+ is not caught, the scan budget bounds it.
const NESTED_QUANTIFIER = /\([^()]*(?:[+*]|\{\d+,\})[^()]*\)(?:[+*]|\{\d+,\})/;

const fail = (code: ErrorCode, message: string): never => {
  throw new WorkspaceToolError(code, message);
};
const redactionUnavailable = () =>
  new WorkspaceToolError("REDACTION_UNAVAILABLE", "[unavailable]");
const escape = (): never =>
  fail("WORKSPACE_ESCAPE", "path escapes the workspace");

function scrubbedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && ENV_ALLOW.has(k.toUpperCase()) && !SECRET.test(k))
      env[k] = v;
  return env;
}

const encoder = new TextEncoder();
function cap(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; bytes: number } {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes)
    return { text, truncated: false, bytes: bytes.length };
  return {
    text: new TextDecoder().decode(bytes.slice(0, maxBytes)),
    truncated: true,
    bytes: bytes.length,
  };
}

/** Matches lines in a worker that is terminated when a match overruns or the call is aborted. */
function matcher(re: RegExp, signal?: AbortSignal) {
  const w = new Worker(MATCH_WORKER, {
    eval: true,
    workerData: { source: re.source, flags: re.flags },
  });
  let pending: ((r: number[] | WorkspaceToolError) => void) | undefined;
  // The time budget starts when the worker is up, not while it boots.
  let up: () => void;
  const ready = new Promise<void>((r) => (up = r));
  w.on("message", (m) => (m === "ready" ? up() : pending?.(m as number[])));
  let broken = false;
  w.on("error", () => {
    broken = true;
    up();
    pending?.(new WorkspaceToolError("IO_ERROR", "search worker failed"));
  });
  return {
    test: (text: string, room: number, ms: number) =>
      new Promise<number[]>((done, reject) => {
        const finish = (r: number[] | WorkspaceToolError) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          pending = undefined;
          if (r instanceof WorkspaceToolError) reject(r);
          else done(r);
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () =>
          finish(new WorkspaceToolError("ABORTED", "aborted"));
        signal?.addEventListener("abort", onAbort, { once: true });
        void ready.then(() => {
          if (signal?.aborted) return;
          if (broken)
            return finish(
              new WorkspaceToolError("IO_ERROR", "search worker failed"),
            );
          timer = setTimeout(
            () =>
              finish(
                new WorkspaceToolError(
                  "GREP_BUDGET",
                  "search exceeded its time budget",
                ),
              ),
            ms,
          );
          pending = finish;
          w.postMessage({ text, room, maxLine: MAX_GREP_LINE });
        });
      }),
    close: () => void w.terminate(),
  };
}

function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${re}$`);
}

const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map(
            (k) =>
              `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
          )
          .join(",")}}`
      : (JSON.stringify(v) ?? "null");
const act = (args: unknown, actionId?: string): Act => ({
  actionId: actionId ?? randomUUID(),
  argumentsDigest: createHash("sha256").update(canonical(args)).digest("hex"),
});

const str = (v: unknown, name: string): string =>
  typeof v === "string" ? v : fail("BAD_ARGS", `${name} must be a string`);
const optStr = (v: unknown, name: string): string | undefined =>
  v === undefined ? undefined : str(v, name);
const optNum = (v: unknown, def: number): number =>
  typeof v === "number" && v > 0 ? Math.floor(v) : def;

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });

export function createWorkspaceTools(
  opts: WorkspaceToolsOptions,
): Record<string, WorkspaceTool> {
  const { workspaces, grants, receipts, sessionId, workspaceId } = opts;
  const timeoutMs = opts.limits?.timeoutMs ?? 120_000;
  const maxBytes = opts.limits?.maxOutputBytes ?? 50 * 1024;
  const first =
    workspaces.workspace(workspaceId) ??
    fail("WORKSPACE_UNKNOWN", "workspace is not admitted");
  const revision = first.revision;

  const root = (): string => {
    const ws =
      workspaces.workspace(workspaceId) ??
      fail("WORKSPACE_UNKNOWN", "workspace is not admitted");
    if (ws.revision !== revision)
      fail("STALE_REVISION", "workspace revision changed");
    return ws.canonicalPath;
  };

  // Resolves the deepest existing ancestor through realpath so links and 8.3/case
  // variants are judged by where they really point, even when the leaf is new.
  async function confine(input: string): Promise<{ abs: string; rel: string }> {
    const base = root();
    if (input.includes("\0") || isSecretPath(input)) escape();
    if (win) {
      const segs = input.split(/[\\/]/);
      if (
        /^[\\/]{2}/.test(input) ||
        /^[a-zA-Z]:(?![\\/])/.test(input) ||
        input.replace(/^[a-zA-Z]:/, "").includes(":") ||
        segs.some(
          (s) => DEVICE.test(s) || (/[. ]$/.test(s) && s !== "." && s !== ".."),
        )
      )
        escape();
    }
    let cur = resolve(base, input);
    const tail: string[] = [];
    let real: string;
    for (;;) {
      try {
        real = await realpath(cur);
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "ENOENT")
          return fail("IO_ERROR", ioMessage(e, input));
        if (
          await lstat(cur).then(
            () => true,
            () => false,
          )
        )
          escape();
        const parent = dirname(cur);
        if (parent === cur) escape();
        tail.unshift(basename(cur));
        cur = parent;
      }
    }
    const abs = join(real, ...tail);
    const rel = relative(base, abs);
    if (
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      isSecretPath(rel)
    )
      escape();
    return { abs, rel: rel.split(sep).join("/") };
  }

  // The path may have been swapped for a link since the grant check: re-resolve
  // immediately before the fs operation.
  const recheck = async (input: string, abs: string, signal?: AbortSignal) => {
    if (signal?.aborted) fail("ABORTED", "aborted");
    if ((await confine(input)).abs !== abs) escape();
  };

  const ioMessage = (e: unknown, where: string) =>
    `${(e as { code?: string }).code ?? "error"}: ${where}`;
  const io = async <T>(where: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof WorkspaceToolError) throw e;
      return fail("IO_ERROR", ioMessage(e, where));
    }
  };

  const req = (capability: Capability, target: string, a: Act) => ({
    workspaceId,
    sessionId,
    capability,
    target,
    ...a,
  });
  function gate(capability: Capability, target: string, a: Act): string {
    const r = grants.check(req(capability, target, a));
    if (!r.ok) return fail(r.reason, `${capability} denied for ${target}`);
    if (capability !== "fs.read" && r.scope !== "once")
      return fail("GRANT_REQUIRED", `${capability} needs a one-time grant`);
    return r.grantId;
  }

  async function effect<T extends { summary: string; ok: boolean }>(
    capability: Capability,
    target: string,
    grantId: string,
    a: Act,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    // The grant check matches the exact target above; durable intent/receipt text is redacted.
    const intent = { ...req(capability, await clean(target), a), summary: "" };
    if (signal?.aborted) fail("ABORTED", "aborted");
    try {
      grants.consume(grantId, intent);
    } catch {
      const r = grants.check(req(capability, target, a));
      return fail(
        r.ok ? "GRANT_CONSUMED" : r.reason,
        `${capability} grant unusable for ${target}`,
      );
    }
    let out: T;
    try {
      out = await fn();
    } catch (e) {
      try {
        receipts.record({
          ...intent,
          summary: e instanceof WorkspaceToolError ? e.code : "failed",
          ok: false,
        });
      } catch {
        // the original failure is the one worth reporting
      }
      throw e;
    }
    try {
      receipts.record({ ...intent, summary: out.summary, ok: out.ok });
    } catch {
      return fail(
        "RECEIPT_FAILED",
        `${capability} effect may have happened; its receipt was not recorded`,
      );
    }
    return out;
  }

  // The destination is replaced by rename, never opened for writing, so a hard
  // link to a file outside the root is cut instead of written through.
  // shortcut: a new file gets default permissions, not the replaced file's mode.
  async function put(
    path: string,
    abs: string,
    data: string,
    signal?: AbortSignal,
  ) {
    await recheck(path, abs, signal);
    const missing: string[] = [];
    for (
      let d = dirname(abs);
      !(await lstat(d).then(
        () => true,
        () => false,
      ));
      d = dirname(d)
    )
      missing.unshift(d);
    for (const d of missing) {
      await mkdir(d);
      await recheck(path, abs, signal);
    }
    const tmp = join(dirname(abs), `.${basename(abs)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, data);
      await recheck(path, abs, signal);
      await rename(tmp, abs);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async function* walk(
    dir: string,
    relDir: string,
  ): AsyncGenerator<{ abs: string; rel: string; file: boolean }> {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.isSymbolicLink() || d.name === ".git" || isSecretPath(d.name))
        continue;
      const abs = join(dir, d.name);
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      if (d.isDirectory()) {
        yield { abs, rel, file: false };
        yield* walk(abs, rel);
      } else if (d.isFile()) yield { abs, rel, file: true };
    }
  }

  const PREVIEW = 2048;
  // Redact the whole text first so a secret straddling the preview cut is never half-kept.
  const clean = async (text: string): Promise<string> => {
    try {
      const safe = opts.redact ? await opts.redact(text) : text;
      if (typeof safe === "string") return scrubSecrets(safe);
    } catch {
      // Redactor failures must never publish the input or their own message.
    }
    throw redactionUnavailable();
  };
  const done = async (
    text: string,
    started: number,
    bytes: number,
    truncated: boolean,
    exitCode?: number | null,
  ): Promise<ToolResult> => {
    const capped = cap(await clean(text), maxBytes);
    const safe = capped.truncated
      ? `${capped.text}\n[output truncated]`
      : capped.text;
    return {
      text: safe,
      summary: {
        ...(exitCode === undefined ? {} : { exitCode }),
        durationMs: Date.now() - started,
        bytes,
        truncated: truncated || capped.truncated,
        preview: safe.slice(0, PREVIEW),
      },
    };
  };
  const lines = (
    text: string,
    started: number,
    more: string,
    rawBytes?: number,
  ) => {
    return done(
      more ? (text ? `${text}\n${more}` : more) : text,
      started,
      rawBytes ?? encoder.encode(text).length,
      false,
    );
  };

  async function exec(
    kind: "bash" | "powershell",
    command: string,
    ms: number,
    signal?: AbortSignal,
  ) {
    const cwd = root();
    const systemRoot = process.env.SystemRoot;
    if (win && (!systemRoot || !isAbsolute(systemRoot)))
      fail(
        "SHELL_START_FAILED",
        "The Windows system shell location is unavailable.",
      );
    const system32 = join(systemRoot ?? "", "System32");
    const powershellDir = join(system32, "WindowsPowerShell", "v1.0");
    let file = win ? join(powershellDir, "powershell.exe") : "pwsh";
    let args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ];
    if (kind === "bash") {
      file = "bash";
      args = ["--noprofile", "--norc", "-c", command];
      if (win) {
        // Resolve Git Bash without PATH; the engine receives only SystemRoot.
        file = "";
        for (const programs of ["Program Files", "Program Files (x86)"]) {
          const candidate = join(
            systemRoot!,
            "..",
            programs,
            "Git",
            "bin",
            "bash.exe",
          );
          try {
            if ((await lstat(candidate)).isFile()) {
              file = candidate;
              break;
            }
          } catch (e) {
            if ((e as { code?: string }).code !== "ENOENT")
              fail(
                "SHELL_START_FAILED",
                "Cannot access the Git Bash installation.",
              );
          }
        }
        if (!file)
          fail(
            "SHELL_START_FAILED",
            "Git Bash is unavailable. Use powershell.",
          );
      }
    }
    if (signal?.aborted) fail("ABORTED", "aborted");
    const temp = win ? await mkdtemp(join(cwd, ".splyce-shell-")) : undefined;
    try {
      const env = win
        ? {
            SystemRoot: systemRoot!,
            ComSpec: join(system32, "cmd.exe"),
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
            PATH: [system32, systemRoot!, powershellDir].join(";"),
            TEMP: temp!,
            TMP: temp!,
          }
        : scrubbedEnv();
      if (signal?.aborted) fail("ABORTED", "aborted");
      const child = spawn(file, args, {
        cwd,
        env,
        windowsHide: true,
        detached: !win,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const closed = new Promise<void>((complete) =>
        child.on("close", () => complete()),
      );
      const killTree = () => {
        if (child.pid === undefined) return;
        if (win)
          spawn(
            join(system32, "taskkill.exe"),
            ["/pid", String(child.pid), "/T", "/F"],
            {
              env,
              windowsHide: true,
              stdio: ["ignore", "ignore", "ignore"],
            },
          ).on("error", () => child.kill("SIGKILL"));
        else
          try {
            (
              process as unknown as { kill(pid: number, sig: string): void }
            ).kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
      };
      const started = Date.now();
      const output = { stdout: "", stderr: "" };
      let bytes = 0;
      let overflow = false;
      const stdoutDecoder = new TextDecoder();
      const stderrDecoder = new TextDecoder();
      const onData = (
        c: Uint8Array,
        stream: "stdout" | "stderr",
        decoder: TextDecoder,
      ) => {
        bytes += c.length;
        if (overflow) return;
        // shortcut: suppress output over the file-read budget; larger output needs bounded streaming redaction.
        if (bytes > MAX_READ_BYTES) {
          overflow = true;
          output.stdout = output.stderr = "";
          killTree();
        } else output[stream] += decoder.decode(c, { stream: true });
      };
      child.stdout?.on("data", (c) => onData(c, "stdout", stdoutDecoder));
      child.stderr?.on("data", (c) => onData(c, "stderr", stderrDecoder));
      return await new Promise<{
        code: number;
        text: string;
        bytes: number;
        truncated: boolean;
      }>((complete, reject) => {
        let settled = false;
        const settle = (f: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          f();
        };
        const timer = setTimeout(() => {
          killTree();
          settle(() => {
            if (overflow) return reject(redactionUnavailable());
            // A killed command may have emitted only part of a credential.
            void closed
              .then(() => done("[unavailable]", started, bytes, false, null))
              .then((r) => {
                const message = `command exceeded ${String(ms)}ms and was killed`;
                const code: ErrorCode = "SHELL_TIMEOUT";
                reject(new WorkspaceToolError(code, message, r.summary));
              }, reject);
          });
        }, ms);
        const onAbort = () => {
          killTree();
          settle(() => {
            void closed.then(
              () =>
                reject(new WorkspaceToolError("ABORTED", "command aborted")),
              reject,
            );
          });
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        child.on("error", (e) =>
          settle(() =>
            reject(
              new WorkspaceToolError(
                "SHELL_START_FAILED",
                `Cannot start ${kind}: ${(e as { code?: string }).code ?? "error"}. Check the system shell installation.`,
              ),
            ),
          ),
        );
        child.on("close", (exitCode) => {
          settle(() => {
            if (overflow) return reject(redactionUnavailable());
            void Promise.all([
              clean(output.stdout + stdoutDecoder.decode()),
              clean(output.stderr + stderrDecoder.decode()),
            ]).then(([stdout, stderr]) => {
              complete({
                code: exitCode ?? 1,
                text: stdout + stderr,
                bytes,
                truncated: false,
              });
            }, reject);
          });
        });
        if (signal?.aborted) onAbort();
      });
    } finally {
      // A surviving descendant can hold a file in the owned temp dir; a failed
      // cleanup must not replace the command's own typed result with EBUSY.
      if (temp)
        await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  type Impl = Omit<WorkspaceTool, "execute">;
  const shell = (kind: "bash" | "powershell", label: string): Impl => ({
    name: kind,
    description: `Run a ${label} command in the workspace root.${win ? " PowerShell is the default Windows shell; request bash only for Git Bash commands." : ""} Needs a one-time approval for this exact command; output is capped and the command is killed on timeout.`,
    parameters: obj(
      {
        command: S("Command to execute"),
        timeout: N("Timeout in seconds (capped by policy)"),
      },
      ["command"],
    ),
    async result(args, signal, actionId) {
      const started = Date.now();
      if (signal?.aborted) fail("ABORTED", "aborted");
      const a = act(args, actionId);
      const command = str(args.command, "command");
      root();
      const ms = Math.min(timeoutMs, optNum(args.timeout, Infinity) * 1000);
      const target = `${kind}:${command}`;
      const grantId = gate("shell.run", target, a);
      const execute = async () => {
        const r = await exec(kind, command, ms, signal);
        return { summary: `exit ${String(r.code)}`, ok: r.code === 0, r };
      };
      const { r } = await effect(
        "shell.run",
        target,
        grantId,
        a,
        execute,
        signal,
      );
      return done(
        r.code === 0 ? r.text : `${r.text}\n[exit code ${String(r.code)}]`,
        started,
        r.bytes,
        r.truncated,
        r.code,
      );
    },
  });

  const tools: Impl[] = [
    {
      name: "read",
      description:
        "Read a text file inside the workspace. Use offset/limit (1-indexed lines) for large files.",
      parameters: obj(
        {
          path: S("File path, relative to the workspace root"),
          offset: N("First line, 1-indexed"),
          limit: N("Maximum lines"),
        },
        ["path"],
      ),
      async result(args, _signal, actionId) {
        const started = Date.now();
        const a = act(args, actionId);
        const { abs, rel } = await confine(str(args.path, "path"));
        gate("fs.read", rel, a);
        const text = await io(rel, async () => {
          // One handle for stat and read: a path swap cannot change what is measured.
          const handle = await open(abs, "r");
          try {
            if ((await handle.stat()).size > MAX_READ_BYTES)
              fail("IO_ERROR", `too large: ${rel}`);
            return await handle.readFile({ encoding: "utf8" });
          } finally {
            await handle.close();
          }
        });
        const original = text.split("\n");
        const originalLines = original.length;
        const all = (await clean(text)).split("\n");
        const start = optNum(args.offset, 1) - 1;
        const end = start + optNum(args.limit, 2000);
        if (all.length !== originalLines && (start > 0 || end < originalLines))
          throw redactionUnavailable();
        return lines(
          all.slice(start, end).join("\n"),
          started,
          end < all.length
            ? `[${String(all.length - end)} more lines; continue with offset ${String(end + 1)}]`
            : "",
          encoder.encode(original.slice(start, end).join("\n")).length,
        );
      },
    },
    {
      name: "ls",
      description:
        "List a directory inside the workspace (directories end with /).",
      parameters: obj(
        {
          path: S("Directory, default workspace root"),
          limit: N("Maximum entries"),
        },
        [],
      ),
      async result(args, _signal, actionId) {
        const started = Date.now();
        const a = act(args, actionId);
        const { abs, rel } = await confine(optStr(args.path, "path") ?? ".");
        gate("fs.read", rel, a);
        const names = (
          await io(rel, () => readdir(abs, { withFileTypes: true }))
        )
          .filter((d) => !isSecretPath(d.name))
          .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
          .sort();
        return lines(
          names.slice(0, optNum(args.limit, 500)).join("\n"),
          started,
          "",
        );
      },
    },
    {
      name: "find",
      description:
        "Find files by glob (e.g. '**/*.ts') inside the workspace. Symbolic links are not followed.",
      parameters: obj(
        {
          pattern: S("Glob pattern"),
          path: S("Directory, default workspace root"),
          limit: N("Maximum results"),
        },
        ["pattern"],
      ),
      async result(args, signal, actionId) {
        const started = Date.now();
        const a = act(args, actionId);
        const glob = str(args.pattern, "pattern");
        const re = globToRegExp(glob);
        const { abs, rel } = await confine(optStr(args.path, "path") ?? ".");
        gate("fs.read", rel, a);
        const limit = optNum(args.limit, 1000);
        const hits: string[] = [];
        const t0 = Date.now();
        await io(rel, async () => {
          for await (const e of walk(abs, rel === "" ? "" : rel)) {
            if (signal?.aborted) fail("ABORTED", "aborted");
            if (Date.now() - t0 > timeoutMs)
              fail("GREP_BUDGET", "search exceeded its time budget");
            if (re.test(glob.includes("/") ? e.rel : basename(e.rel)))
              hits.push(e.rel);
            if (hits.length >= limit) break;
          }
        });
        return lines(hits.join("\n"), started, "");
      },
    },
    {
      name: "grep",
      description:
        "Search file contents inside the workspace; prints path:line:text. Symbolic links are not followed.",
      parameters: obj(
        {
          pattern: S("Regex or literal text"),
          path: S("Directory or file, default workspace root"),
          glob: S("Filter files, e.g. '*.ts'"),
          ignoreCase: { type: "boolean" },
          literal: { type: "boolean" },
          limit: N("Maximum matches"),
        },
        ["pattern"],
      ),
      async result(args, signal, actionId) {
        const started = Date.now();
        const a = act(args, actionId);
        const pat = str(args.pattern, "pattern");
        if (
          pat.length > MAX_PATTERN ||
          (args.literal !== true &&
            NESTED_QUANTIFIER.test(pat.replace(/\\./g, "x")))
        )
          fail(
            "PATTERN_REJECTED",
            "pattern too long or has nested unbounded quantifiers",
          );
        let re: RegExp;
        try {
          re = new RegExp(
            args.literal === true
              ? pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
              : pat,
            args.ignoreCase === true ? "i" : "",
          );
        } catch {
          return fail("BAD_ARGS", "invalid pattern");
        }
        const g = optStr(args.glob, "glob");
        const gre = g ? globToRegExp(g) : undefined;
        const { abs, rel } = await confine(optStr(args.path, "path") ?? ".");
        gate("fs.read", rel, a);
        const limit = optNum(args.limit, 100);
        const hits: string[] = [];
        let skipped = 0;
        let rawBytes = 0;
        if (signal?.aborted) fail("ABORTED", "aborted");
        // Matching runs in a worker so a catastrophic regex can be killed.
        const m = matcher(re, signal);
        try {
          await io(rel, async () => {
            const st = await lstat(abs);
            const files = st.isFile()
              ? [{ abs, rel, file: true }]
              : walk(abs, rel);
            const t0 = Date.now();
            let scanned = 0;
            for await (const e of files) {
              if (signal?.aborted) fail("ABORTED", "aborted");
              if (
                !e.file ||
                (gre && !gre.test(g?.includes("/") ? e.rel : basename(e.rel)))
              )
                continue;
              const size = (await lstat(e.abs)).size;
              if (size > MAX_WALK_FILE_BYTES) {
                skipped++;
                continue;
              }
              scanned += size;
              if (scanned > MAX_GREP_SCAN_BYTES)
                fail("GREP_BUDGET", "search exceeded its scan budget");
              const left = timeoutMs - (Date.now() - t0);
              if (left <= 0)
                fail("GREP_BUDGET", "search exceeded its time budget");
              const text = await readFile(e.abs, "utf8");
              const original = text.split("\n");
              const ls = (await clean(text)).split("\n");
              const sameLines = ls.length === original.length;
              // shortcut: one file may use 400ms of regex time, raise it if real searches hit it.
              const matches = await m.test(
                text,
                limit - hits.length,
                Math.min(GREP_FILE_MS, left),
              );
              if (Date.now() - t0 >= timeoutMs)
                fail("GREP_BUDGET", "search exceeded its time budget");
              for (const i of matches) {
                rawBytes +=
                  encoder.encode(`${e.rel}:${String(i + 1)}:${original[i]}`)
                    .length + (hits.length ? 1 : 0);
                hits.push(
                  `${e.rel}:${String(i + 1)}:${sameLines ? ls[i] : "[unavailable]"}`,
                );
              }
              if (hits.length >= limit) break;
            }
          });
        } finally {
          m.close();
        }
        const r = await lines(
          hits.join("\n"),
          started,
          skipped ? `[skipped ${String(skipped)} file(s) over 1 MiB]` : "",
          rawBytes,
        );
        return skipped ? { ...r, skipped } : r;
      },
    },
    {
      name: "write",
      description:
        "Create or overwrite a file inside the workspace. Needs a one-time approval for this exact path.",
      parameters: obj(
        {
          path: S("File path, relative to the workspace root"),
          content: S("Full file content"),
        },
        ["path", "content"],
      ),
      async result(args, signal, actionId) {
        const started = Date.now();
        const a = act(args, actionId);
        const content = str(args.content, "content");
        const path = str(args.path, "path");
        const { abs, rel } = await confine(path);
        const grantId = gate("fs.write", rel, a);
        const o = await effect("fs.write", rel, grantId, a, () =>
          io(rel, async () => {
            await put(path, abs, content, signal);
            const n = encoder.encode(content).length;
            return {
              summary: `wrote ${String(n)} bytes`,
              ok: true,
              text: `Wrote ${String(n)} bytes to ${rel}`,
              bytes: n,
            };
          }),
        );
        return done(o.text, started, o.bytes, false);
      },
    },
    {
      name: "edit",
      description:
        "Replace exact, unique text in a file inside the workspace. Needs a one-time approval for this exact path.",
      parameters: obj(
        {
          path: S("File path, relative to the workspace root"),
          edits: {
            type: "array",
            items: obj(
              {
                oldText: S("Exact text to replace; must match once"),
                newText: S("Replacement"),
              },
              ["oldText", "newText"],
            ),
          },
        },
        ["path", "edits"],
      ),
      async result(args, signal, actionId) {
        const started = Date.now();
        const a = act(args, actionId);
        const list = Array.isArray(args.edits)
          ? (args.edits as Record<string, unknown>[])
          : fail("BAD_ARGS", "edits must be an array");
        if (list.length === 0) fail("BAD_ARGS", "edits must not be empty");
        const path = str(args.path, "path");
        const { abs, rel } = await confine(path);
        const grantId = gate("fs.write", rel, a);
        const raw = await io(rel, () => readFile(abs, "utf8"));
        // Match on LF text; a file that is entirely CRLF (and its BOM) is restored on write.
        const bom = raw.startsWith("﻿") ? "﻿" : "";
        const body = raw.slice(bom.length);
        const crlf = body.includes("\r\n") && !/(?<!\r)\n/.test(body);
        const lf = (s: string) => (crlf ? s.replace(/\r\n/g, "\n") : s);
        const original = lf(body);
        // Every edit is matched against the original text, so edits cannot see each other's output.
        const found = list
          .map((e) => {
            const o = lf(str(e.oldText, "oldText"));
            const n = lf(str(e.newText, "newText"));
            if (o === "") fail("BAD_ARGS", "oldText must not be empty");
            const at = original.indexOf(o);
            if (at < 0) fail("EDIT_NOT_FOUND", `oldText not found in ${rel}`);
            if (original.indexOf(o, at + 1) >= 0)
              fail(
                "EDIT_AMBIGUOUS",
                `oldText matches more than once in ${rel}`,
              );
            return { at, end: at + o.length, n };
          })
          .sort((x, y) => x.at - y.at);
        let text = "";
        let pos = 0;
        for (const f of found) {
          if (f.at < pos) fail("BAD_ARGS", "edits overlap");
          text += original.slice(pos, f.at) + f.n;
          pos = f.end;
        }
        text += original.slice(pos);
        if (crlf) text = text.replace(/\n/g, "\r\n");
        text = bom + text;
        const o = await effect("fs.write", rel, grantId, a, () =>
          io(rel, async () => {
            await put(path, abs, text, signal);
            return {
              summary: `edited ${String(list.length)} block(s)`,
              ok: true,
              text: `Edited ${rel}`,
              bytes: encoder.encode(text).length,
            };
          }),
        );
        return done(o.text, started, o.bytes, false);
      },
    },
    shell(win ? "powershell" : "bash", win ? "PowerShell" : "bash"),
    shell(win ? "bash" : "powershell", win ? "Git Bash" : "PowerShell"),
  ];
  return Object.fromEntries(
    tools.map((t) => {
      const result: WorkspaceTool["result"] = async (...a) => {
        try {
          return await t.result(...a);
        } catch (e) {
          if (e instanceof WorkspaceToolError) {
            if (e.code === "REDACTION_UNAVAILABLE") throw e;
            throw new WorkspaceToolError(
              e.code,
              await clean(e.message),
              e.summary,
            );
          }
          throw e;
        }
      };
      return [
        t.name,
        {
          ...t,
          result,
          execute: async (...a) => (await result(...a)).text,
          ...(!["bash", "powershell"].includes(t.name)
            ? {
                validatePath: async (args: Record<string, unknown>) => {
                  await confine(optStr(args.path, "path") ?? ".");
                },
              }
            : {}),
        },
      ];
    }),
  );
}
