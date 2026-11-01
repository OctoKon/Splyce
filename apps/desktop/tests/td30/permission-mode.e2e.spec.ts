import { expect, test, type Page } from "@playwright/test";

type Call = { readonly name: string; readonly args: readonly unknown[] };

declare global {
  interface Window {
    __td30p: {
      calls(): readonly Call[];
      setEngine(engine: "ready" | "unavailable", reason: string | null): void;
      setRevisions(
        configRevision: string | null,
        policyRevision: string | null,
      ): void;
      acknowledge(): void;
      reject(reason: string): void;
      newSession(sessionId: string): void;
    };
  }
}

const url = "/tests/td30/permission-mode.html";

const calls = (page: Page) => page.evaluate(() => window.__td30p.calls());

const select = (page: Page) => page.getByTestId("permission-mode-select");

const confirm = (page: Page) => page.getByTestId("permission-confirm");

/** True when browser focus is inside the bypass confirmation. */
const focusInsideConfirm = (page: Page) =>
  page.evaluate(() => {
    const element = document.querySelector<HTMLDialogElement>(
      '[data-testid="permission-confirm"]',
    );
    return !!element?.contains(document.activeElement);
  });

const focusedTestId = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid"));

test.describe("TD-30 U1_permission_mode", () => {
  test("reports a request, keeps the effective mode and only announces the engine acknowledgement", async ({
    page,
  }) => {
    await page.goto(url);

    // The initial effective mode is the safe one and nothing is pending.
    await expect(select(page)).toHaveValue("manual");
    await expect(select(page)).toBeEnabled();
    await expect(page.getByTestId("permission-effective")).toContainText(
      "Manual",
    );
    await expect(page.getByTestId("permission-pending")).toHaveCount(0);
    await expect(page.getByTestId("permission-announcement")).toHaveText("");

    // Choosing a mode only submits the request.
    await select(page).selectOption("accept-edits");
    expect(await calls(page)).toEqual([
      { name: "onChange", args: ["accept-edits"] },
    ]);
    await expect(page.getByTestId("permission-effective")).toContainText(
      "Manual",
    );
    await expect(page.getByTestId("permission-pending")).toContainText(
      "Accept edits (pending engine) — not effective until the engine acknowledges it.",
    );
    await expect(page.getByTestId("permission-announcement")).toHaveText("");

    // Only the engine acknowledgement changes the effective mode, once.
    await page.evaluate(() => window.__td30p.acknowledge());
    await expect(page.getByTestId("permission-effective")).toContainText(
      "Accept edits",
    );
    await expect(page.getByTestId("permission-announcement")).toHaveText(
      "Permission mode is now Accept edits.",
    );
    await expect(page.getByTestId("permission-pending")).toHaveCount(0);
    expect(await calls(page)).toEqual([
      { name: "onChange", args: ["accept-edits"] },
    ]);
  });

  test("a rejection keeps the previous mode and shows the engine's reason", async ({
    page,
  }) => {
    await page.goto(url);

    await select(page).selectOption("auto");
    await page.evaluate(() =>
      window.__td30p.reject("Policy forbids auto mode."),
    );

    await expect(page.getByTestId("permission-rejected")).toContainText(
      "Policy forbids auto mode. The previous mode is still effective.",
    );
    await expect(page.getByTestId("permission-effective")).toContainText(
      "Manual",
    );
    await expect(select(page)).toHaveValue("manual");
    await expect(page.getByTestId("permission-announcement")).toHaveText("");
  });

  test("bypass needs its own confirmation, and the safe choice is the default", async ({
    page,
  }) => {
    await page.goto(url);

    await select(page).selectOption("bypass");

    // The dangerous mode is not submitted; a separate confirmation opens.
    await expect(confirm(page)).toBeVisible();
    expect(await calls(page)).toEqual([]);
    await expect(page.getByTestId("permission-keep")).toBeFocused();
    await expect(page.getByTestId("permission-keep")).toHaveText("Keep Manual");

    // Focus cycles through the confirmation's two controls. The browser may hand
    // focus to its chrome after the last one (activeElement null); it must never
    // reach the page behind the modal.
    const controls = ["permission-keep", "permission-confirm-bypass"];
    const chain: (string | null)[] = [await focusedTestId(page)];
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      chain.push(await focusedTestId(page));
    }
    const named = chain.filter((id): id is string => id !== null);
    expect(named.every((id) => controls.includes(id))).toBe(true);
    expect(named).toContain("permission-confirm-bypass");
    // It returns into the confirmation rather than escaping to the page.
    expect(chain.slice(1)).toContain("permission-keep");
    await page.getByTestId("permission-keep").focus();
    await page.evaluate(() => document.getElementById("behind")?.focus());
    expect(await focusedTestId(page)).not.toBe("behind");
    expect(await focusInsideConfirm(page)).toBe(true);

    // Enter on the default control keeps the current mode.
    await page.getByTestId("permission-keep").focus();
    await page.keyboard.press("Enter");
    await expect(confirm(page)).toBeHidden();
    expect(await calls(page)).toEqual([{ name: "onDismissConfirm", args: [] }]);
    await expect(page.getByTestId("permission-effective")).toContainText(
      "Manual",
    );

    // Escape is a dismissal too; it never enables the dangerous mode.
    await select(page).selectOption("bypass");
    await expect(confirm(page)).toBeVisible();
    expect(await calls(page)).toHaveLength(1);
    await page.keyboard.press("Escape");
    await expect(confirm(page)).toBeHidden();
    expect(await calls(page)).toEqual([
      { name: "onDismissConfirm", args: [] },
      { name: "onDismissConfirm", args: [] },
    ]);

    // Only the explicit enable submits bypass.
    await select(page).selectOption("bypass");
    await page.getByTestId("permission-confirm-bypass").click();
    await expect(confirm(page)).toBeHidden();
    const recorded = await calls(page);
    expect(recorded.at(-1)).toEqual({ name: "onChange", args: ["bypass"] });
    // Still not effective: the engine has not acknowledged it.
    await expect(page.getByTestId("permission-effective")).toContainText(
      "Manual",
    );
    await expect(page.getByTestId("permission-pending")).toContainText(
      "Bypass (unsafe) (pending engine)",
    );
  });

  test("an unavailable engine or unknown revisions cannot change the mode", async ({
    page,
  }) => {
    await page.goto(url);

    await page.evaluate(() =>
      window.__td30p.setEngine("unavailable", "Engine process exited."),
    );
    await expect(select(page)).toBeDisabled();
    await expect(page.getByTestId("permission-blocked")).toContainText(
      "Engine process exited.",
    );
    // A disabled control cannot even be driven programmatically through the UI.
    await page.evaluate(() => {
      const element = document.querySelector<HTMLSelectElement>(
        '[data-testid="permission-mode-select"]',
      );
      if (element) {
        element.value = "auto";
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    expect(await calls(page)).toEqual([]);
    await expect(select(page)).toHaveValue("manual");

    // Revisions are required: without them the request is refused, not guessed.
    await page.evaluate(() => {
      window.__td30p.setEngine("ready", null);
      window.__td30p.setRevisions(null, null);
    });
    await select(page).selectOption("auto");
    expect(await calls(page)).toEqual([]);
    await expect(page.getByTestId("permission-notice")).toContainText(
      "Current configuration and policy revisions are not known.",
    );
    await expect(select(page)).toHaveValue("manual");
    await expect(page.getByTestId("permission-effective")).toContainText(
      "Manual",
    );
  });

  test("a mode never carries into another session", async ({ page }) => {
    await page.goto(url);

    await select(page).selectOption("accept-edits");
    await expect(page.getByTestId("permission-pending")).toContainText(
      "Accept edits (pending engine)",
    );

    await page.evaluate(() => window.__td30p.newSession("ses-2"));

    await expect(page.getByTestId("permission-pending")).toHaveCount(0);
    await expect(page.getByTestId("permission-effective")).toContainText(
      "Manual",
    );
    await expect(select(page)).toHaveValue("manual");
    await expect(page.getByTestId("permission-announcement")).toHaveText("");
  });

  // dnarsh's real-Edge probe: an open bypass confirmation is an answer about
  // one session under one set of revisions. Each of these mutates the mounted
  // selector (no reload) and then activates the old Enable control if it still
  // exists, which is exactly how a stale dialog could request bypass.
  const staleEnableClick = (page: Page) =>
    page.evaluate(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="permission-confirm-bypass"]',
        )
        ?.click();
    });

  /** The only call that could change the engine-admitted mode. */
  const changes = async (page: Page) =>
    (await calls(page)).filter((call) => call.name === "onChange");

  test("a stale bypass confirmation cannot request bypass in a new session", async ({
    page,
  }) => {
    await page.goto(url);

    await select(page).selectOption("bypass");
    await expect(confirm(page)).toBeVisible();

    await page.evaluate(() => window.__td30p.newSession("ses-2"));
    await staleEnableClick(page);

    await expect(confirm(page)).toBeHidden();
    expect(await changes(page)).toEqual([]);
    await expect(page.getByTestId("permission-notice")).toContainText(
      "session changed",
    );
    // No pending bypass leaked into the new session.
    await expect(page.getByTestId("permission-pending")).toHaveCount(0);
    await expect(page.getByTestId("permission-effective")).toContainText(
      "Manual",
    );
  });

  test("a stale bypass confirmation cannot request bypass after the revisions change", async ({
    page,
  }) => {
    await page.goto(url);

    await select(page).selectOption("bypass");
    await expect(confirm(page)).toBeVisible();

    await page.evaluate(() => window.__td30p.setRevisions("cfg-2", "pol-2"));
    await staleEnableClick(page);

    await expect(confirm(page)).toBeHidden();
    expect(await changes(page)).toEqual([]);
    await expect(page.getByTestId("permission-notice")).toContainText(
      "Configuration or policy changed",
    );
    await expect(page.getByTestId("permission-pending")).toHaveCount(0);
  });

  test("a bypass confirmation cannot be accepted after the engine goes away", async ({
    page,
  }) => {
    await page.goto(url);

    await select(page).selectOption("bypass");
    await expect(confirm(page)).toBeVisible();

    await page.evaluate(() =>
      window.__td30p.setEngine("unavailable", "Engine lost"),
    );
    await staleEnableClick(page);

    await expect(confirm(page)).toBeHidden();
    expect(await changes(page)).toEqual([]);
    await expect(page.getByTestId("permission-notice")).toContainText(
      "Engine lost",
    );
    await expect(page.getByTestId("permission-blocked")).toContainText(
      "Engine lost",
    );
    await expect(page.getByTestId("permission-pending")).toHaveCount(0);
  });
});
