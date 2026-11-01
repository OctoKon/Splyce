/**
 * TD-30 approval view model (D3_approval_revision, FUI-W5, U1_permission_mode).
 *
 * The renderer owns temporary dialog state only. An approval is one-use and
 * bound to the engine's exact request identity: the same session, scope, run,
 * action, target scope and target, under the revisions it was issued against.
 * Anything that changes after the request arrived makes the dialog inert, and a
 * decision is never submitted for a target the user is no longer looking at.
 *
 * No effect runs from this module: it produces the `approval.respond` payload
 * and refuses to produce one when the correlation or expiry does not hold.
 */
import type { CommandPayloads, EventPayloads } from "@splyce/pi/contracts";

export type ApprovalRequestedPayload = EventPayloads["approval.requested"];
export type ApprovalDecision = CommandPayloads["approval.respond"]["decision"];
export type ApprovalResponsePayload = CommandPayloads["approval.respond"];

/** Revisions and identities the request was issued against. */
export interface ApprovalRevision {
  readonly configRevision: string;
  readonly profileRevision: string;
  readonly policyRevision: string;
}

/** A request as received, with the identity that owns it. */
export interface ApprovalRequestView {
  readonly request: ApprovalRequestedPayload;
  readonly sessionId: string;
  readonly scopeId: string;
  /** Monotonic arrival order, so a newer request supersedes an older one. */
  readonly receivedSeq: number;
  readonly receivedAtMs: number;
  readonly revision: ApprovalRevision;
}

/** What the renderer currently believes about the target of the request. */
export interface ApprovalContext {
  readonly engine: "ready" | "unavailable";
  readonly engineReason: string | null;
  readonly sessionId: string | null;
  readonly scopeId: string | null;
  readonly runId: string | null;
  readonly actionId: string | null;
  readonly targetScope: string | null;
  readonly normalizedTarget: string | null;
  readonly revision: ApprovalRevision | null;
  /** The engine reported the run canceled before a decision was submitted. */
  readonly runCanceled: boolean;
  readonly nowMs: number;
}

export interface ApprovalActionState {
  readonly enabled: boolean;
  readonly reason: string | null;
}

/**
 * Why the prompt went away. `canceled` means the run ended the question itself;
 * `user` means the person closed it (Close or Escape). The cause is reported by
 * the dialog that saw it and is never inferred from the run state: a dialog the
 * user closes by hand after the run ended is still a user dismissal.
 */
export type ApprovalDismissCause = "canceled" | "user";

const READY: ApprovalActionState = Object.freeze({
  enabled: true,
  reason: null,
});

const blocked = (reason: string): ApprovalActionState => ({
  enabled: false,
  reason,
});

export const APPROVAL_DECISION_LABELS: Readonly<
  Record<ApprovalDecision, string>
> = Object.freeze({
  approve: "Approve",
  deny: "Deny",
});

/** `timeoutMs` is optional in the frozen contract; absence is not "never expires". */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

export function approvalExpiresAt(request: ApprovalRequestView): number {
  const timeout = request.request.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  return request.receivedAtMs + timeout;
}

export function approvalExpired(
  request: ApprovalRequestView,
  nowMs: number,
): boolean {
  return nowMs >= approvalExpiresAt(request);
}

/**
 * Every reason the dialog must be inert, in a fixed order so tests and the UI
 * agree. An empty list means the request is still the authorized target.
 */
export function approvalBlockers(
  request: ApprovalRequestView,
  context: ApprovalContext,
): readonly string[] {
  const reasons: string[] = [];

  if (context.engine !== "ready") {
    reasons.push(
      context.engineReason ??
        "Engine unavailable; an approval cannot be submitted.",
    );
  }
  if (context.sessionId !== request.sessionId) {
    reasons.push("The approval belongs to a different session.");
  }
  if (context.scopeId !== request.scopeId) {
    reasons.push("The approval belongs to a different scope.");
  }
  if (context.runId !== request.request.runId) {
    reasons.push("The approval belongs to a different run.");
  }
  if (context.actionId !== request.request.actionId) {
    reasons.push("The approval belongs to a different action.");
  }
  if (context.targetScope !== request.request.targetScope) {
    reasons.push("The approval target scope changed.");
  }
  if (context.normalizedTarget !== request.request.normalizedTarget) {
    reasons.push("The approval target changed after it was requested.");
  }
  if (!sameRevision(context.revision, request.revision)) {
    reasons.push("Configuration, profile or policy revision changed.");
  }
  if (context.runCanceled) {
    reasons.push(
      "The run was canceled; the engine rejects late approvals without effects.",
    );
  }
  if (approvalExpired(request, context.nowMs)) {
    reasons.push("The approval request expired before a decision.");
  }

  return reasons;
}

