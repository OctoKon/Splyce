// TD-76: every usage state is stated. A blank region reads as zero, so the
// component must never render nothing just because no report arrived.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import UsageView from "./UsageView.svelte";

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = "";
});

function render(props: Record<string, unknown>): HTMLElement {
  if (app) {
    unmount(app);
    app = null;
    document.body.innerHTML = "";
  }
  app = mount(UsageView, { target: document.body, props } as never);
  flushSync();
  if (!document.body.firstElementChild) throw new Error("nothing rendered");
  return document.body;
}

const byTestId = (root: HTMLElement, id: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("TD-76 UsageView states", () => {
  it("says it is loading instead of rendering an empty region", () => {
    const root = render({ usage: null, status: "loading" });

    expect(byTestId(root, "usage-loading")?.textContent).toContain(
      "Loading usage",
    );
    expect(byTestId(root, "usage-view")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    // Loading is not a claim that the run used nothing.
    expect(byTestId(root, "usage-unavailable")).toBeNull();
    expect(byTestId(root, "usage-not-reported")).toBeNull();
  });

  it("reports a failed feed as an alert, not as unavailable or zero", () => {
    const root = render({ usage: null, status: "error" });

    const error = byTestId(root, "usage-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("could not be loaded");
    expect(byTestId(root, "usage-unavailable")).toBeNull();
    expect(byTestId(root, "usage-view")?.getAttribute("aria-busy")).toBeNull();
  });

  it("says the engine has no usage feed at all", () => {
    const root = render({ usage: null, status: "unavailable" });

    expect(byTestId(root, "usage-unavailable-note")?.textContent).toContain(
      "no engine usage report",
    );
    expect(byTestId(root, "usage-loading")).toBeNull();
    expect(byTestId(root, "usage-not-reported")).toBeNull();
  });

  it("states that a ready run simply had no usage, rather than showing nothing", () => {
    const root = render({ usage: null });

    const copy = byTestId(root, "usage-not-reported");
    expect(copy).not.toBeNull();
    expect(copy?.textContent).toContain("not zero");
    // The component itself is present and identifiable in this state.
    expect(root.querySelector("[data-testid=usage-view]")).not.toBeNull();
  });

  it("keeps unavailable as unavailable even when zeroes were reported", () => {
    const root = render({
      usage: { semantics: "unavailable", inputTokens: 0, outputTokens: 0 },
    });

    expect(byTestId(root, "usage-unavailable")).not.toBeNull();
    expect(root.textContent).not.toMatch(/\$0|\b0\b/);
    expect(byTestId(root, "usage-semantics")).toBeNull();
  });

  it("shows only the numbers that were reported", () => {
    const root = render({
      usage: { semantics: "estimated", inputTokens: 1200, costUsd: null },
    });

    expect(byTestId(root, "usage-semantics")?.textContent).toContain(
      "Estimated usage",
    );
    expect(root.textContent).toContain("1,200");
    expect(root.textContent).not.toContain("Cost");
    expect(root.textContent).not.toContain("Output tokens");
  });
});
