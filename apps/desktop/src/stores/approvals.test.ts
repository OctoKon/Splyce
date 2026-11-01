import { describe, expect, it } from "vitest";
import type { EventPayloads } from "@splyce/pi/contracts";
import {
  activeApproval,
  approvalBlockers,
  approvalDecisionState,
  approvalExpiresAt,
  approvalResolution,
  approvalResponse,
  approvalTargetMatches,
  type ApprovalContext,
  type ApprovalRequestView,
} from "./approvals";

const REVISION = {
  configRevision: "cfg-1",
  profileRevision: "prof-1",
  policyRevision: "pol-1",
} as const;

const payload: EventPayloads["approval.requested"] = {
  approvalRequestId: "apr-1",
  runId: "run-1",
  actionId: "act-1",
  capabilityId: "fs.write",
  targetScope: "scope-1",
  normalizedTarget: "src/index.ts",
  riskRationale: "Writes a file inside the selected workspace.",
  timeoutMs: 60_000,
};

const request: ApprovalRequestView = {
  request: payload,
  sessionId: "ses-1",
  scopeId: "scope-1",
  receivedSeq: 3,
  receivedAtMs: 1_000,
  revision: REVISION,
};

const context = (
  overrides: Partial<ApprovalContext> = {},
): ApprovalContext => ({
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
  ...overrides,
});

describe("TD-30 approval correlation", () => {
  it("enables approve only for the exact request identity and revisions", () => {
    expect(approvalBlockers(request, context())).toEqual([]);
    expect(approvalTargetMatches(request, context())).toBe(true);
    expect(approvalDecisionState(request, context(), "approve").enabled).toBe(
      true,
    );
    expect(approvalDecisionState(request, context(), "deny").enabled).toBe(
      true,
    );
  });

  it("blocks a wrong run, action or target even when the dialog still renders", () => {
    const wrongRun = context({ runId: "run-2" });
    const wrongAction = context({ actionId: "act-2" });
    const wrongTarget = context({ normalizedTarget: "src/other.ts" });
    const wrongScope = context({ targetScope: "scope-2" });

    for (const [ctx, reason] of [
      [wrongRun, "different run"],
      [wrongAction, "different action"],
      [wrongTarget, "target changed"],
      [wrongScope, "target scope changed"],
    ] as const) {
      expect(approvalTargetMatches(request, ctx)).toBe(false);
      const state = approvalDecisionState(request, ctx, "approve");
      expect(state.enabled).toBe(false);
      expect(state.reason).toContain(reason);
      const response = approvalResponse(request, ctx, "approve");
      expect(response.ok).toBe(false);
    }
  });

  it("blocks a changed configuration, profile or policy revision", () => {
    for (const revision of [
      { ...REVISION, configRevision: "cfg-2" },
      { ...REVISION, profileRevision: "prof-2" },
      { ...REVISION, policyRevision: "pol-2" },
    ]) {
      const state = approvalDecisionState(
        request,
        context({ revision }),
        "approve",
      );
      expect(state.enabled).toBe(false);
      expect(state.reason).toContain("revision changed");
    }
    // A missing current revision is not "unchanged".
    expect(
      approvalDecisionState(request, context({ revision: null }), "approve")
        .enabled,
    ).toBe(false);
  });

  it("blocks approval of a session or scope that no longer owns the request", () => {
    expect(
      approvalDecisionState(request, context({ sessionId: "ses-2" }), "approve")
        .reason,
    ).toContain("different session");
    expect(
      approvalDecisionState(request, context({ scopeId: "scope-9" }), "approve")
        .reason,
    ).toContain("different scope");
  });

  it("expires at the contract timeout and never treats a missing timeout as no expiry", () => {
    expect(approvalExpiresAt(request)).toBe(61_000);
    expect(
      approvalDecisionState(request, context({ nowMs: 60_999 }), "approve")
        .enabled,
    ).toBe(true);
    expect(
      approvalDecisionState(request, context({ nowMs: 61_000 }), "approve")
        .enabled,
    ).toBe(false);

    const withoutTimeout: ApprovalRequestView = {
      ...request,
      request: { ...payload, timeoutMs: undefined },
    };
    expect(approvalExpiresAt(withoutTimeout)).toBe(1_000 + 120_000);
  });

  it("fails closed when the engine is unavailable or the run was canceled", () => {
    const offline = context({
      engine: "unavailable",
      engineReason: "Engine process exited.",
    });
    expect(approvalDecisionState(request, offline, "approve").reason).toContain(
      "Engine process exited.",
    );

    const canceled = context({ runCanceled: true });
    const approve = approvalResponse(request, canceled, "approve");
    expect(approve.ok).toBe(false);
    expect(approve.ok === false && approve.reason).toContain(
      "rejects late approvals",
    );
    // Deny is inert too: the run is over, so no decision can be submitted.
    expect(approvalDecisionState(request, canceled, "deny").enabled).toBe(
      false,
    );
  });

  it("submits identity from the received request, not from UI state", () => {
    const response = approvalResponse(request, context(), "approve");
    expect(response).toEqual({
      ok: true,
      payload: {
        approvalRequestId: "apr-1",
        runId: "run-1",
        actionId: "act-1",
        decision: "approve",
      },
    });
  });

  it("reports a late approval as rejected, never as approved", () => {
    expect(
      approvalResolution("approve", {
        accepted: false,
        reason: "approval_rejected{run_canceled}",
      }),
    ).toEqual({
      state: "rejected",
      reason: "approval_rejected{run_canceled}",
    });
    expect(approvalResolution("approve", { accepted: true })).toEqual({
      state: "approved",
    });
    expect(approvalResolution("deny", { accepted: true })).toEqual({
      state: "denied",
      reason: null,
    });
  });

  it("shows the newest request so a stale dialog cannot outrank a new target", () => {
    const newer: ApprovalRequestView = {
      ...request,
      receivedSeq: 4,
      request: { ...payload, approvalRequestId: "apr-2", actionId: "act-2" },
    };
    expect(activeApproval([])).toBeNull();
    expect(activeApproval([newer, request])?.request.approvalRequestId).toBe(
      "apr-2",
    );
    expect(activeApproval([request, newer])?.request.approvalRequestId).toBe(
      "apr-2",
    );
  });
});
