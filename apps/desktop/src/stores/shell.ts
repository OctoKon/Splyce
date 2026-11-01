export type LayoutMode = "narrow" | "medium" | "wide";
export type Panel = "rail" | "evidence";

/** Min window widths (CSS px) for medium and wide layouts. */
export const BREAKPOINTS = { medium: 768, wide: 1200 } as const;

export const layoutMode = (width: number): LayoutMode =>
  width >= BREAKPOINTS.wide
    ? "wide"
    : width >= BREAKPOINTS.medium
      ? "medium"
      : "narrow";

export interface ShellState {
  readonly rail: boolean;
  readonly evidence: boolean;
}

export const initialShell = (mode: LayoutMode): ShellState => ({
  rail: mode !== "narrow",
  evidence: false,
});

/** Narrow: one content pane at a time. Medium: at most one side panel. Wide: any. */
export function normalizeShell(s: ShellState, mode: LayoutMode): ShellState {
  if (mode === "narrow") return { rail: false, evidence: false };
  if (mode === "medium" && s.rail && s.evidence)
    return { rail: true, evidence: false };
  return s;
}

export function togglePanel(
  s: ShellState,
  panel: Panel,
  mode: LayoutMode,
): ShellState {
  const open = !s[panel];
  const other: Panel = panel === "rail" ? "evidence" : "rail";
  return {
    ...s,
    [panel]: open,
    [other]: open && mode !== "wide" ? false : s[other],
  };
}

export interface VisiblePanes {
  rail: boolean;
  conversation: boolean;
  evidence: boolean;
}

export const visiblePanes = (
  s: ShellState,
  mode: LayoutMode,
): VisiblePanes => ({
  rail: s.rail,
  evidence: s.evidence,
  conversation: !(mode === "narrow" && (s.rail || s.evidence)),
});

export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/** Ctrl+B toggles the rail, Ctrl+Shift+E the evidence pane. Never during IME composition. */
export function shortcutPanel(e: ShortcutKey): Panel | null {
  if (!e.ctrlKey || e.altKey || e.isComposing) return null;
  const k = e.key.toLowerCase();
  if (k === "b" && !e.shiftKey) return "rail";
  if (k === "e" && e.shiftKey) return "evidence";
  return null;
}
