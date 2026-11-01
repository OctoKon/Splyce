import { expect, test, type Page } from "@playwright/test";
import type { Td29Case } from "./cases";

type Call = { readonly name: string; readonly args: readonly unknown[] };

declare global {
  interface Window {
    __td29: {
      case: Td29Case;
      calls(): readonly Call[];
      lastCall(): Call | null;
      clear(): void;
    };
  }
}

function url(caseName: Td29Case): string {
  return `/tests/td29/fixture.html?case=${caseName}`;
}

const calls = (page: Page) => page.evaluate(() => window.__td29.calls());

const lastCall = (page: Page) => page.evaluate(() => window.__td29.lastCall());

const moduleOption = (page: Page, packageId: string) =>
  page.locator(
    `[data-testid="module-option"][data-package-id="${packageId}"] input`,
  );

const moduleRow = (page: Page, packageId: string) =>
  page.locator(`[data-testid="module-row"][data-package-id="${packageId}"]`);

test.describe("TD-29 D1_base_setup and FUI-W1", () => {
  test("D1: starts base-first, describes generation honestly and installs nothing", async ({
    page,
  }) => {
    await page.goto(url("d1-setup"));

    await expect(page.getByTestId("setup")).toHaveAttribute(
      "data-step",
      "start",
    );
    // The base path is the focused primary default.
    await expect(page.getByTestId("base-only")).toBeFocused();
    await expect(page.getByTestId("generation")).toHaveAttribute(
      "data-state",
      "unconfigured",
    );
    await expect(page.getByTestId("generation")).toContainText(
      "Generation unconfigured",
    );
    await expect(page.getByTestId("generation")).toContainText(
      "No generation model is selected.",
    );
    expect(await calls(page)).toEqual([]);

    await page.getByTestId("base-only").click();
    await expect(page.getByTestId("setup")).toHaveAttribute(
      "data-step",
      "workbench",
    );
    await expect(page.getByTestId("workbench-generation")).toContainText(
      "Generation unconfigured",
    );
    // Continuing with the base is a presentation choice plus an entry request;
    // it starts no install, fetch, enable or model download.
    expect((await calls(page)).map((call) => call.name)).toEqual([
      "onBaseOnly",
      "onEnterWorkbench",
    ]);
  });

  test("D1/FUI-W1: ambient configuration is disclosed but never selected", async ({
    page,
  }) => {
    await page.goto(url("d1-setup"));
    await page.getByTestId("choose-modules").click();

    await expect(page.getByTestId("ambient-notice")).toContainText(
      "splyce-memory",
    );
    await expect(page.getByTestId("ambient-notice")).toContainText(
      "not permission",
    );
    // An unavailable catalog is an alert, never an empty successful list.
    await expect(page.getByTestId("catalog-unavailable")).toContainText(
      "Catalog unavailable",
    );
    await expect(page.getByTestId("catalog-unavailable")).toContainText(
      "not an empty successful catalog",
    );
    await expect(page.getByTestId("module-option")).toHaveCount(0);
    await expect(page.getByTestId("review-install")).toBeDisabled();
    await expect(page.getByTestId("selection-count")).toContainText(
      "Selected: 0 module(s)",
    );
    expect(await calls(page)).toEqual([]);
  });
});

test.describe("TD-29 D6_optional_install_remove", () => {
  test("reviews the exact A/B -> D closure and needs a separate execution grant", async ({
    page,
  }) => {
    await page.goto(url("d6-setup"));

    await moduleOption(page, "fixture-a").check();
    await moduleOption(page, "fixture-b").check();
    await page.getByTestId("review-install").click();

    await expect(page.getByTestId("plan-root")).toHaveCount(2);
    await expect(page.getByTestId("plan-dependency")).toHaveCount(1);
    await expect(page.getByTestId("plan-dependency")).toHaveAttribute(
      "data-package-id",
      "fixture-d",
    );
    // The unselected fixture-e never enters the reviewed closure.
    await expect(page.getByTestId("plan-dependency")).not.toHaveAttribute(
      "data-package-id",
      "fixture-e",
    );
    await expect(page.locator("[data-package-id='fixture-e']")).toHaveCount(0);
    await expect(page.getByTestId("plan-totals")).toContainText(
      "An unknown size is not zero",
    );
    await expect(page.getByTestId("plan-totals")).toContainText("Unknown");

    // Enable-after-install starts off; running setup code is a separate opt-in.
    await expect(page.getByTestId("enable-after-install")).not.toBeChecked();
    await expect(page.getByTestId("execution-grant")).not.toBeChecked();
    await expect(page.getByTestId("confirm-install")).toBeDisabled();
    await expect(page.getByTestId("confirm-reason")).toContainText(
      "executable setup step",
    );
    expect((await calls(page)).map((call) => call.name)).toEqual(["onReview"]);

    await page.getByTestId("execution-grant").check();
    await expect(page.getByTestId("confirm-install")).toBeEnabled();
    await page.getByTestId("confirm-install").click();

    const submission = await lastCall(page);
    expect(submission?.name).toBe("onConfirmInstall");
    const payload = submission?.args[0] as {
      requestId: string;
      planId: string;
      enableRequested: boolean;
      executionGranted: boolean;
    };
    expect(payload).toMatchObject({
      planId: "plan-d6-current",
      enableRequested: false,
      executionGranted: true,
    });
    // The renderer mints the correlation identity and shows the same one while
    // it waits for the engine to echo it.
    expect(payload.requestId).toMatch(/^setup-request-/);
    await expect(page.getByTestId("awaiting-request-id")).toHaveText(
      payload.requestId,
    );
  });

  test("keeps confirmation disabled for a stale plan", async ({ page }) => {
    await page.goto(url("d6-stale"));
    await moduleOption(page, "fixture-a").check();
    await moduleOption(page, "fixture-b").check();
    await page.getByTestId("review-install").click();

    await expect(page.getByTestId("plan-state")).toHaveAttribute(
      "data-current",
      "false",
    );
    await page.getByTestId("execution-grant").check();
    await expect(page.getByTestId("confirm-install")).toBeDisabled();
    await expect(page.getByTestId("confirm-reason")).toContainText(
      "pinned commit",
    );

    await page.getByTestId("confirm-install").click({ force: true });
    expect((await calls(page)).map((call) => call.name)).not.toContain(
      "onConfirmInstall",
    );
  });
});

