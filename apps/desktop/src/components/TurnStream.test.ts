import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import TurnStream from "./TurnStream.svelte";
import type { TurnView } from "../stores/turns";

const approvalAction = {
  actionId: "act_w5_exec",
  capabilityId: "files.write",
  target: "src/app.ts",
  argsSummary: "write src/app.ts",
  status: "pending" as const,
  approval: {
    approvalRequestId: "apr_1",
    runId: "run_1",
    actionId: "act_w5_exec",
    capabilityId: "files.write",
    targetScope: "workspace",
    normalizedTarget: "src/app.ts",
    riskRationale: "Writes a file in the workspace.",
    state: "requested" as const,
  },
};

const run: TurnView = {
  runId: "run_1",
  status: "waiting_approval",
  text: "",
  thought: "",
  actions: [approvalAction],
  blocks: [{ type: "tool", id: "block_1", actionId: "act_w5_exec" }],
};

let cmp: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = "";
});

function render(props: Record<string, unknown>) {
  const onApproval = vi.fn();
  cmp = mount(TurnStream, {
    target: document.body,
    props: { run, onApproval, ...props },
  });
  flushSync();
  return onApproval;
}

const approveButton = () =>
  document.querySelector('[data-testid="approval-allow-button"]');
const closedNotice = () =>
  [...document.querySelectorAll('[role="status"]')].find((node) =>
    node.textContent?.includes("Approval controls are not available"),
  );

describe("TurnStream approval controls", () => {
  it("keeps approvals closed when no canRespond predicate is supplied", () => {
    const onApproval = render({});

    expect(approveButton()).toBeNull();
    expect(closedNotice()).not.toBeUndefined();

    (
      document.querySelector(
        '[data-testid="approval-deny-button"]',
      ) as HTMLButtonElement | null
    )?.click();
    expect(onApproval).not.toHaveBeenCalled();
  });

  it("renders the approval card when the caller explicitly allows a response", () => {
    render({ canRespond: () => true });

    expect(approveButton()).not.toBeNull();
    expect(closedNotice()).toBeUndefined();
  });
});
