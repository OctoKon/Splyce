/**
 * TD-12: session navigation state.
 *
 * Pure reducer over `session.tree_updated` events; the Svelte view only renders it. A node's identity is the
 * engine's `sessionId` + `branchAnchorId`, never a label. Loading, empty and error are distinct states, and a
 * refresh keeps the previous nodes, selection and focus until the new snapshot replaces them.
 */

export type LoadState = "loading" | "empty" | "ready" | "error";

export interface TreeEventLike {
  kind: string;
  sessionId: string;
  seq: number;
  payload?: {
    sessionId?: string;
    branchAnchorId?: string;
    leaves?: readonly string[];
  };
}

interface Branch {
  sessionId: string;
  branchAnchorId: string;
  leaves: readonly string[];
  seenSeq: number;
}

export interface SessionNavState {
  load: LoadState;
  error: string | null;
  /** Insertion-ordered by first appearance. */
  branches: Record<string, Branch>;
  /** Branches seen since `refresh`; replaces `branches` at `loaded`. */
  fresh: Record<string, Branch> | null;
  selectedKey: string | null;
  focusKey: string | null;
  /** Key of a selected branch the latest snapshot no longer contains. */
  lostSelection: string | null;
}

export type SessionNavAction =
  | { type: "event"; event: TreeEventLike }
  | { type: "loaded" }
  | { type: "failed"; message: string }
  | { type: "refresh" }
  | { type: "select"; key: string }
  | { type: "focus"; key: string }
  | { type: "move"; to: "next" | "prev" | "first" | "last" };

export interface NavNode {
  key: string;
  sessionId: string;
  branchAnchorId: string;
  leaves: readonly string[];
  selected: boolean;
  focused: boolean;
  /** Text indicator so state is never color-only. */
  stateLabel: string;
}

export function createSessionNav(): SessionNavState {
  return {
    load: "loading",
    error: null,
    branches: {},
    fresh: null,
    selectedKey: null,
    focusKey: null,
    lostSelection: null,
  };
}

const keyOf = (sessionId: string, branchAnchorId: string) =>
  `${sessionId}/${branchAnchorId}`;

function mergeEvent(
  into: Record<string, Branch>,
  event: TreeEventLike,
  /**
   * Set while a refresh collects a new snapshot: the branches known before it. A snapshot event older than what is
   * known is not applied (the newer known state is carried into the snapshot instead), while an event with the same
   * sequence number is an ordinary re-delivery and is applied.
   */
  known?: Record<string, Branch>,
): Record<string, Branch> | null {
  const payload = event.payload;
  if (event.kind !== "session.tree_updated" || !payload) return null;
  const { sessionId, branchAnchorId, leaves } = payload;
  if (!sessionId || !branchAnchorId || !Array.isArray(leaves)) return null;
  // The envelope names the session the engine sent this for; a payload naming another one is a mismatch, not a branch.
  if (event.sessionId !== sessionId) return null;
  const key = keyOf(sessionId, branchAnchorId);
  const own = into[key];
  if (own && event.seq <= own.seenSeq) return null;
  const prior = known?.[key];
  if (prior && event.seq < prior.seenSeq) return { ...into, [key]: prior };
  return {
    ...into,
    [key]: {
      sessionId,
      branchAnchorId,
      leaves: [...leaves],
      seenSeq: event.seq,
    },
  };
}

function settle(state: SessionNavState): SessionNavState {
  const keys = Object.keys(state.branches);
  const focusKey =
    state.focusKey !== null && keys.includes(state.focusKey)
      ? state.focusKey
      : (keys[0] ?? null);
  return { ...state, focusKey };
}

export function reduceSessionNav(
  state: SessionNavState,
  action: SessionNavAction,
): SessionNavState {
  switch (action.type) {
    case "event": {
      if (state.fresh !== null) {
        const merged = mergeEvent(state.fresh, action.event, state.branches);
        return merged ? { ...state, fresh: merged } : state;
      }
      const merged = mergeEvent(state.branches, action.event);
      if (!merged) return state;
      const next = settle({ ...state, branches: merged });
      return next.load === "empty" ? { ...next, load: "ready" } : next;
    }
    case "loaded": {
      const branches = state.fresh ?? state.branches;
      const lost =
        state.selectedKey !== null && !(state.selectedKey in branches)
          ? state.selectedKey
          : null;
      const next = settle({
        ...state,
        branches,
        fresh: null,
        error: null,
        selectedKey: lost ? null : state.selectedKey,
        lostSelection: lost ?? state.lostSelection,
        load: Object.keys(branches).length === 0 ? "empty" : "ready",
      });
      return next;
    }
    case "failed":
      return { ...state, fresh: null, load: "error", error: action.message };
    case "refresh":
      return { ...state, load: "loading", error: null, fresh: {} };
    case "select":
      if (!(action.key in state.branches)) return state;
      return {
        ...state,
        selectedKey: action.key,
        focusKey: action.key,
        lostSelection: null,
      };
    case "focus":
      return action.key in state.branches
        ? { ...state, focusKey: action.key }
        : state;
    case "move": {
      const keys = Object.keys(state.branches);
      if (keys.length === 0) return state;
      const at = state.focusKey === null ? -1 : keys.indexOf(state.focusKey);
      const index =
        action.to === "first"
          ? 0
          : action.to === "last"
            ? keys.length - 1
            : action.to === "next"
              ? Math.min(at + 1, keys.length - 1)
              : Math.max(at - 1, 0);
      return { ...state, focusKey: keys[index] ?? state.focusKey };
    }
  }
}

export function visibleNodes(state: SessionNavState): NavNode[] {
  return Object.entries(state.branches).map(([key, branch]) => {
    const selected = key === state.selectedKey;
    return {
      key,
      sessionId: branch.sessionId,
      branchAnchorId: branch.branchAnchorId,
      leaves: branch.leaves,
      selected,
      focused: key === state.focusKey,
      stateLabel: selected ? "Selected" : "Not selected",
    };
  });
}
