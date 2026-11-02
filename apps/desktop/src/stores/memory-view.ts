import { engine } from "./engine";
import type { MemoryObservationRecord } from "@splyce/pi/contracts";

/**
 * Engine-reported memory subsystem state plus the feed's own states; drives the
 * honest empty state. `loading` is "no snapshot has arrived yet" and `error` is
 * "the snapshot did not arrive" - neither of them means memory is empty, so
 * they must never borrow the on-state copy.
 */
export type MemoryStatus = "loading" | "on" | "off" | "unavailable" | "error";

export interface MemoryEntry {
  observation: MemoryObservationRecord;
  /** Claim text resolved from claimArtifactId; null when the artifact is not readable. */
  claim: string | null;
  /** Where it was learned from, e.g. a session or file label. */
  source: string;
  scope: string;
  /** Locality of the extraction role that produced it. */
  locality: "local" | "hosted";
  /** Engine truth: deletion is "purge-pending" until the engine reports it complete. */
  state: "active" | "purge-pending";
}

export function emptyMessage(status: MemoryStatus, stale = false): string {
  switch (status) {
    case "loading":
      return "Loading remembered items…";
    case "error":
      return "Memory could not be loaded. What is remembered is unknown - not empty.";
    case "off":
      return "Memory is off. Nothing is being remembered.";
    case "unavailable":
      return "Memory is unavailable. Remembered items cannot be shown.";
    default:
      // A stale list cannot claim nothing is remembered: the snapshot may be old.
      return stale
        ? "No remembered items are shown, and this list may be out of date."
        : "Nothing is remembered yet.";
  }
}

export const localityLabel = (l: MemoryEntry["locality"]): string =>
  l === "local" ? "Local" : "Cloud (hosted)";

export async function listMemory(workspaceId: string, requestId: string) {
  return engine.readPage("memory.list", requestId, { workspaceId });
}

export async function searchMemory(
  workspaceId: string,
  query: string,
  requestId: string,
) {
  return engine.readPage("memory.search", requestId, { workspaceId, query });
}
