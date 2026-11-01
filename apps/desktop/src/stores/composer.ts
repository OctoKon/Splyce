import type { CommandPayloads } from "@splyce/pi/contracts";
import type { EngineConnectionState } from "./engine";

export type PromptPayload = CommandPayloads["session.prompt"];

export interface ComposerAvailability {
  connection: EngineConnectionState;
  sessionId: string | null;
  /** Command revisions are stale: the UI must refresh before sending. */
  stale: boolean;
  /** A prompt was already sent and is not settled yet. */
  pending: boolean;
  /**
   * Engine-reported generation readiness.
   *
   * `true` = the engine proved a generation port is ready.
   * `false` = the engine proved it is NOT configured (no profile/model).
   * `undefined` = readiness was not reported, which is not the same claim.
   *
   * Fail closed: anything but `true` blocks sending.
   */
  generationReady?: boolean;
  /** Sending is not wired for this session yet; shown as the blocked reason. */
  unavailable?: string;
}

/** Honest reason sending is blocked, or null when allowed. */
export function sendBlockedReason(a: ComposerAvailability): string | null {
  if (a.pending) return "Sending the previous message.";
  if (a.connection === "disconnected") return "Engine is not connected.";
  if (a.connection === "connecting") return "Engine is still connecting.";
  if (a.connection === "error") return "Engine reported an error.";
  if (a.connection === "busy")
    return "A turn is running. Press Esc to cancel it.";
  if (!a.sessionId) return "No session is selected.";
  // Contract (commons/backend-frontend-contracts.md): generation=false must read
  // "Generation unconfigured" and keep send disabled, so the generation gate
  // wins over the wiring gap. Once generation is true, the wiring gap is shown.
  if (a.generationReady === false)
    return "Generation unconfigured. Connect a provider and select a model.";
  if (a.connection === "unavailable") return "Engine is unavailable.";
  // Unreported is its own state: the engine has not said whether generation is
  // configured, so claiming it is unconfigured would be a false statement.
  if (a.generationReady !== true)
    return "Generation readiness has not been reported yet. Sending stays blocked.";
  if (a.unavailable) return a.unavailable;
  if (a.stale) return "Session state is out of date. Refresh before sending.";
  return null;
}

/** textarea.value is already LF-normalised; normalise again for pasted/set values. */
export const normalizeDraft = (value: string): string =>
  value.replace(/\r\n?/g, "\n");

export function buildPrompt(
  draft: string,
  contextArtifactIds: readonly string[] = [],
): PromptPayload | null {
  const text = normalizeDraft(draft);
  if (text.trim() === "") return null;
  return contextArtifactIds.length > 0
    ? { text, contextArtifactIds: [...contextArtifactIds] }
    : { text };
}

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export type ComposerKeyAction = "send" | "cancel" | "none";

/** Maps a keydown to an action; never acts while an IME composition is active. */
export function keyAction(e: KeyLike, composing = false): ComposerKeyAction {
  if (composing || e.isComposing || e.keyCode === 229) return "none";
  if (e.key === "Enter" && (!e.shiftKey || e.ctrlKey)) return "send";
  if (e.key === "Escape") return "cancel";
  return "none";
}
