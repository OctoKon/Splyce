/**
 * TD-30 permission-mode selector (U1_permission_mode).
 *
 * Mode changes are engine-admitted, not local preferences: the selector shows
 * the requested mode as pending until native acknowledgement, then the effective
 * mode. A rejection keeps the previous mode. Bypass-class modes require a
 * separate confirmation that defaults to the safe choice, the change is
 * announced once, and a mode never carries into another session.
 */
export type PermissionMode =
  "manual" | "accept-edits" | "plan" | "auto" | "bypass";

export type PermissionModeStatus = "idle" | "pending" | "rejected";

export interface PermissionModeState {
  readonly sessionId: string | null;
  /** The mode the engine has acknowledged for this session. */
  readonly effective: PermissionMode;
  /** The mode awaiting acknowledgement, if any. */
  readonly requested: PermissionMode | null;
  readonly status: PermissionModeStatus;
  readonly reason: string | null;
  /** Increments once per acknowledged change; the live region reads this. */
  readonly announcementSeq: number;
}

export interface PermissionModeContext {
  readonly engine: "ready" | "unavailable";
  readonly engineReason: string | null;
  /** Revisions the transition is requested against. */
  readonly configRevision: string | null;
  readonly policyRevision: string | null;
}

export const SAFE_PERMISSION_MODE: PermissionMode = "manual";

export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = Object.freeze([
  "manual",
  "accept-edits",
  "plan",
  "auto",
  "bypass",
]);

export const PERMISSION_MODE_LABELS: Readonly<Record<PermissionMode, string>> =
  Object.freeze({
    manual: "Manual",
    "accept-edits": "Accept edits",
    plan: "Plan only",
    auto: "Auto",
    bypass: "Bypass (unsafe)",
  });

/** Bypass-class modes need their own confirmation; the safe choice is default. */
export function requiresModeConfirmation(mode: PermissionMode): boolean {
  return mode === "bypass";
}

export function initialPermissionMode(
  sessionId: string | null,
): PermissionModeState {
  return {
    sessionId,
    effective: SAFE_PERMISSION_MODE,
    requested: null,
    status: "idle",
    reason: null,
    announcementSeq: 0,
  };
}

/**
 * A mode never leaks across sessions: the new session starts effective-safe and
 * any pending request from the old session is discarded.
 */
export function bindPermissionSession(
  state: PermissionModeState,
  sessionId: string | null,
): PermissionModeState {
  if (state.sessionId === sessionId) return state;
  return initialPermissionMode(sessionId);
}

export type ModeRequest =
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind: "confirm";
      readonly mode: PermissionMode;
      readonly reason: string;
    }
  | { readonly kind: "requested"; readonly state: PermissionModeState };

/** Why a mode change may not be admitted at all, regardless of confirmation. */
function blockedModeReason(
  state: PermissionModeState,
  mode: PermissionMode,
  context: PermissionModeContext,
): string | null {
  if (context.engine !== "ready") {
    return (
      context.engineReason ?? "Engine unavailable; the mode cannot be changed."
    );
  }
  if (state.status === "pending" && state.requested === mode) {
    return "That mode change is already awaiting the engine.";
  }
  if (!context.configRevision || !context.policyRevision) {
    return "Current configuration and policy revisions are not known.";
  }
  if (mode === state.effective) {
    return `${PERMISSION_MODE_LABELS[mode]} is already the effective mode.`;
  }
  return null;
}

function requestedMode(
  state: PermissionModeState,
  mode: PermissionMode,
): ModeRequest {
  return {
    kind: "requested",
    state: {
      ...state,
      requested: mode,
      status: "pending",
      reason: null,
    },
  };
}

/**
 * Asks for a mode change. Nothing becomes effective here: the caller submits the
 * command, and only `acknowledgeMode` may change the effective mode.
 */
export function requestPermissionMode(
  state: PermissionModeState,
  mode: PermissionMode,
  context: PermissionModeContext,
): ModeRequest {
  const blocked = blockedModeReason(state, mode, context);
  if (blocked) {
    return { kind: "blocked", reason: blocked };
  }
  if (requiresModeConfirmation(mode)) {
    return {
      kind: "confirm",
      mode,
      reason:
        "Bypass mode removes approval prompts. Confirm separately; the safe choice keeps the current mode.",
    };
  }
  return requestedMode(state, mode);
}

/**
 * The caller obtained the separate confirmation for a mode that requires one.
 * The engine and revision guards still apply - only the confirmation gate is
 * skipped, so a confirmed request can never become effective locally either.
 */
export function confirmedPermissionModeRequest(
  state: PermissionModeState,
  mode: PermissionMode,
  context: PermissionModeContext,
): ModeRequest {
  const blocked = blockedModeReason(state, mode, context);
  if (blocked) {
    return { kind: "blocked", reason: blocked };
  }
  return requestedMode(state, mode);
}

