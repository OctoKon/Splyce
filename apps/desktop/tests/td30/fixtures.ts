/**
 * TD-30 approval fixtures (D3_approval_revision, FUI-W5, U1_permission_mode).
 *
 * Presentation inputs for the approval dialog. They are not an engine: the store
 * decides what is valid, and these fixtures only describe what the renderer was
 * told.
 */
import type { EventPayloads } from "@splyce/pi/contracts";
import type {
  ApprovalContext,
  ApprovalRequestView,
} from "../../src/stores/approvals";

const REVISION = {
  configRevision: "cfg-1",
  profileRevision: "prof-1",
  policyRevision: "pol-1",
} as const;

export const approvalPayload: EventPayloads["approval.requested"] = {
  approvalRequestId: "apr-1",
  runId: "run-1",
  actionId: "act-1",
  capabilityId: "fs.write",
  targetScope: "scope-1",
  normalizedTarget: "src/index.ts",
  riskRationale: "Writes a file inside the selected workspace.",
  timeoutMs: 60_000,
};

export const approvalRequest: ApprovalRequestView = {
  request: approvalPayload,
  sessionId: "ses-1",
  scopeId: "scope-1",
  receivedSeq: 1,
  receivedAtMs: 1_000,
  revision: REVISION,
};

/** The prompt is still the authorized target. */
export const approvalMatching: ApprovalContext = {
  engine: "ready",
  engineReason: null,
  sessionId: "ses-1",
  scopeId: "scope-1",
  runId: "run-1",
  actionId: "act-1",
  targetScope: "scope-1",
  normalizedTarget: "src/index.ts",
  revision: REVISION,
  runCanceled: false,
  nowMs: 2_000,
};

/** The same request, but the current target/run is a different one. */
export const approvalWrongTarget: ApprovalContext = {
  ...approvalMatching,
  runId: "run-2",
  actionId: "act-2",
  normalizedTarget: "src/other.ts",
};

/** Revisions moved after the prompt arrived (config/profile/policy). */
export const approvalStaleRevision: ApprovalContext = {
  ...approvalMatching,
  revision: { ...REVISION, configRevision: "cfg-2" },
};

/** The run was canceled while the prompt was open (late approval race). */
export const approvalRunCanceled: ApprovalContext = {
  ...approvalMatching,
  runCanceled: true,
};

/** The engine is gone; the prompt must not imply hidden consent. */
export const approvalEngineUnavailable: ApprovalContext = {
  ...approvalMatching,
  engine: "unavailable",
  engineReason: "Engine process exited.",
};

/** The contract timeout elapsed before a decision. */
export const approvalExpired: ApprovalContext = {
  ...approvalMatching,
  nowMs: 1_000 + 60_000,
};
