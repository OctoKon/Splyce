import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Setup from "./Setup.svelte";
import SetupLiveHarness from "../../tests/td29/SetupLiveHarness.svelte";
import {
  d1BaseSetup,
  d6Catalog,
  d6OperationSnapshot,
  d6Reviewing,
  d6ReviewingStale,
} from "../../tests/td29/fixtures";
import type { ModuleSnapshot } from "../stores/modules";

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = "";
});

async function render(props: Record<string, unknown>): Promise<void> {
  app = mount(Setup, {
    target: document.body,
    props: props as never,
  });
  flushSync();
  await tick();
  flushSync();
}

/**
 * Mounts the harness that can push the engine's next snapshot into the same
 * mounted Setup instance, so progression is proven reactive.
 */
async function renderLive(props: Record<string, unknown>): Promise<{
  pushSnapshot: (next: ModuleSnapshot) => void;
}> {
  const handle = mount(SetupLiveHarness, {
    target: document.body,
    props: props as never,
  });
  app = handle;
  flushSync();
  await tick();
  flushSync();
  return handle as unknown as {
    pushSnapshot: (next: ModuleSnapshot) => void;
  };
}

async function push(
  live: { pushSnapshot: (next: ModuleSnapshot) => void },
  next: ModuleSnapshot,
): Promise<void> {
  live.pushSnapshot(next);
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

const checkboxFor = (packageId: string): HTMLInputElement => {
  const element = document.querySelector<HTMLInputElement>(
    `[data-testid="module-option"][data-package-id="${packageId}"] input`,
  );
  if (!element) throw new Error(`missing module option ${packageId}`);
  return element;
};

async function selectAndReview(...packageIds: string[]): Promise<void> {
  for (const packageId of packageIds) checkboxFor(packageId).click();
  flushSync();
  byTestId("review-install").click();
  flushSync();
  await tick();
  flushSync();
}

/** The requestId the component minted for the most recent install submission. */
function submittedRequestId(
  onConfirmInstall: ReturnType<typeof vi.fn>,
): string {
  const call = onConfirmInstall.mock.calls.at(-1);
  if (!call) throw new Error("no install request was submitted");
  return (call[0] as { requestId: string }).requestId;
}

describe("TD-29 Setup.svelte", () => {
  it("D1: opens base-first, honest about generation, and never preselects", async () => {
    const onBaseOnly = vi.fn();
    const onEnterWorkbench = vi.fn();
    await render({ snapshot: d1BaseSetup, onBaseOnly, onEnterWorkbench });

    expect(byTestId("setup").dataset.step).toBe("start");
    // D1: the base path is the primary, focused default.
    expect(document.activeElement).toBe(byTestId("base-only"));
    expect(byTestId("generation").dataset.state).toBe("unconfigured");
    expect(byTestId("generation").textContent).toContain(
      "Generation unconfigured",
    );
    expect(byTestId("generation").textContent).toContain(
      "No generation model is selected.",
    );
    // Ambient configuration is evidence, not an implicit selection or install.
    expect(byTestId("ambient-notice").textContent).toContain("splyce-memory");
    expect(byTestId("ambient-notice").textContent).toContain("not permission");
    expect(maybeTestId("module-option")).toBeNull();
    expect(maybeTestId("confirm-install")).toBeNull();

    byTestId("base-only").click();
    flushSync();
    expect(onBaseOnly).toHaveBeenCalledTimes(1);
    expect(onEnterWorkbench).toHaveBeenCalledTimes(1);
    expect(byTestId("setup").dataset.step).toBe("workbench");
    expect(byTestId("workbench-generation").textContent).toContain(
      "Generation unconfigured",
    );
  });

  it("D6: requires an explicit selection and an unavailable catalog is not empty success", async () => {
    const onReview = vi.fn();
    await render({ snapshot: d6Catalog, initialStep: "selecting", onReview });

    expect(byTestId("selection-count").textContent).toContain(
      "Selected: 0 module(s)",
    );
    const review = byTestId("review-install") as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    expect(document.querySelector("#selection-reason")?.textContent).toContain(
      "at least one",
    );
    review.click();
    flushSync();
    expect(onReview).not.toHaveBeenCalled();

    // Ambient config reference (fixture-e) is never turned into a checkbox state.
    expect(checkboxFor("fixture-e").checked).toBe(false);

    // An unavailable catalog renders an alert, not an empty success list.
    if (app) unmount(app);
    app = null;
    document.body.innerHTML = "";
    await render({ snapshot: d1BaseSetup, initialStep: "selecting" });
    expect(byTestId("catalog-unavailable").textContent).toContain(
      "Catalog unavailable",
    );
    expect(byTestId("catalog-unavailable").textContent).toContain(
      "not an empty successful catalog",
    );
    expect((byTestId("refresh-catalog") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("D6: reviews the exact A/B -> D closure and excludes unselected E", async () => {
    const onReview = vi.fn();
    await render({ snapshot: d6Reviewing, initialStep: "selecting", onReview });

    await selectAndReview("fixture-a", "fixture-b");

    expect(onReview).toHaveBeenCalledWith(["fixture-a", "fixture-b"]);
    expect(byTestId("setup").dataset.step).toBe("reviewing");

    const roots = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="plan-root"]'),
    ].map((row) => row.dataset.packageId);
    const dependencies = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="plan-dependency"]',
      ),
    ].map((row) => row.dataset.packageId);
    expect(roots.sort()).toEqual(["fixture-a", "fixture-b"]);
    expect(dependencies).toEqual(["fixture-d"]);
    expect(document.body.textContent).not.toContain("Unselected fixture E");

    // Enabling after install and running the setup step are separate opt-ins.
    expect((byTestId("enable-after-install") as HTMLInputElement).checked).toBe(
      false,
    );
    expect((byTestId("execution-grant") as HTMLInputElement).checked).toBe(
      false,
    );
    const confirm = byTestId("confirm-install") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(byTestId("confirm-reason").textContent).toContain(
      "executable setup step",
    );
  });

  it("D6: confirms only with a current plan and the separate execution grant", async () => {
    const onConfirmInstall = vi.fn();
    await render({
      snapshot: d6Reviewing,
      initialStep: "selecting",
      onConfirmInstall,
    });
    await selectAndReview("fixture-a", "fixture-b");

    (byTestId("execution-grant") as HTMLInputElement).click();
    flushSync();

    const confirm = byTestId("confirm-install") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    confirm.click();
    flushSync();

    expect(onConfirmInstall).toHaveBeenCalledTimes(1);
    const request = onConfirmInstall.mock.calls[0]![0] as {
      requestId: string;
      planId: string;
      enableRequested: boolean;
      executionGranted: boolean;
    };
    expect(request).toMatchObject({
      planId: "plan-d6-current",
      enableRequested: false,
      executionGranted: true,
    });
    // The renderer mints the correlation identity, and the screen shows the
    // exact identity it sent so the engine can echo it.
    expect(request.requestId).toMatch(/^setup-request-/);
    expect(byTestId("awaiting-request-id").textContent?.trim()).toBe(
      request.requestId,
    );
  });

  it("D6: advances reviewing -> operating -> outcome only from authoritative operation updates", async () => {
    const onConfirmInstall = vi.fn();
    const live = await renderLive({
      initial: d6Reviewing,
      onConfirmInstall,
    });
    await selectAndReview("fixture-a", "fixture-b");
    (byTestId("execution-grant") as HTMLInputElement).click();
    flushSync();
    byTestId("confirm-install").click();
    flushSync();
    await tick();
    flushSync();

    // The click submits a request; it is not evidence of acceptance, so the
    // screen stays on the review until the engine reports an operation.
    expect(byTestId("setup").dataset.step).toBe("reviewing");
    expect(onConfirmInstall).toHaveBeenCalledTimes(1);
    expect(byTestId("awaiting-operation").textContent).toContain(
      "Waiting for the engine",
    );
    const requestId = submittedRequestId(onConfirmInstall);
    expect(byTestId("awaiting-request-id").textContent?.trim()).toBe(requestId);
    expect((byTestId("confirm-install") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(maybeTestId("setup-operation")).toBeNull();

    // Engine acceptance echoes the request identity and leaves reviewing.
    await push(
      live,
      d6OperationSnapshot({
        requestId,
        stage: "accepted",
        message: "Accepted the reviewed plan for staging.",
      }),
    );
    expect(byTestId("setup").dataset.step).toBe("operating");
    expect(byTestId("setup-operation").textContent).toContain("op-d6-install");
    expect(byTestId("operation-message").textContent).toContain(
      "Accepted the reviewed plan for staging.",
    );
    // Nothing is reported installed while the operation is staged.
    expect(byTestId("fact-installed").textContent).toContain(
      "No installed record",
    );

    // Progress is shown as reported, including an unknown total.
    await push(
      live,
      d6OperationSnapshot({
        requestId,
        stage: "progress",
        message: "Fetching the reviewed closure.",
        progress: { state: "unknown", transferredBytes: 4096 },
      }),
    );
    expect(byTestId("setup").dataset.step).toBe("operating");
    expect(byTestId("operation-progress").textContent).toContain(
      "Unknown total",
    );
    expect(byTestId("operation-progress").textContent).toContain("4096");

    // A terminal failure is an outcome, not a success and not a cancel.
    await push(
      live,
      d6OperationSnapshot({
        requestId,
        stage: "outcome",
        outcome: "failed",
        message: "Staging validation failed.",
        retryAllowed: true,
      }),
    );
    expect(byTestId("setup").dataset.step).toBe("outcome");
    expect(byTestId("operation-outcome").textContent).toContain("Failed");
    expect(byTestId("operation-outcome").dataset.tone).toBe("negative");
    expect(byTestId("fact-installed").textContent).toContain(
      "No installed record",
    );
    // Retry stays unavailable unless the engine exposed a safe reconciled action.
    expect((byTestId("retry-operation") as HTMLButtonElement).disabled).toBe(
      false,
    );

    // An uncertain outcome or pending cleanup leaves pending recovery.
    await push(
      live,
      d6OperationSnapshot({
        requestId,
        stage: "outcome",
        outcome: "uncertain",
        message: "Commit was lost; reconciliation required.",
        cleanupPending: true,
      }),
    );
    expect(byTestId("setup").dataset.step).toBe("recovering");
    expect(byTestId("setup-recovering").textContent).toContain(
      "No effect is replayed automatically",
    );
  });

  it("D6: engine loss during an operation leaves recovery, never success", async () => {
    const onConfirmInstall = vi.fn();
    const live = await renderLive({ initial: d6Reviewing, onConfirmInstall });
    await selectAndReview("fixture-a", "fixture-b");
    (byTestId("execution-grant") as HTMLInputElement).click();
    flushSync();
    byTestId("confirm-install").click();
    flushSync();
    const requestId = submittedRequestId(onConfirmInstall);

    await push(
      live,
      d6OperationSnapshot({
        requestId,
        stage: "started",
        message: "Staging started.",
      }),
    );
    expect(byTestId("setup").dataset.step).toBe("operating");

    await push(live, {
      ...d6OperationSnapshot({
        requestId,
        stage: "started",
        message: "Staging started.",
      }),
      engine: "unavailable",
      engineReason: "Engine process exited.",
    });
    expect(byTestId("setup").dataset.step).toBe("recovering");
    expect(byTestId("setup-recovering")).not.toBeNull();
    expect(maybeTestId("operation-outcome")).toBeNull();
    expect(maybeTestId("fact-installed")).not.toBeNull();
  });

  it("previous outcome cannot accept new request", async () => {
    const onConfirmInstall = vi.fn();
    await renderLive({
      initial: d6OperationSnapshot({
        operationId: "previous-install",
        stage: "outcome",
        outcome: "installed",
        message: "Previous install finished.",
      }),
      onConfirmInstall,
    });
    await selectAndReview("fixture-a", "fixture-b");
    (byTestId("execution-grant") as HTMLInputElement).click();
    flushSync();
    byTestId("confirm-install").click();
    flushSync();
    await tick();
    flushSync();
    expect(onConfirmInstall).toHaveBeenCalledTimes(1);
    expect(byTestId("setup").dataset.step).toBe("reviewing");
    expect(maybeTestId("operation-outcome")).toBeNull();
  });

  it("D6: correlation accepts only an operation echoing the submitted request identity", async () => {
    const onConfirmInstall = vi.fn();
    const live = await renderLive({
      initial: d6OperationSnapshot({
        operationId: "previous-install",
        requestId: "req-previous-install",
        stage: "outcome",
        outcome: "installed",
        message: "Previous install finished.",
      }),
      onConfirmInstall,
    });
    await selectAndReview("fixture-a", "fixture-b");
    (byTestId("execution-grant") as HTMLInputElement).click();
    flushSync();
    byTestId("confirm-install").click();
    flushSync();
    await tick();
    flushSync();
    const requestId = submittedRequestId(onConfirmInstall);

    // The old operation is still the only one the engine reported.
    expect(byTestId("setup").dataset.step).toBe("reviewing");
    expect(byTestId("awaiting-operation").textContent).toContain(
      "not evidence for this request",
    );

    // The engine echoing this request's identity, while the reviewed plan is
    // current, is this request's acceptance.
    await push(live, d6OperationSnapshot({ requestId, stage: "accepted" }));
    expect(byTestId("setup").dataset.step).toBe("operating");
    expect(byTestId("setup-operation").textContent).toContain("op-d6-install");
  });

  it("unrelated new operation cannot accept pending install", async () => {
    const onConfirmInstall = vi.fn();
    const live = await renderLive({ initial: d6Reviewing, onConfirmInstall });
    await selectAndReview("fixture-a", "fixture-b");
    (byTestId("execution-grant") as HTMLInputElement).click();
    flushSync();
    byTestId("confirm-install").click();
    flushSync();
    await tick();
    flushSync();
    expect(byTestId("setup").dataset.step).toBe("reviewing");
    await push(
      live,
      d6OperationSnapshot({
        operationId: "unrelated-uninstall",
        kind: "uninstall",
        packageId: "unrelated-module",
        stage: "outcome",
        outcome: "uninstalled",
        message: "A different module was removed.",
      }),
    );
    expect(onConfirmInstall).toHaveBeenCalledTimes(1);
    expect(byTestId("setup").dataset.step).toBe("reviewing");
    expect(maybeTestId("operation-outcome")).toBeNull();
  });

  it("same-kind unrelated operation cannot accept pending install", async () => {
    const onConfirmInstall = vi.fn();
    const live = await renderLive({ initial: d6Reviewing, onConfirmInstall });
    await selectAndReview("fixture-a", "fixture-b");
    (byTestId("execution-grant") as HTMLInputElement).click();
    flushSync();
    byTestId("confirm-install").click();
    flushSync();
    await tick();
    flushSync();

    // Same kind, same target, different request: operation ids and kinds are
    // not correlation, so this must not advance or display.
    await push(
      live,
      d6OperationSnapshot({
        operationId: "op-other-install",
        requestId: "req-someone-else",
        kind: "install",
        packageId: "fixture-a",
        stage: "accepted",
        message: "A different install request was accepted.",
      }),
    );
    expect(byTestId("setup").dataset.step).toBe("reviewing");
    expect(maybeTestId("setup-operation")).toBeNull();
    expect(maybeTestId("operation-outcome")).toBeNull();
  });

  it("an operation echoing the submitted request identity advances to operating and outcome", async () => {
    const onConfirmInstall = vi.fn();
    const live = await renderLive({ initial: d6Reviewing, onConfirmInstall });
    await selectAndReview("fixture-a", "fixture-b");
    (byTestId("execution-grant") as HTMLInputElement).click();
    flushSync();
    byTestId("confirm-install").click();
    flushSync();
    await tick();
    flushSync();
    const requestId = submittedRequestId(onConfirmInstall);

    await push(
      live,
      d6OperationSnapshot({
        requestId,
        stage: "accepted",
        message: "Accepted the reviewed plan.",
      }),
    );
    expect(byTestId("setup").dataset.step).toBe("operating");
    expect(byTestId("setup-operation").textContent).toContain("op-d6-install");

    await push(
      live,
      d6OperationSnapshot({
        requestId,
        stage: "outcome",
        outcome: "installed",
        message: "Installed the reviewed closure.",
      }),
    );
    expect(byTestId("setup").dataset.step).toBe("outcome");
    expect(byTestId("operation-outcome").textContent).toContain("Installed");
  });

  it("D6: keeps confirmation disabled for a stale plan", async () => {
    const onConfirmInstall = vi.fn();
    await render({
      snapshot: d6ReviewingStale,
      initialStep: "selecting",
      onConfirmInstall,
    });
    await selectAndReview("fixture-a", "fixture-b");

    expect(byTestId("plan-state").dataset.current).toBe("false");
    const confirm = byTestId("confirm-install") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    (byTestId("execution-grant") as HTMLInputElement).click();
    flushSync();
    expect(confirm.disabled).toBe(true);
    confirm.click();
    flushSync();
    expect(onConfirmInstall).not.toHaveBeenCalled();
  });

  it("D6: refuses a plan whose roots do not match the reviewed selection", async () => {
    const onConfirmInstall = vi.fn();
    await render({
      snapshot: d6Reviewing,
      initialStep: "selecting",
      onConfirmInstall,
    });

    await selectAndReview("fixture-a");
    (byTestId("execution-grant") as HTMLInputElement).click();
    flushSync();

    expect(byTestId("confirm-reason").textContent).toContain("does not match");
    const confirm = byTestId("confirm-install") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    confirm.click();
    flushSync();
    expect(onConfirmInstall).not.toHaveBeenCalled();
  });

  it("dismisses only the unsent review with Escape and restores its opener", async () => {
    const onConfirmInstall = vi.fn();
    await render({
      snapshot: d6Reviewing,
      initialStep: "selecting",
      onConfirmInstall,
    });
    await selectAndReview("fixture-a", "fixture-b");
    expect(document.activeElement?.id).toBe("review-title");

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    flushSync();
    await tick();
    flushSync();

    expect(byTestId("setup").dataset.step).toBe("selecting");
    expect(document.activeElement).toBe(byTestId("review-install"));
    expect(onConfirmInstall).not.toHaveBeenCalled();
  });

  it("keeps the base path usable while effects are disabled without an engine", async () => {
    const onRefreshCatalog = vi.fn();
    const onBaseOnly = vi.fn();
    await render({
      snapshot: {
        ...d1BaseSetup,
        engine: "unavailable",
        engineReason: "Engine process exited.",
      },
      initialStep: "selecting",
      onRefreshCatalog,
      onBaseOnly,
    });

    expect(byTestId("engine-unavailable").textContent).toContain(
      "Engine process exited.",
    );
    const refresh = byTestId("refresh-catalog") as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    refresh.click();
    flushSync();
    expect(onRefreshCatalog).not.toHaveBeenCalled();

    // The base is not an effect: it stays available with no engine.
    const baseOnly = document.querySelectorAll<HTMLButtonElement>("button");
    const continueBase = [...baseOnly].find((button) =>
      button.textContent?.includes("Continue with base only"),
    )!;
    expect(continueBase.disabled).toBe(false);
    continueBase.click();
    flushSync();
    expect(onBaseOnly).toHaveBeenCalledTimes(1);
    expect(byTestId("setup").dataset.step).toBe("workbench");
  });
});
