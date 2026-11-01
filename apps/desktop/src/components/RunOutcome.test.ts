import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { SplyceErrorPayload } from "@splyce/pi/contracts";
import RunOutcome from "./RunOutcome.svelte";
import { usageRows } from "./usage/usage";

const mounted: object[] = [];
function render(props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(RunOutcome, { target, props: props as never }));
  flushSync();
  return target;
}
afterEach(() => {
  mounted.splice(0).forEach((c) => unmount(c));
  document.body.innerHTML = "";
});

const ok = {
  effectState: "observed-success",
  cleanupState: "not-required",
  errorClass: "none",
} as const;
const failed = {
  effectState: "observed-failure",
  cleanupState: "complete",
  errorClass: "execution",
} as const;
const leaky: SplyceErrorPayload = {
  code: "ENGINE_CRASH",
  message:
    "ENOENT C:\\Users\\bob\\.ssh\\id_rsa at Object.<anonymous> (file.js:1:1) sk-secret123",
  correlationId: "corr-42",
  retryable: true,
  suggestedAction: "RETRY_SAFE",
};

describe("TD-36 RunOutcome", () => {
  it("uncertain effect never renders as success", () => {
    const t = render({
      outcome: {
        effectState: "uncertain",
        cleanupState: "complete",
        errorClass: "none",
      },
    });
    expect(
      t.querySelector("[data-testid=run-outcome]")!.getAttribute("data-status"),
    ).toBe("uncertain");
    expect(t.textContent).toContain("Uncertain");
    expect(t.textContent).not.toMatch(/Completed|Success/);
  });

  it("error beside a success outcome is shown uncertain, not completed", () => {
    const t = render({ outcome: ok, error: leaky });
    expect(
      t.querySelector("[data-testid=run-outcome]")!.getAttribute("data-status"),
    ).toBe("uncertain");
  });

  it("cleanup pending is visible and not plain completed", () => {
    const t = render({
      outcome: {
        effectState: "observed-success",
        cleanupState: "pending",
        errorClass: "none",
      },
    });
    expect(
      t.querySelector("[data-testid=run-outcome-label]")!.textContent,
    ).toBe("Cleanup pending");
    expect(t.textContent).toContain("cleanup is still pending");
  });

  it("completed shows a text label, not colour alone", () => {
    const t = render({ outcome: ok });
    expect(
      t.querySelector("[data-testid=run-outcome-label]")!.textContent,
    ).toBe("Completed");
  });

  it("error copy never contains path, secret or stack text", () => {
    const t = render({ outcome: failed, error: leaky });
    const text = t.textContent!;
    expect(text).toContain("engine stopped unexpectedly");
    expect(text).not.toMatch(
      /ENOENT|C:\\|\.ssh|sk-secret|Object\.<anonymous>|file\.js/,
    );
    expect(text).toContain("corr-42");
  });

  it("details expand via a native keyboard-operable disclosure", () => {
    const t = render({ outcome: failed, error: leaky });
    expect(t.querySelector("details > summary")!.textContent).toBe("Details");
  });

  it("retry only when safe, never for uncertain", () => {
    const onRetry = vi.fn();
    let t = render({ outcome: failed, error: leaky, onRetry });
    (
      t.querySelector("[data-testid=run-outcome-retry]") as HTMLButtonElement
    ).click();
    expect(onRetry).toHaveBeenCalledOnce();
    t = render({
      outcome: {
        effectState: "uncertain",
        cleanupState: "complete",
        errorClass: "none",
      },
      error: leaky,
      onRetry,
    });
    expect(t.querySelector("[data-testid=run-outcome-retry]")).toBeNull();
    t = render({
      outcome: failed,
      error: { ...leaky, retryable: false },
      onRetry,
    });
    expect(t.querySelector("[data-testid=run-outcome-retry]")).toBeNull();
  });

  it("missing usage is stated, not silent; unavailable is not zero", () => {
    // A blank region reads as zero, so an absent report says so.
    const missing = render({ outcome: ok });
    const notReported = missing.querySelector(
      "[data-testid=usage-not-reported]",
    );
    expect(notReported).not.toBeNull();
    expect(notReported?.textContent).toContain("not reported");
    const t = render({
      outcome: ok,
      usage: { semantics: "unavailable", inputTokens: 0, costUsd: 0 },
    });
    expect(t.querySelector("[data-testid=usage-unavailable]")).not.toBeNull();
    expect(t.textContent).not.toMatch(/\$0|\b0\b/);
  });

  it("reported usage shows only present numbers", () => {
    const t = render({
      outcome: ok,
      usage: { semantics: "estimated", inputTokens: 1200 },
    });
    expect(t.textContent).toContain("Estimated usage");
    expect(t.textContent).toContain("1,200");
    expect(t.textContent).not.toContain("Output tokens");
    expect(t.textContent).not.toContain("Cost");
    expect(
      usageRows({
        semantics: "reported",
        inputTokens: Number.NaN,
        costUsd: -1,
      }),
    ).toEqual([]);
  });
});
