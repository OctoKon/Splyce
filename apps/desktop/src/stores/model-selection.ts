import type { SelectionTransitionRecord } from "@splyce/pi/contracts";

export type Disposition = SelectionTransitionRecord["disposition"];

/**
 * The state of the model catalog feed. `ready` means the options handed to the
 * switcher are the engine's current catalog; `loading` and `error` mean the
 * catalog has not been read, which is not the same as an engine with no models.
 */
export type ModelCatalogStatus = "ready" | "loading" | "error";

/** `requested` is local intent before the engine has recorded a transition. */
export type TransitionStatus =
  "requested" | "pending" | "applied" | "rejected" | "canceled";

export interface ModelOption {
  ref: string;
  label: string;
  locality: "local" | "hosted";
  /** Honest reason when the engine reports the binding unusable; absent = selectable. */
  unavailableReason?: string;
  /** Qualification labels shown as-is, e.g. "unbenchmarked". No brand whitelist. */
  labels?: string[];
}

export interface TransitionView {
  transitionId: string | null;
  requestedRef: string;
  disposition: Disposition;
  status: TransitionStatus;
  reason?: string;
  /** The engine applied a binding other than the one the user asked for. */
  mismatch: boolean;
}

export interface ModelSelectionState {
  /** The binding the engine reports as active. Changes only on an applied transition. */
  currentRef: string;
  transition: TransitionView | null;
}

export const createModelSelection = (
  currentRef: string,
): ModelSelectionState => ({ currentRef, transition: null });

export function requestSwitch(
  state: ModelSelectionState,
  requestedRef: string,
  disposition: Disposition,
): ModelSelectionState {
  return {
    ...state,
    transition: {
      transitionId: null,
      requestedRef,
      disposition,
      status: "requested",
      mismatch: false,
    },
  };
}

const STATUS: Record<SelectionTransitionRecord["state"], TransitionStatus> = {
  pending: "pending",
  ready: "applied",
  failed: "rejected",
  canceled: "canceled",
};

/**
 * Folds an engine selectionTransition record in. The active binding moves only
 * on `ready`; a rejected or canceled switch keeps the previous binding.
 */
export function applyTransition(
  state: ModelSelectionState,
  record: SelectionTransitionRecord,
  reason?: string,
): ModelSelectionState {
  const status = STATUS[record.state];
  // The user's intent lives for the whole transition; engine records never overwrite it.
  const prev = state.transition;
  const requestedRef =
    prev &&
    (prev.transitionId === null || prev.transitionId === record.transitionId)
      ? prev.requestedRef
      : record.requestedBindingRef;
  const mismatch = record.requestedBindingRef !== requestedRef;
  return {
    currentRef:
      status === "applied" ? record.requestedBindingRef : state.currentRef,
    transition: {
      transitionId: record.transitionId,
      requestedRef,
      disposition: record.disposition,
      status,
      reason: status === "rejected" ? (reason ?? "No reason reported") : reason,
      mismatch,
    },
  };
}

export function whenEffective(
  disposition: Disposition,
  turnActive: boolean,
): string {
  if (!turnActive) return "Takes effect on the next turn";
  return disposition === "cancel-and-switch"
    ? "Cancels the running turn, then takes effect"
    : "Takes effect after the running turn ends";
}
