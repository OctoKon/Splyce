import { describe, expect, it } from "vitest";
import {
  projectStatus,
  projectToolStatus,
  projectTurnStatus,
  type StatusRecordKind,
} from "./status-view";

function outcome(
  effectState: "observed-success" | "observed-failure" | "uncertain",
  cleanupState:
    "pending" | "complete" | "failed" | "not-required" | "uncertain",
  errorClass:
    | "none"
    | "policy-denied"
    | "validation"
    | "execution"
    | "canceled"
    | "timeout"
    | "unknown",
) {
  return { effectState, cleanupState, errorClass };
}

describe("projectStatus", () => {
  it("maps run states to fixed labels without exposing the record", () => {
    expect(projectStatus("run", { state: "pending" })).toEqual({
      label: "Pending",
      tone: "neutral",
      status: "pending",
    });
    expect(projectStatus("run", { state: "running" }).status).toBe("running");
    expect(projectStatus("run", { state: "completed" }).status).toBe(
      "completed",
    );
    expect(projectStatus("run", { state: "failed" }).status).toBe("failed");
    expect(projectStatus("run", { state: "canceled" }).status).toBe("canceled");
    expect(projectStatus("run", { state: "uncertain" }).status).toBe(
      "uncertain",
    );
  });

  it("maps action, selection, configuration and installation states", () => {
    expect(projectStatus("action", { state: "proposed" }).status).toBe(
      "proposed",
    );
    expect(projectStatus("action", { state: "approved" }).status).toBe(
      "approved",
    );
    expect(projectStatus("action", { state: "denied" }).status).toBe("denied");
    expect(projectStatus("action", { state: "running" }).status).toBe(
      "running",
    );
    expect(
      projectStatus("selectionTransition", { state: "ready" }).status,
    ).toBe("ready");
    expect(
      projectStatus("configurationTransition", { state: "applied" }).status,
    ).toBe("applied");
    expect(
      projectStatus("configurationTransition", { state: "draining" }).status,
    ).toBe("draining");
    expect(
      projectStatus("packageInstallation", { state: "installed" }).status,
    ).toBe("installed");
    expect(
      projectStatus("packageInstallation", { state: "removed" }).status,
    ).toBe("removed");
  });

  it("maps every persisted state without falling back to Unknown", () => {
    const cases: Array<
      [Exclude<StatusRecordKind, "outcome">, readonly string[]]
    > = [
      [
        "run",
        ["pending", "running", "completed", "failed", "canceled", "uncertain"],
      ],
      [
        "action",
        [
          "proposed",
          "pending",
          "approved",
          "denied",
          "running",
          "completed",
          "failed",
          "canceled",
          "uncertain",
        ],
      ],
      ["selectionTransition", ["pending", "ready", "failed", "canceled"]],
      ["configurationTransition", ["pending", "applied", "draining", "failed"]],
      [
        "packageInstallation",
        ["staging", "installed", "failed", "removing", "removed"],
      ],
    ];

    for (const [kind, states] of cases) {
      for (const state of states) {
        const projected = projectStatus(kind, { state } as never);
        expect(projected.status, `${kind}.${state}`).toBe(state);
        expect(projected.label, `${kind}.${state}`).not.toBe("Unknown");
      }
    }
  });

  it("maps turn and tool view statuses used by the transcript", () => {
    expect(projectTurnStatus("streaming")).toEqual({
      label: "Working",
      tone: "active",
      status: "streaming",
    });
    expect(projectTurnStatus("waiting_approval").status).toBe(
      "waiting-approval",
    );
    expect(projectTurnStatus("completed").status).toBe("completed");
    expect(projectTurnStatus("failed").status).toBe("failed");
    expect(projectTurnStatus("canceled").status).toBe("canceled");
    expect(projectTurnStatus("stopped").status).toBe("stopped");
    expect(projectToolStatus("pending")).toEqual({
      label: "Pending - not executed",
      tone: "neutral",
      status: "pending",
    });
    expect(projectToolStatus("success").status).toBe("success");
    expect(projectToolStatus("error")).toEqual({
      label: "Failed",
      tone: "negative",
      status: "failed",
    });
    expect(projectToolStatus("uncertain").status).toBe("uncertain");
    expect(projectToolStatus("canceled").status).toBe("canceled");
    expect(projectTurnStatus(null).status).toBe("unknown");
    expect(projectToolStatus("bogus" as never).status).toBe("unknown");
  });

  it("keeps pending, failed and uncertain distinct", () => {
    const pending = projectStatus("run", { state: "pending" });
    const failed = projectStatus("run", { state: "failed" });
    const uncertain = projectStatus("run", { state: "uncertain" });
    expect(
      new Set([pending.status, failed.status, uncertain.status]).size,
    ).toBe(3);
    expect(new Set([pending.tone, failed.tone, uncertain.tone]).size).toBe(3);
  });

  it("maps outcome effect, cleanup and error class safely", () => {
    expect(
      projectStatus("outcome", outcome("observed-success", "complete", "none"))
        .status,
    ).toBe("completed");
    expect(
      projectStatus(
        "outcome",
        outcome("observed-success", "not-required", "none"),
      ).status,
    ).toBe("completed");
    expect(
      projectStatus("outcome", outcome("observed-success", "pending", "none"))
        .status,
    ).toBe("cleanup-pending");
    expect(
      projectStatus("outcome", outcome("observed-failure", "complete", "none"))
        .status,
    ).toBe("failed");
    expect(
      projectStatus("outcome", outcome("observed-success", "failed", "none"))
        .status,
    ).toBe("failed");
    expect(
      projectStatus(
        "outcome",
        outcome("observed-success", "complete", "timeout"),
      ).status,
    ).toBe("timed-out");
    expect(
      projectStatus(
        "outcome",
        outcome("observed-failure", "complete", "policy-denied"),
      ).status,
    ).toBe("denied");
    expect(
      projectStatus("outcome", outcome("uncertain", "uncertain", "none"))
        .status,
    ).toBe("uncertain");
  });

  it("returns Unknown for missing or unrecognized input", () => {
    expect(projectStatus("run", null)).toEqual({
      label: "Unknown",
      tone: "unknown",
      status: "unknown",
    });
    expect(projectStatus("action", undefined).status).toBe("unknown");
    expect(
      projectStatus("run", { state: "not-a-state" } as unknown as {
        state: "pending";
      }).status,
    ).toBe("unknown");
    expect(projectStatus("outcome", null).status).toBe("unknown");
    expect(
      projectStatus("outcome", {
        effectState: "observed-success",
      } as never).status,
    ).toBe("unknown");
  });

  it("safely handles prototype property names without collision", () => {
    for (const key of ["constructor", "__proto__", "toString", "valueOf"]) {
      expect(projectStatus("run", { state: key } as never).status).toBe(
        "unknown",
      );
      expect(projectStatus("run", { state: key } as never).label).toBe(
        "Unknown",
      );
      expect(projectTurnStatus(key as never).status).toBe("unknown");
      expect(projectToolStatus(key as never).status).toBe("unknown");
    }
  });

  it("does not mutate the input or copy metadata, paths or error text", () => {
    const record = Object.freeze({
      state: "failed",
      recordId: "rec_1",
      scopeId: "scope_1",
      sourceIds: ["src_1"],
      error: "token=secret",
      normalizedTarget: "C:\\private\\file.txt",
    });
    const before = JSON.stringify(record);
    const projected = projectStatus("run", record);
    expect(JSON.stringify(record)).toBe(before);
    expect(Object.keys(projected).sort()).toEqual(["label", "status", "tone"]);
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("private");
  });
});
