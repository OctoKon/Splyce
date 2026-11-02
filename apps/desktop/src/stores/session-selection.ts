import { writable, type Readable } from "svelte/store";
import type { TurnStreamTransport } from "./turns";

export interface SessionSelection {
  sessionId: string;
  scopeId: string;
}

/** The workbench (TD-12/TD-30) is the only writer; sessions are never derived from events. */
export const selectedSession = writable<SessionSelection | null>(null);
export const selectSession = (selection: SessionSelection): void =>
  selectedSession.set(selection);
export const clearSession = (): void => selectedSession.set(null);

export type Subscribe = (
  sessionId: string,
  afterSeq?: number,
) => Promise<() => void>;

export type BindingStatus =
  | { state: "idle" }
  | { state: "subscribing" }
  | { state: "live" }
  | { state: "failed"; error: string };

export interface SelectionBinding {
  status: Readable<BindingStatus>;
  retry(): Promise<void>;
  resubscribe(sessionId: string, afterSeq: number): Promise<void>;
  dispose(): void;
}

/**
 * Follows and subscribes to the selected session only, releasing the previous
 * one first. The transport accepts events for nothing else.
 */
export function bindSelection(
  transport: Pick<TurnStreamTransport, "follow" | "unfollow" | "current">,
  subscribe: Subscribe,
): SelectionBinding {
  let current: SessionSelection | null = null;
  let release: (() => void) | null = null;
  let generation = 0;
  const status = writable<BindingStatus>({ state: "idle" });

  async function connect(afterSeq: number): Promise<void> {
    const selection = current;
    if (!selection) return;
    const mine = ++generation;
    status.set({ state: "subscribing" });
    try {
      const dispose = await subscribe(selection.sessionId, afterSeq);
      if (mine !== generation) return dispose();
      release = dispose;
      status.set({ state: "live" });
    } catch (error) {
      if (mine !== generation) return;
      status.set({
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function drop(): void {
    generation += 1;
    status.set({ state: "idle" });
    release?.();
    release = null;
    if (current) transport.unfollow(current.sessionId);
    current = null;
  }

  const unsubscribe = selectedSession.subscribe((selection) => {
    // Re-selecting the current session keeps its channel and subscription.
    // Switching A -> B -> A resumes A after its retained transcript cursor.
    if (
      selection &&
      selection.sessionId === current?.sessionId &&
      selection.scopeId === current.scopeId
    ) {
      return;
    }
    drop();
    if (!selection) return;
    current = selection;
    transport.follow(selection.sessionId, selection.scopeId);
    void connect(transport.current(selection.sessionId).lastDurableSeq);
  });

  return {
    status: { subscribe: status.subscribe },
    async retry() {
      if (!current) return;
      release?.();
      release = null;
      await connect(transport.current(current.sessionId).lastDurableSeq);
    },
    async resubscribe(sessionId, afterSeq) {
      if (current?.sessionId !== sessionId) return;
      generation += 1;
      release?.();
      release = null;
      await connect(afterSeq);
    },
    dispose() {
      unsubscribe();
      drop();
    },
  };
}
