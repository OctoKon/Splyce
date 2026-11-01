import type { StatusTone } from "./status-view";
import type { ToolCallView } from "./stores/turns";

export interface ToolStateView {
  label: string;
  tone: StatusTone;
  status:
    | "running"
    | "waiting-approval"
    | "success"
    | "error"
    | "denied"
    | "uncertain"
    | "canceled";
}

export interface ToolErrorView {
  copy: string | null;
  code: string | null;
}

const RENAMED: readonly [RegExp, string][] = [
  [/(^|[._])fs[._]?read/i, "Read"],
  [/(^|[._])files[._]read/i, "Read"],
  [/(^|[._])fs[._]?write/i, "Write"],
  [/(^|[._])files[._]write/i, "Write"],
  [/(^|[._])fs[._]?edit/i, "Edit"],
  [/(^|[._])files[._]edit/i, "Edit"],
];

/** A compact, fixed action verb. Unknown capabilities stay honestly generic. */
export function toolActionLabel(capabilityId: string): string {
  const value = capabilityId.trim();
  for (const [pattern, label] of RENAMED) {
    if (pattern.test(value)) return label;
  }
  const lower = value.toLowerCase();
  if (
    lower === "bash" ||
    lower === "powershell" ||
    lower.includes("shell") ||
    lower.includes("run_command")
  )
    return "Run shell";
  if (lower.includes("read_tree") || lower.includes("read_file")) return "Read";
  if (lower.includes("write_file")) return "Write";
  if (lower.includes("edit_file")) return "Edit";
  return "Tool action";
}

const DENIAL_CODES = new Set([
  "GRANT_REQUIRED",
  "GRANT_CONSUMED",
  "GRANT_REVOKED",
  "WORKSPACE_ESCAPE",
]);

const ERROR_COPY: Readonly<Record<string, string>> = Object.freeze({
  GRANT_REQUIRED: "This action needs a one-time approval for its exact target.",
  GRANT_CONSUMED: "That approval was already used. Request the action again.",
  GRANT_REVOKED: "That approval is no longer valid.",
  WORKSPACE_ESCAPE: "Blocked: the target is outside the admitted workspace.",
  SHELL_TIMEOUT: "The command timed out and was stopped.",
  PATTERN_REJECTED: "The search pattern was rejected.",
  GREP_BUDGET: "The search stopped at its safety limit.",
  EDIT_NOT_FOUND: "The text to replace was not found.",
  EDIT_AMBIGUOUS: "The text to replace matches more than once.",
  ABORTED: "The action was canceled.",
  IO_ERROR: "The workspace operation failed.",
  BAD_ARGS: "The action arguments were rejected.",
});

const GENERIC_ERROR = "The action failed. Technical details are hidden.";
const NO_UNDERSCORE_CODES = new Set(["ABORTED"]);

function errorCode(error: string | undefined): string | null {
  if (!error) return null;
  const stable = /^\s*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(error);
  if (stable) return stable[1] ?? null;
  const bare = /^\s*([A-Z]{3,})\b/.exec(error);
  return bare && NO_UNDERSCORE_CODES.has(bare[1]!) ? bare[1]! : null;
}

/** Fixed copy for a stable engine code; the raw message is never rendered. */
export function toolErrorCopy(error: string | undefined): ToolErrorView {
  if (!error) return { copy: null, code: null };
  const code = errorCode(error);
  return {
    copy: code ? (ERROR_COPY[code] ?? GENERIC_ERROR) : GENERIC_ERROR,
    code,
  };
}

/** Projects only the facts the tool events reported. */
export function toolState(action: ToolCallView): ToolStateView {
  if (action.approval?.state === "denied")
    return { label: "Denied", tone: "negative", status: "denied" };
  if (action.approval?.state === "canceled")
    return { label: "Canceled", tone: "neutral", status: "canceled" };
  if (action.approval?.state === "requested" && action.status === "pending")
    return {
      label: "Waiting for approval",
      tone: "warning",
      status: "waiting-approval",
    };
  switch (action.status) {
    case "pending":
      return { label: "Running", tone: "active", status: "running" };
    case "success":
      return { label: "OK", tone: "positive", status: "success" };
    case "error": {
      const { code } = toolErrorCopy(action.error);
      return code && DENIAL_CODES.has(code)
        ? { label: "Denied", tone: "negative", status: "denied" }
        : { label: "Failed", tone: "negative", status: "error" };
    }
    case "uncertain":
      return { label: "Uncertain", tone: "warning", status: "uncertain" };
    case "canceled":
      return { label: "Canceled", tone: "neutral", status: "canceled" };
  }
}

const SECRET_TOKEN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

/**
 * Defence in depth for renderer text. The engine already supplies a sanitised
 * summary; this catches common credential shapes if it ever misses one.
 */
export function redactToolText(text: string): string {
  return text
    .replace(SECRET_TOKEN, "[redacted]")
    .replace(BEARER, "$1 [redacted]")
    .replace(ASSIGNMENT, "$1$2[redacted]");
}
