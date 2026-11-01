/**
 * Renders every TD-29 e2e fixture case without a browser, so a broken fixture
 * or harness fails the normal desktop suite instead of only the Playwright run.
 *
 * The Playwright specs in setup-flow.e2e.spec.ts remain the browser-level
 * expectations; this file proves the fixture page surface they rely on exists.
 */
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import Td29Fixture from "./Td29Fixture.svelte";
import { TD29_CASES, type Td29Case } from "./cases";

type Call = { readonly name: string; readonly args: readonly unknown[] };

declare global {
  interface Window {
    __td29?: {
      case: Td29Case;
      calls(): readonly Call[];
      lastCall(): Call | null;
      clear(): void;
    };
  }
}

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = "";
  delete (window as { __td29?: unknown }).__td29;
});

async function render(caseName: Td29Case): Promise<void> {
  app = mount(Td29Fixture, {
    target: document.body,
    props: { case: caseName },
  });
  flushSync();
  await tick();
  flushSync();
}

const calls = () => window.__td29.calls();

describe("TD-29 e2e fixture harness", () => {
  it("publishes a known case and starts with no recorded calls", async () => {
    for (const caseName of TD29_CASES) {
      await render(caseName);
      expect(window.__td29.case).toBe(caseName);
      expect(calls()).toEqual([]);
      if (app) unmount(app);
      app = null;
      document.body.innerHTML = "";
    }
  });

  it("renders D1/FUI-W1 as a base-first setup with an unavailable catalog", async () => {
    await render("d1-setup");
    expect(
      document.querySelector("[data-testid=setup]")?.getAttribute("data-step"),
    ).toBe("start");
    expect(
      document.querySelector("[data-testid=generation]")?.textContent,
    ).toContain("Generation unconfigured");

    (
      document.querySelector(
        '[data-testid="choose-modules"]',
      ) as HTMLButtonElement
    ).click();
    flushSync();
    expect(
      document.querySelector('[data-testid="catalog-unavailable"]')
        ?.textContent,
    ).toContain("not an empty successful catalog");
    expect(
      (
        document.querySelector(
          '[data-testid="review-install"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("renders D6 with selectable roots and a stale variant", async () => {
    await render("d6-setup");
    const options = document.querySelectorAll('[data-testid="module-option"]');
    expect(options.length).toBe(4);
    expect(
      document.querySelector('[data-testid="ambient-notice"]')?.textContent,
    ).toContain("fixture-e");

    (
      document.querySelector(
        '[data-testid="module-option"][data-package-id="fixture-a"] input',
      ) as HTMLInputElement
    ).click();
    (
      document.querySelector(
        '[data-testid="module-option"][data-package-id="fixture-b"] input',
      ) as HTMLInputElement
    ).click();
    flushSync();
    (
      document.querySelector(
        '[data-testid="review-install"]',
      ) as HTMLButtonElement
    ).click();
    flushSync();
    await tick();
    flushSync();

    expect(document.querySelectorAll('[data-testid="plan-root"]').length).toBe(
      2,
    );
    expect(
      document.querySelectorAll('[data-testid="plan-dependency"]').length,
    ).toBe(1);
    expect(calls().map((call) => call.name)).toEqual(["onReview"]);

    if (app) unmount(app);
    app = null;
    document.body.innerHTML = "";

    await render("d6-stale");
    expect(
      (
        document.querySelector(
          '[data-testid="review-install"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("renders FUI-W10 lifecycle rows and the engine-unavailable read-only state", async () => {
    await render("w10-modules");
    expect(document.querySelectorAll('[data-testid="module-row"]').length).toBe(
      3,
    );
    const a = document.querySelector(
      '[data-testid="module-row"][data-package-id="fixture-a"]',
    );
    expect(a?.textContent).toContain("fixture-a notes");
    expect(
      (a?.querySelector('[data-testid="enable-module"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    if (app) unmount(app);
    app = null;
    document.body.innerHTML = "";

    await render("unavailable-modules");
    expect(
      document.querySelector('[data-testid="modules-engine-unavailable"]')
        ?.textContent,
    ).toContain("Engine process exited.");
    expect(
      (
        document.querySelector(
          '[data-testid="add-module"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(calls()).toEqual([]);
  });
});
