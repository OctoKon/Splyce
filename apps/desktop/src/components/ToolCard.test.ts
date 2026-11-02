import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import w4 from "../../../../tests/fixtures/gui/fui-w4-stream-backpressure.json";
import ToolCard from "./ToolCard.svelte";
import type { ToolCallView } from "../stores/turns";

type FixtureEvent = {
  kind: string;
  payload: Record<string, unknown>;
};

const events = (
  w4 as unknown as { eventSequence: { event: FixtureEvent }[] }
).eventSequence.map((entry) => entry.event);
const intent = events.find((event) => event.kind === "turn.tool_intent");
const outcome = events.find((event) => event.kind === "turn.tool_outcome");

function fixtureAction(over: Partial<ToolCallView> = {}): ToolCallView {
  if (!intent || !outcome) throw new Error("FUI-W4 tool events missing");
  return {
    actionId: String(intent.payload.actionId),
    capabilityId: String(intent.payload.capabilityId),
    target: String(intent.payload.target),
    argsSummary: String(intent.payload.argsSummary),
    status: outcome.payload.status as ToolCallView["status"],
    outcomeRef: String(outcome.payload.outcomeRef),
    ...over,
  };
}

function approval(state: "requested" | "denied" | "allowed" | "canceled") {
  return {
    approvalRequestId: "apr_1",
    runId: "run_1",
    actionId: "act_1",
    capabilityId: "fs.write",
    targetScope: "workspace",
    normalizedTarget: "src/app.ts",
    riskRationale: "Writes a workspace file.",
    state,
  };
}

let cmp: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = "";
});

function render(props: Record<string, unknown> = {}) {
  if (cmp) unmount(cmp);
  const onApproval = vi.fn();
  cmp = mount(ToolCard, {
    target: document.body,
    props: { action: fixtureAction(), onApproval, ...props },
  });
  flushSync();
  return onApproval;
}

const card = () => document.querySelector('[data-testid="tool-card"]');
const text = () => document.body.textContent ?? "";

