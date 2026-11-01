import { describe, expect, it } from "vitest";
import {
  acknowledgeMode,
  bindPermissionSession,
  confirmPermissionMode,
  confirmedPermissionModeRequest,
  initialPermissionMode,
  modeConfirmation,
  permissionModeView,
  rejectMode,
  requestPermissionMode,
  type PermissionModeContext,
  type PermissionModeState,
} from "./permission-mode";

const context = (
  overrides: Partial<PermissionModeContext> = {},
): PermissionModeContext => ({
  engine: "ready",
  engineReason: null,
  configRevision: "cfg-1",
  policyRevision: "pol-1",
  ...overrides,
});

const bound = (sessionId = "ses-1"): PermissionModeState =>
  initialPermissionMode(sessionId);

describe("U1_permission_mode", () => {
  it("starts manual, shows a request as pending, and changes only on acknowledgement", () => {
    const state = bound();
    expect(permissionModeView(state).effectiveLabel).toBe("Manual");

    const request = requestPermissionMode(state, "accept-edits", context());
    expect(request.kind).toBe("requested");
    if (request.kind !== "requested") throw new Error("expected request");

    const pending = permissionModeView(request.state);
    // Requested and effective stay distinct until the engine answers.
    expect(pending.effectiveLabel).toBe("Manual");
    expect(pending.pendingLabel).toBe("Accept edits (pending engine)");
    expect(pending.announcement).toBeNull();

    const acknowledged = acknowledgeMode(request.state, "accept-edits");
    const view = permissionModeView(acknowledged);
    expect(view.effectiveLabel).toBe("Accept edits");
    expect(view.pendingLabel).toBeNull();
    expect(view.announcement).toBe("Permission mode is now Accept edits.");
    // The live region text is stable, so re-rendering does not re-announce.
    expect(permissionModeView(acknowledged).announcement).toBe(
      view.announcement,
    );
  });

  it("keeps the prior mode when the engine rejects the change", () => {
    const request = requestPermissionMode(bound(), "auto", context());
    if (request.kind !== "requested") throw new Error("expected request");

    const rejected = rejectMode(request.state, "Policy forbids auto mode.");
    const view = permissionModeView(rejected);
    expect(view.effectiveLabel).toBe("Manual");
    expect(view.rejectedReason).toBe("Policy forbids auto mode.");
    expect(view.pendingLabel).toBeNull();
    // A late acknowledgement cannot revive a rejected request.
    expect(acknowledgeMode(rejected, "auto").effective).toBe("manual");
  });

  it("requires a separate confirmation for bypass-class modes", () => {
    const confirm = requestPermissionMode(bound(), "bypass", context());
    expect(confirm.kind).toBe("confirm");
    if (confirm.kind !== "confirm") throw new Error("expected confirm");
    expect(confirm.reason).toContain("safe choice keeps the current mode");
    // Nothing is pending before that confirmation.
    expect(bound().status).toBe("idle");
    expect(
      permissionModeView(bound()).options.find((o) => o.mode === "bypass"),
    ).toMatchObject({ dangerous: true, selected: false, pending: false });
  });

  it("submits a confirmed bypass request but still honours the engine guards", () => {
    const confirmed = confirmedPermissionModeRequest(
      bound(),
      "bypass",
      context(),
    );
    expect(confirmed.kind).toBe("requested");
    if (confirmed.kind !== "requested") throw new Error("expected request");
    // Still not effective: the engine has not acknowledged it.
    const pending = permissionModeView(confirmed.state);
    expect(pending.effectiveLabel).toBe("Manual");
    expect(pending.pendingLabel).toBe("Bypass (unsafe) (pending engine)");

    // The confirmation gate is skipped, the engine/revision gates are not.
    expect(
      confirmedPermissionModeRequest(
        bound(),
        "bypass",
        context({
          engine: "unavailable",
          engineReason: "Engine process exited.",
        }),
      ).kind,
    ).toBe("blocked");
    expect(
      confirmedPermissionModeRequest(
        bound(),
        "bypass",
        context({ configRevision: null }),
      ).kind,
    ).toBe("blocked");
    expect(
      confirmedPermissionModeRequest(bound(), "manual", context()).kind,
    ).toBe("blocked");
  });

  it("blocks requests while the engine is unavailable or revisions are missing", () => {
    const offline = requestPermissionMode(
      bound(),
      "auto",
      context({
        engine: "unavailable",
        engineReason: "Engine process exited.",
      }),
    );
    expect(offline.kind).toBe("blocked");
    expect(offline.kind === "blocked" && offline.reason).toContain(
      "Engine process exited.",
    );

    expect(
      requestPermissionMode(bound(), "auto", context({ policyRevision: null }))
        .kind,
    ).toBe("blocked");
  });

  it("refuses a duplicate pending request for the same mode", () => {
    const request = requestPermissionMode(bound(), "plan", context());
    if (request.kind !== "requested") throw new Error("expected request");
    const duplicate = requestPermissionMode(request.state, "plan", context());
    expect(duplicate.kind).toBe("blocked");
    expect(duplicate.kind === "blocked" && duplicate.reason).toContain(
      "already awaiting",
    );
  });

  it("ignores an acknowledgement for a mode that was never requested", () => {
    const request = requestPermissionMode(bound(), "auto", context());
    if (request.kind !== "requested") throw new Error("expected request");

    // A stale or mismatched engine answer must not change the effective mode.
    const stale = acknowledgeMode(request.state, "bypass");
    expect(stale).toBe(request.state);
    expect(stale.effective).toBe("manual");
    expect(stale.requested).toBe("auto");
    expect(permissionModeView(stale).announcement).toBeNull();
  });

  it("discards pending state and resets to manual in another session", () => {
    const request = requestPermissionMode(bound("ses-1"), "auto", context());
    if (request.kind !== "requested") throw new Error("expected request");

    const moved = bindPermissionSession(request.state, "ses-2");
    expect(moved.sessionId).toBe("ses-2");
    expect(moved.effective).toBe("manual");
    expect(moved.requested).toBeNull();
    expect(moved.status).toBe("idle");

    // Same session is a no-op, so an in-flight request survives a re-render.
    expect(bindPermissionSession(request.state, "ses-1")).toBe(request.state);
  });

  it("binds a bypass confirmation to the session and revisions it was opened under", () => {
    const state = bound("ses-1");
    const confirmation = modeConfirmation(state, "bypass", context());
    expect(confirmation).not.toBeNull();
    if (!confirmation) throw new Error("expected confirmation");
    expect(modeConfirmation(state, "auto", context())).toBeNull();

    // Unchanged identity is admitted, but still only as a request.
    const accepted = confirmPermissionMode(state, confirmation, context());
    expect(accepted.kind).toBe("requested");
    if (accepted.kind !== "requested") throw new Error("expected request");
    expect(accepted.state.effective).toBe("manual");
    expect(accepted.state.requested).toBe("bypass");
  });

  it("refuses a confirmation after the session changes", () => {
    const confirmation = modeConfirmation(bound("ses-1"), "bypass", context());
    if (!confirmation) throw new Error("expected confirmation");

    const result = confirmPermissionMode(
      bound("ses-2"),
      confirmation,
      context(),
    );
    expect(result.kind).toBe("invalidated");
    if (result.kind !== "invalidated") throw new Error("expected refusal");
    expect(result.reason).toContain("session changed");
  });

  it("refuses a confirmation after the configuration or policy revision changes", () => {
    const confirmation = modeConfirmation(bound("ses-1"), "bypass", context());
    if (!confirmation) throw new Error("expected confirmation");

    expect(
      confirmPermissionMode(
        bound("ses-1"),
        confirmation,
        context({ configRevision: "cfg-2" }),
      ),
    ).toMatchObject({ kind: "invalidated" });
    expect(
      confirmPermissionMode(
        bound("ses-1"),
        confirmation,
        context({ policyRevision: "pol-2" }),
      ),
    ).toMatchObject({ kind: "invalidated" });
    // Revisions going away is also a change, never "still fine".
    expect(
      confirmPermissionMode(
        bound("ses-1"),
        confirmation,
        context({ policyRevision: null }),
      ),
    ).toMatchObject({ kind: "invalidated" });
  });

  it("refuses a confirmation after the engine goes away", () => {
    const confirmation = modeConfirmation(bound("ses-1"), "bypass", context());
    if (!confirmation) throw new Error("expected confirmation");

    const result = confirmPermissionMode(
      bound("ses-1"),
      confirmation,
      context({
        engine: "unavailable",
        engineReason: "Engine process exited.",
      }),
    );
    expect(result).toEqual({
      kind: "invalidated",
      reason: "Engine process exited.",
    });
  });
});