function sameRevision(
  current: ApprovalRevision | null,
  expected: ApprovalRevision,
): boolean {
  if (!current) return false;
  return (
    current.configRevision === expected.configRevision &&
    current.profileRevision === expected.profileRevision &&
    current.policyRevision === expected.policyRevision
  );
}

/** True when this request is the one the user is currently being asked about. */
export function approvalTargetMatches(
  request: ApprovalRequestView,
  context: ApprovalContext,
): boolean {
  return (
    context.sessionId === request.sessionId &&
    context.scopeId === request.scopeId &&
    context.runId === request.request.runId &&
    context.actionId === request.request.actionId &&
    context.targetScope === request.request.targetScope &&
    context.normalizedTarget === request.request.normalizedTarget &&
    sameRevision(context.revision, request.revision)
  );
}

/**
 * The single decision control's state. Deny is offered for the same inert
 * request: it needs no engine grant and cannot manufacture an effect.
 */
export function approvalDecisionState(
  request: ApprovalRequestView,
  context: ApprovalContext,
  decision: ApprovalDecision,
): ApprovalActionState {
  const reasons = approvalBlockers(request, context);
  if (reasons.length > 0) return blocked(reasons[0]);
  if (decision !== "approve" && decision !== "deny") {
    return blocked("Unknown approval decision.");
  }
  return READY;
}

export interface ApprovalResponseAccepted {
  readonly ok: true;
  readonly payload: ApprovalResponsePayload;
}

export interface ApprovalResponseRejected {
  readonly ok: false;
  readonly reason: string;
}

/**
 * Builds the exact `approval.respond` payload, or refuses. Identity always comes
 * from the received request, never from UI state, so a re-rendered or retargeted
 * dialog cannot approve a different action.
 */
export function approvalResponse(
  request: ApprovalRequestView,
  context: ApprovalContext,
  decision: ApprovalDecision,
): ApprovalResponseAccepted | ApprovalResponseRejected {
  const state = approvalDecisionState(request, context, decision);
  if (!state.enabled) {
    return {
      ok: false,
      reason: state.reason ?? "The approval is no longer valid.",
    };
  }
  return {
    ok: true,
    payload: {
      approvalRequestId: request.request.approvalRequestId,
      runId: request.request.runId,
      actionId: request.request.actionId,
      decision,
    },
  };
}

export type ApprovalResolution =
  | { readonly state: "approved" }
  | { readonly state: "denied"; readonly reason: string | null }
  | { readonly state: "rejected"; readonly reason: string };

/**
 * Classifies the engine's answer to a submitted decision. A late approval after
 * cancellation is rejected with `run_canceled`; it is never shown as approval.
 */
export function approvalResolution(
  decision: ApprovalDecision,
  response: { readonly accepted: boolean; readonly reason?: string | null },
): ApprovalResolution {
  if (!response.accepted) {
    return {
      state: "rejected",
      reason: response.reason ?? "The engine rejected the approval.",
    };
  }
  return decision === "approve"
    ? { state: "approved" }
    : { state: "denied", reason: null };
}

/**
 * The request the dialog should show: the newest still-arrived request wins, so
 * a stale dialog never outranks a newer target. Terminal or invalidated requests
 * are shown as inert rather than silently disappearing.
 */
export function activeApproval(
  requests: readonly ApprovalRequestView[],
): ApprovalRequestView | null {
  let active: ApprovalRequestView | null = null;
  for (const candidate of requests) {
    if (!active || candidate.receivedSeq > active.receivedSeq)
      active = candidate;
  }
  return active;
}