/**
 * The identity a separate confirmation was opened against. A confirmation is
 * not a capability: it only says "the user agreed to this mode for THIS session
 * under THESE revisions". If any of those change before the user confirms, the
 * answer no longer refers to the target being asked about.
 */
export interface ModeConfirmation {
  readonly mode: PermissionMode;
  readonly sessionId: string | null;
  readonly configRevision: string | null;
  readonly policyRevision: string | null;
}

/** Captures the confirmation identity, or null when the mode needs none/is blocked. */
export function modeConfirmation(
  state: PermissionModeState,
  mode: PermissionMode,
  context: PermissionModeContext,
): ModeConfirmation | null {
  if (!requiresModeConfirmation(mode)) return null;
  if (blockedModeReason(state, mode, context) !== null) return null;
  return {
    mode,
    sessionId: state.sessionId,
    configRevision: context.configRevision,
    policyRevision: context.policyRevision,
  };
}

/**
 * Why a captured confirmation is no longer valid against the current state.
 * `null` means it still names exactly the target the user is being asked about.
 * The engine and revision guards are re-run here, so a confirmation opened
 * before the engine went away cannot be accepted afterwards.
 */
export function confirmationInvalidReason(
  state: PermissionModeState,
  confirmation: ModeConfirmation,
  context: PermissionModeContext,
): string | null {
  if (state.sessionId !== confirmation.sessionId) {
    return "The session changed while the confirmation was open. Reopen it for this session.";
  }
  if (
    context.configRevision !== confirmation.configRevision ||
    context.policyRevision !== confirmation.policyRevision
  ) {
    return "Configuration or policy changed while the confirmation was open. Reopen it to review the current revisions.";
  }
  return blockedModeReason(state, confirmation.mode, context);
}

export type ModeConfirmationResult =
  | { readonly kind: "requested"; readonly state: PermissionModeState }
  | { readonly kind: "invalidated"; readonly reason: string };

/**
 * Accepts a previously captured confirmation. It never applies the mode: it
 * re-validates the captured identity against the CURRENT state and context, and
 * refuses (producing no request) when anything changed. This is the last guard,
 * so a stale rendered dialog cannot request a mode for a different session or
 * after the engine went away.
 */
export function confirmPermissionMode(
  state: PermissionModeState,
  confirmation: ModeConfirmation,
  context: PermissionModeContext,
): ModeConfirmationResult {
  const invalid = confirmationInvalidReason(state, confirmation, context);
  if (invalid !== null) return { kind: "invalidated", reason: invalid };
  const request = confirmedPermissionModeRequest(
    state,
    confirmation.mode,
    context,
  );
  if (request.kind === "blocked") {
    return { kind: "invalidated", reason: request.reason };
  }
  if (request.kind !== "requested") {
    // A confirmed mode never asks for a second confirmation; treat any other
    // shape as a refusal rather than guessing.
    return { kind: "invalidated", reason: request.reason };
  }
  return { kind: "requested", state: request.state };
}

/** Engine acknowledgement: the requested mode becomes effective exactly once. */
export function acknowledgeMode(
  state: PermissionModeState,
  mode: PermissionMode,
): PermissionModeState {
  if (state.requested !== mode) return state;
  return {
    ...state,
    effective: mode,
    requested: null,
    status: "idle",
    reason: null,
    announcementSeq: state.announcementSeq + 1,
  };
}

/** Engine rejection: the previous effective mode stays, with its reason shown. */
export function rejectMode(
  state: PermissionModeState,
  reason: string,
): PermissionModeState {
  if (state.requested === null) return state;
  return {
    ...state,
    requested: null,
    status: "rejected",
    reason,
  };
}

export interface PermissionModeView {
  readonly effectiveLabel: string;
  /** Shown next to the effective mode while a change is pending. */
  readonly pendingLabel: string | null;
  readonly rejectedReason: string | null;
  readonly announcement: string | null;
  readonly options: readonly {
    readonly mode: PermissionMode;
    readonly label: string;
    readonly selected: boolean;
    readonly pending: boolean;
    readonly dangerous: boolean;
  }[];
}

export function permissionModeView(
  state: PermissionModeState,
): PermissionModeView {
  return {
    effectiveLabel: PERMISSION_MODE_LABELS[state.effective],
    pendingLabel:
      state.status === "pending" && state.requested
        ? `${PERMISSION_MODE_LABELS[state.requested]} (pending engine)`
        : null,
    rejectedReason: state.status === "rejected" ? state.reason : null,
    announcement:
      state.announcementSeq === 0
        ? null
        : `Permission mode is now ${PERMISSION_MODE_LABELS[state.effective]}.`,
    options: PERMISSION_MODE_ORDER.map((mode) => ({
      mode,
      label: PERMISSION_MODE_LABELS[mode],
      selected: state.effective === mode,
      pending: state.status === "pending" && state.requested === mode,
      dangerous: requiresModeConfirmation(mode),
    })),
  };
}