test.describe("TD-29 FUI-W10 module lifecycle", () => {
  test("keeps installed, requested, effective, shared and retained state distinct", async ({
    page,
  }) => {
    await page.goto(url("w10-modules"));

    const rowA = moduleRow(page, "fixture-a");
    await expect(rowA.getByTestId("row-effective")).toHaveText("Off");
    await expect(rowA).toContainText("Off requested");
    await expect(rowA.getByTestId("shared-deps")).toContainText("fixture-d");
    await expect(rowA.getByTestId("retained-data")).toContainText(
      "fixture-a notes",
    );
    await expect(rowA.getByTestId("enable-module")).toBeDisabled();
    await expect(rowA).toContainText("Enable dependencies separately first");

    const rowD = moduleRow(page, "fixture-d");
    await expect(rowD.getByTestId("uninstall-module")).toBeDisabled();
    await expect(rowD).toContainText("Required by fixture-a");

    const rowCleanup = moduleRow(page, "fixture-cleanup");
    await expect(rowCleanup).toContainText("Cleanup incomplete");
    await expect(rowCleanup.getByTestId("delete-data")).toBeDisabled();
  });

  test("uninstalls code, keeps retained data, and deletes data only on request", async ({
    page,
  }) => {
    await page.goto(url("w10-modules"));
    const rowA = moduleRow(page, "fixture-a");

    await rowA.getByTestId("uninstall-module").click();
    const dialog = page.getByTestId("module-dialog");
    await expect(dialog).toHaveAttribute("data-kind", "uninstall");
    await expect(dialog).toContainText("Kept after uninstall");
    await expect(dialog).toContainText("fixture-a notes");

    // Escape dismisses without submitting and restores the opener.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(rowA.getByTestId("uninstall-module")).toBeFocused();
    expect(await calls(page)).toEqual([]);

    await rowA.getByTestId("uninstall-module").click();
    await page.getByTestId("dialog-confirm").click();
    expect(await lastCall(page)).toEqual({
      name: "onUninstall",
      args: ["fixture-a"],
    });

    await rowA.getByTestId("delete-data").click();
    await expect(page.getByTestId("module-dialog")).toHaveAttribute(
      "data-kind",
      "delete-data",
    );
    await expect(page.getByTestId("module-dialog")).toContainText(
      "does not uninstall package code",
    );
    await page.getByTestId("dialog-confirm").click();
    expect(await lastCall(page)).toEqual({
      name: "onDeleteData",
      args: ["fixture-a"],
    });
  });

  test("traps focus inside the confirmation dialog", async ({ page }) => {
    await page.goto(url("w10-modules"));
    await moduleRow(page, "fixture-a").getByTestId("uninstall-module").click();

    const dialog = page.getByTestId("module-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("dialog-cancel")).toBeFocused();

    // Shift+Tab from the first control wraps to the last one, and Tab wraps back.
    const first = dialog.getByTestId("open-delete-data");
    const last = dialog.getByTestId("dialog-confirm");
    await first.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
  });

  test("disables every effect while the engine is unavailable", async ({
    page,
  }) => {
    await page.goto(url("unavailable-modules"));

    await expect(page.getByTestId("modules-engine-unavailable")).toContainText(
      "Engine process exited.",
    );
    await expect(page.getByTestId("add-module")).toBeDisabled();
    await expect(page.getByTestId("refresh-catalog")).toBeDisabled();

    for (const packageId of ["fixture-a", "fixture-d", "fixture-cleanup"]) {
      const row = moduleRow(page, packageId);
      for (const action of [
        "enable-module",
        "disable-module",
        "uninstall-module",
        "delete-data",
      ]) {
        await expect(row.getByTestId(action)).toBeDisabled();
      }
    }

    await page.getByTestId("add-module").click({ force: true });
    await expect(page.getByTestId("module-dialog")).toHaveCount(0);
    expect(await calls(page)).toEqual([]);
  });
});
