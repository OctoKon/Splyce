import { expect, test } from "@playwright/test";
import { join } from "node:path";

// Browser checks qualify the renderer only; native support remains unavailable.
test("approved shell keeps navigation, drafts, themes and unavailable states honest", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const nav = page.getByRole("navigation", { name: "Workspace" });
  const capture = async (name: string) => {
    const path = process.env.SPLYCE_UI_SCREENSHOTS
      ? join(process.env.SPLYCE_UI_SCREENSHOTS, `ui-${name}.png`)
      : testInfo.outputPath(`ui-${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
  };
  await expect(
    page.getByRole("heading", { name: /Barebones by default/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Choose project", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Pi engine · unavailable", { exact: true }),
  ).toBeVisible();
  await capture("work");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Keep this unsent task");
  for (const [name, state] of [
    ["Runs", "Sessions could not be loaded"],
    ["Memory", "Memory is unavailable"],
    ["Models", "The engine is not connected. Nothing can be saved."],
    ["Extensions", "No setup or module service is connected."],
    ["Settings", "No setup or module service is connected."],
  ] as const) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(
      nav.getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name, exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText(state, { exact: false }).last()).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toBeHidden();
    await capture(name.toLowerCase());
  }
  await nav.getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Keep this unsent task",
  );
  await page.getByLabel("Message", { exact: true }).fill("");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await capture("work-dark");
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await capture("settings-dark");
  await nav.getByRole("button", { name: "Work", exact: true }).click();
  await page.keyboard.press("Control+b");
  await expect(
    page.getByRole("button", { name: "Open sidebar", exact: true }),
  ).toBeFocused();
  await expect(nav).toBeHidden();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture("work-mobile");
  const open = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  await open.click();
  await expect(page.locator("#app-sidebar .side-close")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Switch to dark theme" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#app-sidebar .side-close")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    requests.filter(
      (url) => !new URL(url).hostname.match(/^(localhost|127\.0\.0\.1)$/),
    ),
  ).toEqual([]);
  expect(errors).toEqual([]);
});
