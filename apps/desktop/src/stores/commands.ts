// Single command registry (TD-73). The palette, shortcut routing and the shortcut
// reference (TD-77) all read CATALOG; nothing else lists commands or bindings.
// Handlers are injected by the owner of each action; this module never dispatches
// anything that was not handed to it.

export type CommandScope =
  "global" | "shell" | "composer" | "turn" | "review" | "approval";

export interface CommandDef {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly scope: CommandScope;
  /** Alternative bindings, e.g. ["N", "Escape"]. */
  readonly shortcuts: readonly string[];
  /** Offered in the palette (a palette entry runs the injected handler). */
  readonly palette: boolean;
  /** This module routes the key (the owning component handles scoped keys itself). */
  readonly routed: boolean;
}

function def(
  id: string,
  label: string,
  category: string,
  scope: CommandScope,
  shortcuts: readonly string[],
  palette = false,
  routed = false,
): CommandDef {
  return Object.freeze({
    id,
    label,
    category,
    scope,
    shortcuts,
    palette,
    routed,
  });
}

// Source: client-contract.md section 7 plus the shell panel toggles owned by TD-72.
export const CATALOG: readonly CommandDef[] = Object.freeze([
  def(
    "landmark.rail",
    "Focus project and workspace rail",
    "Landmarks",
    "global",
    ["Ctrl+1"],
    true,
    true,
  ),
  def(
    "landmark.transcript",
    "Focus session transcript",
    "Landmarks",
    "global",
    ["Ctrl+2"],
    true,
    true,
  ),
  def(
    "landmark.review",
    "Focus changes and review pane",
    "Landmarks",
    "global",
    ["Ctrl+3"],
    true,
    true,
  ),
  def(
    "landmark.settings",
    "Focus settings and profile selector",
    "Landmarks",
    "global",
    ["Ctrl+4"],
    true,
    true,
  ),
  def(
    "palette.open",
    "Open command palette",
    "Execution",
    "global",
    ["Ctrl+K"],
    false,
    true,
  ),
  def(
    "shell.toggle-sidebar",
    "Toggle projects and tasks rail",
    "Layout",
    "shell",
    ["Ctrl+B"],
    true,
  ),
  def(
    "shell.toggle-side-panel",
    "Toggle changes and evidence pane",
    "Layout",
    "shell",
    ["Ctrl+Shift+E"],
    true,
  ),
  def(
    "composer.submit",
    "Submit current prompt (outside active IME)",
    "Composer",
    "composer",
    ["Ctrl+Enter"],
  ),
  def("composer.newline", "Insert newline in prompt", "Composer", "composer", [
    "Enter",
  ]),
  def(
    "composer.cancel-draft",
    "Cancel draft and unfocus composer",
    "Composer",
    "composer",
    ["Escape"],
  ),
  def("turn.interrupt", "Interrupt active generation", "Execution", "turn", [
    "Ctrl+C",
  ]),
  def("review.next-hunk", "Next diff hunk", "Review", "review", ["J"]),
  def("review.prev-hunk", "Previous diff hunk", "Review", "review", ["K"]),
  def("review.accept-hunk", "Accept selected hunk", "Review", "review", ["A"]),
  def("review.discard-hunk", "Discard selected hunk", "Review", "review", [
    "D",
  ]),
  def("review.toggle-pane", "Toggle review pane collapse", "Review", "review", [
    "Space",
  ]),
  def(
    "approval.approve",
    "Approve action (modal focused)",
    "Approvals",
    "approval",
    ["Y"],
  ),
  def(
    "approval.deny",
    "Deny action or dismiss modal",
    "Approvals",
    "approval",
    ["N", "Escape"],
  ),
]);

const MODIFIERS = ["Ctrl", "Alt", "Shift"];

export function normalizeShortcut(raw: string): string {
  const parts = raw
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) => MODIFIERS.find((m) => m.toLowerCase() === p.toLowerCase()) ?? p,
    );
  const key = parts.filter((p) => !MODIFIERS.includes(p)).pop() ?? "";
  const mods = MODIFIERS.filter((m) => parts.includes(m));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
}