describe("tool activity card", () => {
  it("renders the canonical FUI-W4 read intent and its outcome", () => {
    render();
    const node = card();
    expect(node?.getAttribute("data-capability")).toBe("cap_fs_read_tree");
    expect(node?.getAttribute("data-status")).toBe("success");
    expect(
      document.querySelector('[data-testid="tool-action"]')?.textContent,
    ).toBe("Read");
    expect(
      document.querySelector('[data-testid="tool-state"]')?.textContent,
    ).toBe("OK");
    expect(text()).toContain("target_desktop_src");
    expect(text()).toContain("depth: 2");
    expect(text()).toContain("ref_fs_tree_result");
  });

  it("shows a shell intent as running until an outcome arrives", () => {
    render({
      action: {
        actionId: "act_shell",
        capabilityId: "shell.run",
        target: "powershell:Get-ChildItem",
        argsSummary: "list the workspace root",
        status: "pending",
      },
    });
    expect(card()?.getAttribute("data-status")).toBe("running");
    expect(
      document.querySelector('[data-testid="tool-state"]')?.textContent,
    ).toBe("Running");
    expect(text()).toContain("Run shell");
    expect(text()).toContain("powershell:Get-ChildItem");
    expect(text()).toContain("Pending - not executed");
    expect(text()).not.toContain("Outcome:");
  });

  it("renders a policy denial as Denied with fixed copy, never the raw target", () => {
    render({
      action: {
        actionId: "act_write",
        capabilityId: "fs.write",
        target: "src/app.ts",
        argsSummary: "write src/app.ts",
        status: "error",
        error:
          "GRANT_REQUIRED: fs.write denied for C:\\Users\\bob\\.ssh\\id_rsa",
      },
    });
    expect(card()?.getAttribute("data-status")).toBe("denied");
    expect(
      document.querySelector('[data-testid="tool-state"]')?.textContent,
    ).toBe("Denied");
    expect(text()).toContain("one-time approval");
    expect(text()).not.toContain("C:\\Users");
    expect(text()).not.toContain(".ssh");
    expect(text()).not.toContain("id_rsa");
  });

  it("redacts secret-shaped argument values before they reach the DOM", () => {
    render({
      action: {
        actionId: "act_shell",
        capabilityId: "shell.run",
        target: "powershell:deploy.ps1",
        argsSummary: "deploy.ps1 --token=sk-live-secret123 password=hunter2",
        status: "pending",
      },
    });
    expect(text()).not.toContain("sk-live-secret123");
    expect(text()).not.toContain("hunter2");
    expect(text()).toContain("--token=[redacted]");
  });

  it("does not claim exit code or output that the event did not report", () => {
    render();
    expect(text()).not.toMatch(/exit code/i);
    expect(text()).not.toMatch(/truncated/i);
  });

  it("renders the optional outcome summary and redacts its preview", () => {
    render({
      action: {
        ...fixtureAction(),
        capabilityId: "shell.run",
        summary: {
          exitCode: 1,
          durationMs: 42,
          bytes: 64,
          truncated: true,
          preview: "first line\nsecond line\nsk-live-secret123",
        },
      },
    });
    expect(text()).toContain("Exit code 1");
    expect(text()).toContain("42 ms");
    expect(text()).toContain("64 bytes");
    expect(text()).toContain("Truncated");
    expect(text()).toContain("first line");
    expect(text()).toContain("second line");
    expect(text()).not.toContain("sk-live-secret123");
  });

  it("shows the exact target and redacted args in the approval prompt and allows once from the keyboard", () => {
    const onApproval = render({
      action: {
        actionId: "act_1",
        capabilityId: "shell.run",
        target: "scripts/deploy.ps1",
        argsSummary:
          "./scripts/deploy.ps1 --environment staging --token=sk-live-secret123",
        status: "pending",
        approval: {
          ...approval("requested"),
          actionId: "act_1",
          capabilityId: "cap_shell_execute",
          normalizedTarget: "target_deploy_sh",
        },
      },
      canRespond: () => true,
    });

    const prompt = document.querySelector('[data-testid="approval-card"]');
    expect(prompt?.textContent).toContain("scripts/deploy.ps1");
    expect(prompt?.textContent).toContain("target_deploy_sh");
    expect(prompt?.textContent).toContain(
      "./scripts/deploy.ps1 --environment staging",
    );
    expect(prompt?.textContent).toContain("--token=[redacted]");
    expect(prompt?.textContent).not.toContain("sk-live-secret123");

    const allow = document.querySelector<HTMLButtonElement>(
      '[data-testid="approval-allow-button"]',
    );
    const deny = document.querySelector<HTMLButtonElement>(
      '[data-testid="approval-deny-button"]',
    );
    expect(allow?.textContent?.trim()).toBe("Allow once");
    expect(allow?.getAttribute("aria-keyshortcuts")).toBe("y");
    expect(deny?.getAttribute("aria-keyshortcuts")).toBe("n Escape");
    expect(prompt?.textContent).toContain("Y allow once");
    expect(prompt?.textContent).toContain("N or Esc deny");
    expect(document.activeElement).toBe(deny);

    deny?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "y",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(onApproval).toHaveBeenCalledWith(
      "apr_1",
      "run_1",
      "act_1",
      "approve",
    );
  });

  it("offers Allow once for a write approval and shows its requested arguments", () => {
    const onApproval = render({
      action: {
        actionId: "act_write",
        capabilityId: "fs.write",
        target: "src/app.ts",
        argsSummary: "write src/app.ts",
        status: "pending",
        approval: {
          ...approval("requested"),
          actionId: "act_write",
          normalizedTarget: "src/app.ts",
        },
      },
      canRespond: () => true,
    });

    const prompt = document.querySelector('[data-testid="approval-card"]');
    expect(prompt?.textContent).toContain("Write");
    expect(prompt?.textContent).toContain("src/app.ts");
    expect(prompt?.textContent).toContain("write src/app.ts");

    const allow = document.querySelector<HTMLButtonElement>(
      '[data-testid="approval-allow-button"]',
    );
    expect(allow?.textContent?.trim()).toBe("Allow once");
    allow?.click();
    expect(onApproval).toHaveBeenCalledWith(
      "apr_1",
      "run_1",
      "act_write",
      "approve",
    );
  });

  it("keeps approval controls fail-closed unless the caller opts in", () => {
    render({
      action: {
        ...fixtureAction(),
        status: "pending",
        approval: approval("requested"),
      },
    });
    expect(
      document.querySelector('[data-testid="approval-allow-button"]'),
    ).toBeNull();
    expect(text()).toContain("Approval controls are not available");

    render({
      action: {
        ...fixtureAction(),
        status: "pending",
        approval: approval("requested"),
      },
      canRespond: () => true,
    });
    expect(
      document.querySelector('[data-testid="approval-allow-button"]'),
    ).not.toBeNull();
  });
});
