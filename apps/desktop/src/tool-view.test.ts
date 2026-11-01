import { describe, expect, it } from "vitest";
import type { ToolCallView } from "./stores/turns";
import {
  redactToolText,
  toolActionLabel,
  toolErrorCopy,
  toolState,
} from "./tool-view";

function action(over: Partial<ToolCallView> = {}): ToolCallView {
  return {
    actionId: "act_1",
    capabilityId: "fs.read",
    target: "src/app.ts",
    argsSummary: "",
    status: "pending",
    ...over,
  };
}

describe("tool activity view", () => {
  it("names the known workspace actions without inventing a capability", () => {
    expect(toolActionLabel("fs.read")).toBe("Read");
    expect(toolActionLabel("cap_fs_read_tree")).toBe("Read");
    expect(toolActionLabel("fs.write")).toBe("Write");
    expect(toolActionLabel("files.write")).toBe("Write");
    expect(toolActionLabel("fs.edit")).toBe("Edit");
    expect(toolActionLabel("shell.run")).toBe("Run shell");
    expect(toolActionLabel("shell.execute")).toBe("Run shell");
    expect(toolActionLabel("module.unknown")).toBe("Tool action");
    expect(toolActionLabel("")).toBe("Tool action");
  });

  it("reports running from intent, not a fabricated completed state", () => {
    expect(toolState(action()).label).toBe("Running");
    expect(toolState(action()).status).toBe("running");
    expect(toolState(action({ status: "success" })).label).toBe("OK");
    expect(toolState(action({ status: "uncertain" })).label).toBe("Uncertain");
    expect(toolState(action({ status: "canceled" })).label).toBe("Canceled");
  });

  it("keeps requested approval distinct from running", () => {
    const waiting = toolState(
      action({
        approval: {
          approvalRequestId: "apr_1",
          runId: "run_1",
          actionId: "act_1",
          capabilityId: "fs.write",
          targetScope: "workspace",
          normalizedTarget: "src/app.ts",
          riskRationale: "Writes a workspace file.",
          state: "requested",
        },
      }),
    );
    expect(waiting.label).toBe("Waiting for approval");
    expect(waiting.status).toBe("waiting-approval");
  });

  it("shows denied when policy rejected the action, not a generic failure", () => {
    for (const code of [
      "GRANT_REQUIRED",
      "GRANT_CONSUMED",
      "GRANT_REVOKED",
      "WORKSPACE_ESCAPE",
    ]) {
      const state = toolState(
        action({ capabilityId: "shell.run", status: "error", error: code }),
      );
      expect(state.label).toBe("Denied");
      expect(state.status).toBe("denied");
    }
    expect(
      toolState(
        action({ status: "error", error: "SHELL_TIMEOUT: command killed" }),
      ).status,
    ).toBe("error");
  });

  it("keeps an explicit denied approval denied even after cancellation", () => {
    const state = toolState(
      action({
        status: "canceled",
        approval: {
          approvalRequestId: "apr_1",
          runId: "run_1",
          actionId: "act_1",
          capabilityId: "fs.write",
          targetScope: "workspace",
          normalizedTarget: "src/app.ts",
          riskRationale: "Writes a workspace file.",
          state: "denied",
        },
      }),
    );
    expect(state.label).toBe("Denied");
    expect(state.status).toBe("denied");
  });

  it("turns engine error codes into fixed copy and never echoes the message", () => {
    const denied = toolErrorCopy(
      "GRANT_REQUIRED: fs.write denied for C:\\Users\\bob\\.ssh\\id_rsa",
    );
    expect(denied.code).toBe("GRANT_REQUIRED");
    expect(denied.copy).toContain("one-time approval");
    expect(denied.copy).not.toContain("C:\\Users");
    expect(denied.copy).not.toContain(".ssh");

    const unknown = toolErrorCopy("SOMETHING_NEW: token=sk-live-secret123");
    expect(unknown.code).toBe("SOMETHING_NEW");
    expect(unknown.copy).not.toContain("sk-live-secret123");
    expect(unknown.copy).not.toContain("SOMETHING_NEW");

    const noCode = toolErrorCopy("ENOENT C:\\private\\id_rsa");
    expect(noCode.code).toBeNull();
    expect(noCode.copy).not.toContain("C:\\private");
  });

  it("redacts common secret shapes from summaries before display", () => {
    const text = [
      "token=abc123",
      'password="hunter2"',
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload",
      "sk-live-secret123",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "xoxb-1234567890-abcdef",
      "AKIAABCDEFGHIJKLMNOP",
      "src/app.ts --verbose",
    ].join(" ");
    const safe = redactToolText(text);
    expect(safe).not.toContain("abc123");
    expect(safe).not.toContain("hunter2");
    expect(safe).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(safe).not.toContain("sk-live-secret123");
    expect(safe).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(safe).not.toContain("xoxb-1234567890-abcdef");
    expect(safe).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(safe).toContain("src/app.ts");
    expect(safe).toContain("--verbose");
  });
});