export function eventShortcut(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
): string {
  if (e.metaKey) return "";
  const key = e.key === " " ? "Space" : e.key;
  return normalizeShortcut(
    [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", key]
      .filter(Boolean)
      .join("+"),
  );
}

export interface Conflict {
  readonly shortcut: string;
  readonly ids: readonly string[];
}

/** Bindings collide when equal and their scopes can be active together (same scope, or either is global/shell). */
export function findConflicts(
  defs: readonly CommandDef[] = CATALOG,
): Conflict[] {
  const wide = (s: CommandScope) => s === "global" || s === "shell";
  const out: Conflict[] = [];
  const seen = new Map<string, CommandDef[]>();
  for (const d of defs) {
    for (const s of d.shortcuts) {
      const key = normalizeShortcut(s);
      const prior = seen.get(key) ?? [];
      const clash = prior.filter(
        (p) => p.scope === d.scope || wide(p.scope) || wide(d.scope),
      );
      if (clash.length) {
        out.push({ shortcut: key, ids: [...clash.map((c) => c.id), d.id] });
      }
      seen.set(key, [...prior, d]);
    }
  }
  return out;
}

export interface CommandHandler {
  run(): void | Promise<void>;
  /** A reason string means the command cannot run right now. Re-evaluated on every run. */
  unavailable?(): string | undefined;
}

export interface ResolvedCommand extends CommandDef {
  readonly enabled: boolean;
  readonly reason?: string;
}

export type RunResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface CommandRegistry {
  list(): ResolvedCommand[];
  run(id: string): Promise<RunResult>;
  /** Routes a global shortcut; returns true when the key was consumed. */
  handleKey(e: KeyboardEvent): boolean;
}

export function createCommandRegistry(
  handlers: Readonly<Record<string, CommandHandler>>,
  defs: readonly CommandDef[] = CATALOG,
  /** Called with failed results of key-routed runs, which have no caller to return to. */
  onFailure: (id: string, reason: string) => void = () => {},
): CommandRegistry {
  const running = new Set<string>();
  function resolve(d: CommandDef): ResolvedCommand {
    const h = handlers[d.id];
    if (!h) return { ...d, enabled: false, reason: "Not available yet" };
    const reason = h.unavailable?.();
    return reason ? { ...d, enabled: false, reason } : { ...d, enabled: true };
  }
  async function run(id: string): Promise<RunResult> {
    const d = defs.find((c) => c.id === id);
    if (!d) return { ok: false, reason: "Unknown command" };
    const r = resolve(d); // availability is re-checked now, never trusted from an earlier render
    if (!r.enabled) return { ok: false, reason: r.reason ?? "Unavailable" };
    if (running.has(id)) return { ok: false, reason: "Already running" };
    running.add(id);
    try {
      await handlers[id]!.run();
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : "Command failed",
      };
    } finally {
      running.delete(id);
    }
  }
  return {
    list: () => defs.map(resolve),
    run,
    handleKey(e) {
      if (e.isComposing || e.defaultPrevented) return false; // IME safeguard
      const s = eventShortcut(e);
      const d = defs.find(
        (c) => c.routed && c.shortcuts.some((x) => normalizeShortcut(x) === s),
      );
      if (!d) return false;
      e.preventDefault();
      void run(d.id).then((r) => {
        if (!r.ok) onFailure(d.id, r.reason);
      });
      return true;
    },
  };
}

function fuzzyScore(text: string, q: string): number | null {
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const at = text.indexOf(ch, from);
    if (at < 0) return null;
    if (at === 0) score += 6;
    else if (text[at - 1] === " ") score += 4;
    if (at === prev + 1) score += 3;
    score += 1;
    prev = at;
    from = at + 1;
  }
  if (text.startsWith(q)) score += 20;
  else if (text.includes(q)) score += 10;
  return score - text.length * 0.01;
}

/** Fuzzy subsequence ranking: prefix, substring and word-start matches win. Empty query keeps order. */
export function filterCommands<T extends { label: string; category: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const score =
      fuzzyScore(item.label.toLowerCase(), q) ??
      fuzzyScore(`${item.category} ${item.label}`.toLowerCase(), q);
    if (score !== null) scored.push({ item, score, i });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((s) => s.item);
}
