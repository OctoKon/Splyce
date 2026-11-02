import type { RecordByKind } from "@splyce/pi/contracts";

export type StatusTone =
  "unknown" | "neutral" | "active" | "positive" | "negative" | "warning";

export type StatusValue =
  | "unknown"
  | "pending"
  | "proposed"
  | "approved"
  | "denied"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "uncertain"
  | "ready"
  | "staging"
  | "installed"
  | "removing"
  | "removed"
  | "applied"
  | "draining"
  | "cleanup-pending"
  | "timed-out"
  | "streaming"
  | "waiting-approval"
  | "stopped"
  | "success";

export interface StatusView {
  readonly label: string;
  readonly tone: StatusTone;
  readonly status: StatusValue;
}

export type StatusRecordKind =
  | "run"
  | "action"
  | "outcome"
  | "selectionTransition"
  | "configurationTransition"
  | "packageInstallation";

export interface StatusProjectionRecords {
  run: Pick<RecordByKind["run"], "state">;
  action: Pick<RecordByKind["action"], "state">;
  outcome: Pick<
    RecordByKind["outcome"],
    "effectState" | "cleanupState" | "errorClass"
  >;
  selectionTransition: Pick<RecordByKind["selectionTransition"], "state">;
  configurationTransition: Pick<
    RecordByKind["configurationTransition"],
    "state"
  >;
  packageInstallation: Pick<RecordByKind["packageInstallation"], "state">;
}

const UNKNOWN: StatusView = Object.freeze({
  label: "Unknown",
  tone: "unknown",
  status: "unknown",
});

function view(
  label: string,
  tone: StatusTone,
  status: StatusValue,
): StatusView {
  return { label, tone, status };
}

const STATE_VIEWS: Readonly<Record<string, StatusView>> = Object.freeze({
  pending: view("Pending", "neutral", "pending"),
  proposed: view("Proposed", "neutral", "proposed"),
  approved: view("Approved", "positive", "approved"),
  denied: view("Denied", "negative", "denied"),
  running: view("Running", "active", "running"),
  completed: view("Completed", "positive", "completed"),
  failed: view("Failed", "negative", "failed"),
  canceled: view("Canceled", "neutral", "canceled"),
  uncertain: view("Uncertain", "warning", "uncertain"),
  ready: view("Ready", "positive", "ready"),
  staging: view("Staging", "neutral", "staging"),
  installed: view("Installed", "positive", "installed"),
  removing: view("Removing", "active", "removing"),
  removed: view("Removed", "neutral", "removed"),
  applied: view("Applied", "positive", "applied"),
  draining: view("Draining", "active", "draining"),
});

function projectState(state: unknown): StatusView {
  if (typeof state !== "string" || !Object.hasOwn(STATE_VIEWS, state))
    return UNKNOWN;
  return STATE_VIEWS[state]!;
}

export type TurnViewStatus =
  | "streaming"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "canceled"
  | "stopped";

export type ToolViewStatus =
  "pending" | "success" | "error" | "uncertain" | "canceled";

const TURN_STATUS_VIEWS: Readonly<Record<TurnViewStatus, StatusView>> =
  Object.freeze({
    streaming: view("Working", "active", "streaming"),
    waiting_approval: view(
      "Waiting for approval",
      "warning",
      "waiting-approval",
    ),
    completed: view("Completed", "positive", "completed"),
    failed: view("Failed", "negative", "failed"),
    canceled: view("Canceled", "neutral", "canceled"),
    stopped: view("Stopped", "neutral", "stopped"),
  });

const TOOL_STATUS_VIEWS: Readonly<Record<ToolViewStatus, StatusView>> =
  Object.freeze({
    pending: view("Pending - not executed", "neutral", "pending"),
    success: view("Success", "positive", "success"),
    error: view("Failed", "negative", "failed"),
    uncertain: view("Uncertain", "warning", "uncertain"),
    canceled: view("Canceled", "neutral", "canceled"),
  });

export function projectTurnStatus(
  status: TurnViewStatus | null | undefined,
): StatusView {
  if (!status || !Object.hasOwn(TURN_STATUS_VIEWS, status)) return UNKNOWN;
  return TURN_STATUS_VIEWS[status]!;
}

export function projectToolStatus(
  status: ToolViewStatus | null | undefined,
): StatusView {
  if (!status || !Object.hasOwn(TOOL_STATUS_VIEWS, status)) return UNKNOWN;
  return TOOL_STATUS_VIEWS[status]!;
}

function projectOutcome(
  record: StatusProjectionRecords["outcome"] | null | undefined,
): StatusView {
  if (!record) return UNKNOWN;
  const { effectState, cleanupState, errorClass } = record;

  if (errorClass === "policy-denied")
    return view("Denied", "negative", "denied");
  if (errorClass === "canceled") return view("Canceled", "neutral", "canceled");
  if (errorClass === "timeout")
    return view("Timed out", "warning", "timed-out");

  if (effectState === "uncertain" || cleanupState === "uncertain") {
    return view("Uncertain", "warning", "uncertain");
  }

  if (
    effectState === "observed-failure" ||
    cleanupState === "failed" ||
    errorClass === "validation" ||
    errorClass === "execution" ||
    errorClass === "unknown"
  ) {
    return view("Failed", "negative", "failed");
  }

  if (effectState === "observed-success") {
    if (cleanupState === "pending") {
      return view("Cleanup pending", "warning", "cleanup-pending");
    }
    if (cleanupState === "complete" || cleanupState === "not-required") {
      return view("Completed", "positive", "completed");
    }
  }

  return UNKNOWN;
}

/**
 * Maps existing durable record state fields to fixed display metadata. The
 * projection never returns the record, its metadata or any error/path text.
 */
export function projectStatus<K extends StatusRecordKind>(
  kind: K,
  record: StatusProjectionRecords[K] | null | undefined,
): StatusView {
  if (kind === "outcome") {
    return projectOutcome(
      record as StatusProjectionRecords["outcome"] | null | undefined,
    );
  }
  const state = (record as { state?: unknown } | null | undefined)?.state;
  return projectState(state);
}
