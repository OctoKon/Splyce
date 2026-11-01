import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ApprovalDialog from "./ApprovalDialog.svelte";
import {
  approvalEngineUnavailable,
  approvalExpired,
  approvalMatching,
  approvalRequest,
  approvalRunCanceled,
  approvalStaleRevision,
  approvalWrongTarget,
} from "../../tests/td30/fixtures";
import type { ApprovalContext } from "../stores/approvals";

let app: ReturnType<typeof mount> | null = null;
let opener: HTMLButtonElement | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  opener = null;
  document.body.innerHTML = "";
});

async function render(
  context: ApprovalContext,
  props: Record<string, unknown> = {},
): Promise<void> {
  opener = document.createElement("button");
  opener.textContent = "open approval";
  document.body.appendChild(opener);
  opener.focus();

  app = mount(ApprovalDialog, {
    target: document.body,
    props: { request: approvalRequest, context, ...props } as never,
  });
  flushSync();
  await tick();
  flushSync();
}

const byTestId = (id: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing ${id}`);
  return element;
};

const maybeTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const dialog = (): HTMLDialogElement =>
  document.querySelector<HTMLDialogElement>("dialog")!;

describe("TD-30 ApprovalDialog", () => {
  it("shows the exact target, opens focused on the non-destructive control", async () => {
    const onRespond = vi.fn();
    await render(approvalMatching, { onRespond });

    expect(dialog().open).toBe(true);
    expect(byTestId("approval-capability").textContent).toBe("fs.write");
    expect(byTestId("approval-normalized-target").textContent).toBe(
      "src/index.ts",
    );
    expect(byTestId("approval-risk").textContent).toContain("Writes a file");
    // Enter on the default control must not approve.
    expect(document.activeElement).toBe(byTestId("approval-deny"));
    expect((byTestId("approval-approve") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(maybeTestId("approval-inert")).toBeNull();
  });

  it("submits the store-built payload and claims no execution", async () => {
    const onRespond = vi.fn();
    await render(approvalMatching, { onRespond });

    (byTestId("approval-approve") as HTMLButtonElement).click();
    flushSync();
    await tick();
    flushSync();

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({
      approvalRequestId: "apr-1",
      runId: "run-1",
      actionId: "act-1",
      decision: "approve",
    });
    expect(byTestId("approval-submitted").textContent).toContain("act-1");
    expect(byTestId("approval-submitted").textContent).toContain(
      "until the engine reports the outcome",
    );
    expect(document.body.textContent).not.toContain("executed action");
  });

  it("submits a one-use decision only once when two activations land in the same tick", async () => {
    const onRespond = vi.fn();
    await render(approvalMatching, { onRespond });

    const approve = byTestId("approval-approve") as HTMLButtonElement;
    approve.click();
    approve.click();
    flushSync();
    await tick();
    flushSync();

    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(maybeTestId("approval-approve")).toBeNull();
    expect(maybeTestId("approval-deny")).toBeNull();
  });

  for (const [name, context, reason] of [
    ["a changed target/run", approvalWrongTarget, "different run"],
    ["a stale revision", approvalStaleRevision, "revision changed"],
    ["a lost engine", approvalEngineUnavailable, "Engine process exited."],
    ["an expired request", approvalExpired, "expired"],
  ] as const) {
    it(`keeps approval inert for ${name}`, async () => {
      const onRespond = vi.fn();
      await render(context, { onRespond });

      const approve = byTestId("approval-approve") as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      expect(byTestId("approval-approve-reason").textContent).toContain(reason);
      approve.click();
      flushSync();
      expect(onRespond).not.toHaveBeenCalled();
      expect(maybeTestId("approval-submitted")).toBeNull();

      // The inert prompt still explains itself and can be closed.
      expect(byTestId("approval-inert").textContent).toContain(reason);
      expect(byTestId("approval-dismiss").textContent?.trim()).toBe("Close");
    });
  }

  it("closes the prompt and returns focus when the run is canceled", async () => {
    const onRespond = vi.fn();
    const onDismiss = vi.fn();
    await render(approvalRunCanceled, { onRespond, onDismiss });

    // A dead prompt never opens, never asks, and never decides.
    expect(dialog().open).toBe(false);
    expect(onRespond).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    // Nothing in the closed prompt can still be activated as a decision.
    expect((byTestId("approval-approve") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("closes on Escape without approving, and returns focus to the opener", async () => {
    const onRespond = vi.fn();
    const onDismiss = vi.fn();
    await render(approvalMatching, { onRespond, onDismiss });

    dialog().dispatchEvent(new Event("cancel", { cancelable: true }));
    flushSync();
    await tick();
    flushSync();

    expect(onRespond).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBe(false);

    if (app) unmount(app);
    app = null;
    expect(document.activeElement).toBe(opener);
  });

  it("dismisses instead of denying when the request is inert", async () => {
    const onRespond = vi.fn();
    const onDismiss = vi.fn();
    await render(approvalWrongTarget, { onRespond, onDismiss });

    expect((byTestId("approval-deny") as HTMLButtonElement).disabled).toBe(
      true,
    );
    (byTestId("approval-dismiss") as HTMLButtonElement).click();
    flushSync();

    expect(onRespond).not.toHaveBeenCalled();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
