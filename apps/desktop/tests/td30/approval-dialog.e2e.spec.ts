import { expect, test, type Page } from "@playwright/test";

type Call = { readonly name: string; readonly args: readonly unknown[] };

declare global {
  interface Window {
    __td30: {
      setContext(name: string): void;
      replace(): void;
      calls(): readonly Call[];
      clear(): void;
    };
  }
}

const url = "/tests/td30/fixture.html";

const calls = (page: Page) => page.evaluate(() => window.__td30.calls());

const setContext = (page: Page, name: string) =>
  page.evaluate((context) => window.__td30.setContext(context), name);

const dialog = (page: Page) => page.getByTestId("approval-dialog");

/** True when browser focus is inside the modal (nothing behind it is reachable). */
const focusInsideDialog = (page: Page) =>
  page.evaluate(() => {
    const element = document.querySelector<HTMLDialogElement>(
      '[data-testid="approval-dialog"]',
    );
    return !!element?.contains(document.activeElement);
  });

const focusedTestId = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid"));

test.describe("TD-30 D3_approval_revision and FUI-W5", () => {
  test("shows the exact target and opens focused on the non-destructive control", async ({
    page,
  }) => {
    await page.goto(url);

    await expect(dialog(page)).toHaveCount(1);
    await expect(dialog(page)).toHaveAttribute("data-inert", "false");
    await expect(page.getByTestId("approval-capability")).toHaveText(
      "fs.write",
    );
    await expect(page.getByTestId("approval-normalized-target")).toHaveText(
      "src/index.ts",
    );
    await expect(page.getByTestId("approval-risk")).toContainText(
      "Writes a file inside the selected workspace.",
    );
    await expect(page.locator('[data-testid="approval-target"]')).toContainText(
      "run-1 / act-1",
    );
    await expect(page.getByTestId("approval-approve")).toBeEnabled();
    await expect(page.getByTestId("approval-inert")).toHaveCount(0);

    // Enter on the default control must not approve.
    await expect(page.getByTestId("approval-deny")).toBeFocused();
    expect(await focusedTestId(page)).toBe("approval-deny");
  });

  test("the modal traps focus, Enter denies and Escape closes without a decision", async ({
    page,
  }) => {
    await page.goto(url);
    await expect(page.getByTestId("approval-deny")).toBeFocused();

    // Tab cycles through the modal's own controls. Browsers hand focus to the
    // browser chrome after the last control (activeElement null); what must never
    // happen is focus landing on something behind the modal.
    const controls = ["approval-deny", "approval-approve", "approval-dismiss"];
    const chain: (string | null)[] = [await focusedTestId(page)];
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      chain.push(await focusedTestId(page));
    }
    expect(
      chain
        .filter((id): id is string => id !== null)
        .every((id) => controls.includes(id)),
    ).toBe(true);
    expect(chain).toContain("approval-dismiss");
    // It returns into the dialog rather than escaping to the page.
    expect(chain.slice(3)).toContain("approval-deny");

    // The page behind the modal is inert: it cannot take focus.
    await page.evaluate(() => document.getElementById("behind")?.focus());
    expect(await focusInsideDialog(page)).toBe(true);
    expect(await focusedTestId(page)).not.toBe("behind");

    // Escape is a dismissal, never a decision.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    expect(await calls(page)).toEqual([{ name: "onDismiss", args: ["apr-1"] }]);

    // Enter on the focused non-destructive control denies, not approves.
    await page.goto(url);
    await expect(page.getByTestId("approval-deny")).toBeFocused();
    await page.keyboard.press("Enter");
    expect(await calls(page)).toEqual([
      {
        name: "onRespond",
        args: [
          {
            approvalRequestId: "apr-1",
            runId: "run-1",
            actionId: "act-1",
            decision: "deny",
          },
        ],
      },
    ]);
    await expect(page.getByTestId("approval-submitted")).toContainText("act-1");
  });

  test("approving submits the store-built payload and claims no execution", async ({
    page,
  }) => {
    await page.goto(url);
    await page.getByTestId("approval-approve").click();

    expect(await calls(page)).toEqual([
      {
        name: "onRespond",
        args: [
          {
            approvalRequestId: "apr-1",
            runId: "run-1",
            actionId: "act-1",
            decision: "approve",
          },
        ],
      },
    ]);
    await expect(page.getByTestId("approval-submitted")).toContainText(
      "until the engine reports the outcome",
    );
    await expect(dialog(page)).toContainText("Approval submitted");
    await expect(dialog(page)).not.toContainText("executed action");
  });

  test("a decision is one-use: two activations in the same tick submit once", async ({
    page,
  }) => {
    await page.goto(url);

    // Both clicks land before Svelte re-renders, which is the worst case for a
    // double activation (pointer double-click or Enter repeat).
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="approval-approve"]',
      );
      button?.click();
      button?.click();
    });

    expect(await calls(page)).toEqual([
      {
        name: "onRespond",
        args: [
          {
            approvalRequestId: "apr-1",
            runId: "run-1",
            actionId: "act-1",
            decision: "approve",
          },
        ],
      },
    ]);
    await expect(page.getByTestId("approval-submitted")).toContainText("act-1");
    // No control remains that could submit the same request again.
    await expect(page.getByTestId("approval-approve")).toHaveCount(0);
    await expect(page.getByTestId("approval-deny")).toHaveCount(0);
    await page.keyboard.press("Enter");
    expect(await calls(page)).toHaveLength(1);
  });

  test("a wrong target or stale revision keeps the dialog inert", async ({
    page,
  }) => {
    await page.goto(url);

    await setContext(page, "wrong-target");
    await expect(dialog(page)).toHaveAttribute("data-inert", "true");
    await expect(page.getByTestId("approval-inert")).toContainText(
      "The approval belongs to a different run.",
    );
    await expect(page.getByTestId("approval-inert")).toContainText(
      "The approval target changed after it was requested.",
    );
    await expect(page.getByTestId("approval-approve")).toBeDisabled();
    await expect(page.getByTestId("approval-deny")).toBeDisabled();
    await expect(page.getByTestId("approval-approve-reason")).toContainText(
      "different run",
    );
    await expect(page.getByTestId("approval-dismiss")).toHaveText("Close");

    // Neither pointer nor keyboard can approve a target the user is not looking at.
    await page.getByTestId("approval-approve").click({ force: true });
    await page.keyboard.press("Enter");
    expect(await calls(page)).toEqual([]);
    await expect(page.getByTestId("approval-submitted")).toHaveCount(0);

    await setContext(page, "stale-revision");
    await expect(page.getByTestId("approval-inert")).toContainText(
      "Configuration, profile or policy revision changed.",
    );
    await expect(page.getByTestId("approval-approve-reason")).toContainText(
      "revision changed",
    );
    await expect(page.getByTestId("approval-approve")).toBeDisabled();
    expect(await calls(page)).toEqual([]);

    // Still driven by the engine's current context: the same request becomes valid again.
    await setContext(page, "matching");
    await expect(dialog(page)).toHaveAttribute("data-inert", "false");
    await expect(page.getByTestId("approval-approve")).toBeEnabled();
    await expect(page.getByTestId("approval-inert")).toHaveCount(0);
  });

  test("an unavailable engine or expiry can never be approved", async ({
    page,
  }) => {
    await page.goto(url);

    for (const [context, reason] of [
      ["engine-unavailable", "Engine process exited."],
      ["expired", "expired"],
    ] as const) {
      await setContext(page, context);
      await expect(page.getByTestId("approval-inert")).toContainText(reason);
      await expect(page.getByTestId("approval-approve")).toBeDisabled();
      await expect(page.getByTestId("approval-deny")).toBeDisabled();
      await expect(page.getByTestId("approval-dismiss")).toHaveText("Close");
      await page.getByTestId("approval-approve").click({ force: true });
      expect(await calls(page)).toEqual([]);
    }

    // Closing an inert prompt never turns it into an approval.
    await page.getByTestId("approval-dismiss").click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await calls(page)).toEqual([{ name: "onDismiss", args: ["apr-1"] }]);
  });

  test("a canceled run closes the prompt, restores focus and says no decision was made", async ({
    page,
  }) => {
    await page.goto(url);
    await expect(dialog(page)).toHaveCount(1);
    await expect(page.getByTestId("approval-deny")).toBeFocused();

    // The run is canceled while the prompt is open. The question no longer has
    // an answer, so the modal must not stay up asking it.
    await setContext(page, "run-canceled");

    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("approval-closed-canceled")).toContainText(
      "No action was approved",
    );
    // Only the dismissal was reported: nothing was approved or denied.
    expect(await calls(page)).toEqual([{ name: "onDismiss", args: ["apr-1"] }]);
    // Focus left the modal instead of staying on a control that no longer exists.
    expect(
      await page.evaluate(() => document.activeElement === document.body),
    ).toBe(true);
    expect(await focusInsideDialog(page)).toBe(false);

    // A late activation of the old prompt cannot decide anything.
    await page.evaluate(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="approval-approve"]')
        ?.click();
    });
    expect(await calls(page)).toHaveLength(1);
  });

  test("closing a submitted prompt after the run ended claims no decision was retracted", async ({
    page,
  }) => {
    await page.goto(url);
    await page.getByTestId("approval-approve").click();
    await expect(page.getByTestId("approval-submitted")).toContainText("act-1");

    // The run ends after the decision was submitted: the prompt stays up because
    // that decision's own outcome is still pending.
    await setContext(page, "run-canceled");
    await expect(dialog(page)).toHaveCount(1);
    await expect(page.getByTestId("approval-submitted")).toContainText("act-1");

    // The person closes it. The approval they already submitted is not undone,
    // so nothing may say that no decision was made.
    await page.getByTestId("approval-close").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("approval-closed-canceled")).toHaveCount(0);
    expect(await calls(page)).toEqual([
      {
        name: "onRespond",
        args: [
          {
            approvalRequestId: "apr-1",
            runId: "run-1",
            actionId: "act-1",
            decision: "approve",
          },
        ],
      },
      { name: "onDismiss", args: ["apr-1"] },
    ]);
  });

  test("a replacement request remounts the dialog and the older one never resurfaces", async ({
    page,
  }) => {
    await page.goto(url);
    await page.getByTestId("approval-approve").click();
    await expect(page.getByTestId("approval-submitted")).toContainText("act-1");

    // A newer request arrives while the submitted prompt is still open.
    await page.evaluate(() => window.__td30.replace());

    await expect(dialog(page)).toHaveCount(1);
    // No decision or "submitted" state carries over to the new target.
    await expect(page.getByTestId("approval-submitted")).toHaveCount(0);
    await expect(dialog(page)).toContainText("Approval required");
    await expect(page.getByTestId("approval-normalized-target")).toHaveText(
      "src/other.ts",
    );
    await expect(page.locator('[data-testid="approval-target"]')).toContainText(
      "run-2 / act-2",
    );
    await expect(page.getByTestId("approval-approve")).toBeEnabled();

    // Dismissing the newest request must not fall back to the older one.
    await page.getByTestId("approval-dismiss").click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByTestId("approval-normalized-target")).toHaveCount(0);

    const recorded = await calls(page);
    expect(recorded.at(-1)).toEqual({
      name: "onDismiss",
      args: ["apr-2"],
    });
  });
});
