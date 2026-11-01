export type VerifierState =
  "passed" | "failed" | "uncertain" | "running" | "not-run";
export type ShownState = VerifierState | "stale";

export interface VerifierResult {
  readonly verifierId: string;
  readonly name: string;
  /** Snapshot the verifier actually ran against. */
  readonly snapshotId: string;
  readonly state: VerifierState;
}

export interface ShownResult {
  readonly verifierId: string;
  readonly name: string;
  readonly state: ShownState;
  readonly label: string;
}

const LABEL: Record<ShownState, string> = {
  passed: "Passed",
  failed: "Failed",
  uncertain: "Uncertain - not confirmed",
  running: "Running",
  "not-run": "Not run",
  stale: "Stale - inputs changed since this ran",
};

/** A result only counts for the current final snapshot; anything else is stale, whatever its recorded state. */
export function project(
  currentSnapshotId: string,
  r: VerifierResult,
): ShownResult {
  const state: ShownState =
    r.snapshotId !== currentSnapshotId && r.state !== "not-run"
      ? "stale"
      : r.state;
  return { verifierId: r.verifierId, name: r.name, state, label: LABEL[state] };
}

export type Overall = "verified" | "failed" | "incomplete";

/** Verified only when at least one verifier exists and every one is a fresh pass. */
export function overall(shown: readonly ShownResult[]): Overall {
  if (shown.some((s) => s.state === "failed")) return "failed";
  return shown.length > 0 && shown.every((s) => s.state === "passed")
    ? "verified"
    : "incomplete";
}
