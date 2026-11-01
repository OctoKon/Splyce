import { expect, test, type Page } from "@playwright/test";

type Call = { readonly name: string; readonly args: readonly unknown[] };
type Request = {
  readonly kind: "resume" | "fork" | "rewind";
  readonly sourceSessionId: string;
  readonly entryId: string | null;
  readonly choice: "conversation" | "code" | "both" | null;
};

declare global {
  interface Window {
    __td33: {
      calls(): readonly Call[];
      requests(): readonly Request[];
      aborted(): readonly boolean[];
      setEngine(next: "ready" | "unavailable", reason: string | null): void;
      setRewind(next: "ready" | "unavailable", reason: string | null): void;
      setCodeRestore(
        next: "ready" | "unavailable",
        reason: string | null,
      ): void;
      setSelection(next: "a" | "b" | "none"): void;
      setMode(next: "hold" | "succeed" | "fail" | "honor" | "none"): void;
      release(): void;
      fail(message: string): void;
    };
  }
}

const url = "/tests/td33/session-actions.html";

const requests = (page: Page) => page.evaluate(() => window.__td33.requests());
const calls = (page: Page) => page.evaluate(() => window.__td33.calls());

const focusedTestId = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid"));

test.describe("TD-33 D4_session_resume_fork", () => {
  test("fork names the selected ancestry, and a canceled request never claims the source is unchanged", async ({
    page,
  }) => {
    await page.goto(url);
    await expect(page.getByTestId("fork-point")).toHaveText(
      "Fork point: ses_1 / anchor_1",
    );
    await expect(page.getByTestId("fork-leaves")).toHaveText("Leaves: e1, e2");

    // Keyboard: focus the control and activate it.
    await page.getByTestId("action-fork").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("action-busy")).toContainText(
      "Requesting the fork at ses_1 / anchor_1",
    );
    expect(await requests(page)).toEqual([
      {
        kind: "fork",
        sourceSessionId: "ses_1",
        entryId: "anchor_1",
        choice: null,
      },
    ]);

    // The user typed after the action captured the editor.
    await page.getByTestId("editor").fill("edited while busy");
    await page.getByTestId("action-cancel").press("Enter");

    // The executor cannot be recalled, so the UI is honest: pending, no claim
    // that the source is unchanged, and the newer draft is untouched.
    await expect(page.getByTestId("action-canceling")).toContainText(
      "Cancel requested",
    );
    await expect(page.getByTestId("action-canceling")).toContainText(
      "not guaranteed unchanged",
    );
    await expect(page.getByTestId("action-canceled")).toHaveCount(0);
    // The cancel was actually delivered to the executor: this one ignores the
    // signal, which is exactly why the UI keeps the pending wording.
    expect(await page.evaluate(() => window.__td33.aborted())).toEqual([true]);
    await expect(page.getByTestId("editor")).toHaveValue("edited while busy");
    // Focus moves to the status that explains the pending cancel (the trigger
    // is disabled while the request may still be running).
    expect(await focusedTestId(page)).toBe("action-canceling");
    expect(
      (await calls(page)).filter((call) => call.name === "onRestoreDraft"),
    ).toEqual([]);

    // The engine answers: it completed before the cancel took effect, which is
    // reported as such instead of being hidden as a successful cancel.
    await page.evaluate(() => window.__td33.release());
    await expect(page.getByTestId("action-succeeded")).toContainText(
      "cancel request arrived too late",
    );
    await expect(page.getByTestId("action-succeeded")).toContainText(
      "may have changed",
    );
    await expect(page.getByTestId("editor")).toHaveValue("edited while busy");
    // Once the engine answers, the actions are usable again and focus returns
    // to the control that started them.
    expect(await focusedTestId(page)).toBe("action-fork");
  });

  test("an executor that honours the cancel settles as stopped, never as an untouched source", async ({
    page,
  }) => {
    await page.goto(url);
    await page.evaluate(() => window.__td33.setMode("honor"));
    await page.getByTestId("action-fork").click();
    await expect(page.getByTestId("action-busy")).toBeVisible();
    // Nothing is cancelled yet, but the channel travelled with the request.
    expect(await page.evaluate(() => window.__td33.aborted())).toEqual([false]);

    await page.getByTestId("action-cancel").click();

    // A well-behaved executor stops on abort and rejects the DOM way: only now
    // may the UI say the request stopped.
    await expect(page.getByTestId("action-stopped")).toContainText(
      "the fork request stopped",
    );
    expect(await page.evaluate(() => window.__td33.aborted())).toEqual([true]);
    // Even a confirmed stop does not claim the source was left unchanged.
    await expect(page.getByTestId("action-stopped")).toContainText(
      "not verified unchanged",
    );
    await expect(page.getByTestId("action-canceled")).toHaveCount(0);
    await expect(page.getByTestId("action-succeeded")).toHaveCount(0);
    expect(await focusedTestId(page)).toBe("action-fork");
  });

  test("with no executor there is no cancellation channel, so no cancel is offered", async ({
    page,
  }) => {
    await page.goto(url);
    await page.evaluate(() => window.__td33.setMode("none"));
    await page.getByTestId("action-fork").click();

    await expect(page.getByTestId("action-failed")).toContainText(
      "No engine executor is connected.",
    );
    // No request is in flight, so there is nothing a cancel could reach.
    await expect(page.getByTestId("action-busy")).toHaveCount(0);
    await expect(page.getByTestId("action-cancel")).toHaveCount(0);
    expect(await page.evaluate(() => window.__td33.aborted())).toEqual([]);
  });

  test("a double activation dispatches exactly one request from each control", async ({
    page,
  }) => {
    await page.goto(url);
    // Both pointer activations land before Svelte re-renders, the worst case
    // for a double click: the reducer refuses the second, and it must never be
    // dispatched as a second request.
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="action-fork"]',
      );
      button?.click();
      button?.click();
    });
    expect(await requests(page)).toHaveLength(1);
    await expect(page.getByTestId("action-busy")).toBeVisible();

    await page.goto(url);
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="action-resume"]',
      );
      button?.click();
      button?.click();
    });
    expect(await requests(page)).toHaveLength(1);

    // The rewind confirmation is the same seam: one dialog activation, one
    // request, even when both land in the same tick.
    await page.goto(url);
    await page.getByTestId("action-rewind").click();
    await expect(page.getByTestId("rewind-dialog")).toBeVisible();
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="rewind-confirm"]',
      );
      button?.click();
      button?.click();
    });
    expect(await requests(page)).toHaveLength(1);
  });

  test("a newer draft survives both a successful and a failed result", async ({
    page,
  }) => {
    await page.goto(url);
    await page.getByTestId("action-fork").click();
    await page.getByTestId("editor").fill("newer thought");
    await page.evaluate(() => window.__td33.release());

    await expect(page.getByTestId("action-succeeded")).toContainText(
      "Fork created",
    );
    await expect(page.getByTestId("editor")).toHaveValue("newer thought");
    expect(
      (await calls(page)).filter((call) => call.name === "onRestoreDraft"),
    ).toEqual([]);

    await page.goto(url);
    await page.getByTestId("action-fork").click();
    await page.getByTestId("editor").fill("newer after failure");
    await page.evaluate(() =>
      window.__td33.fail("Engine refused after the edit."),
    );

    await expect(page.getByTestId("action-failed")).toContainText(
      "Engine refused after the edit.",
    );
    await expect(page.getByTestId("editor")).toHaveValue("newer after failure");
    expect(
      (await calls(page)).filter((call) => call.name === "onRestoreDraft"),
    ).toEqual([]);
  });

  test("resume requests the session itself and settles on success with focus returned", async ({
    page,
  }) => {
    await page.goto(url);
    await page.evaluate(() => window.__td33.setMode("succeed"));
    await page.getByTestId("action-resume").click();

    expect(await requests(page)).toEqual([
      {
        kind: "resume",
        sourceSessionId: "ses_1",
        entryId: null,
        choice: null,
      },
    ]);
    await expect(page.getByTestId("action-succeeded")).toContainText(
      "Session resumed",
    );
    await expect(page.getByTestId("editor")).toHaveValue("start draft");
    expect(await focusedTestId(page)).toBe("action-resume");
  });

  test("a failed request is honest, keeps the draft and returns focus", async ({
    page,
  }) => {
    await page.goto(url);
    await page.evaluate(() => window.__td33.setMode("fail"));
    await page.getByTestId("action-fork").click();

    await expect(page.getByTestId("action-failed")).toContainText(
      "Engine refused the request",
    );
    await expect(page.getByTestId("action-failed")).toContainText(
      "draft is preserved",
    );
    await expect(page.getByTestId("editor")).toHaveValue("start draft");
    expect(
      (await calls(page)).filter((call) => call.name === "onRestoreDraft"),
    ).toEqual([{ name: "onRestoreDraft", args: ["start draft"] }]);
    expect(await focusedTestId(page)).toBe("action-fork");
  });

  test("rewind is destructive: it confirms with the safe default and Escape cancels", async ({
    page,
  }) => {
    await page.goto(url);
    await page.getByTestId("action-rewind").click();

    await expect(page.getByTestId("rewind-dialog")).toBeVisible();
    // Nothing is requested before the confirmation.
    expect(await requests(page)).toEqual([]);
    // The non-destructive control owns the default focus.
    expect(await focusedTestId(page)).toBe("rewind-cancel");

    // C3_user_rewind limits are stated before any write.
    await expect(page.getByTestId("rewind-limits")).toContainText(
      "Shell commands and external edits are not restored.",
    );
    await expect(page.getByTestId("rewind-limits")).toContainText(
      "Prior external effects are not undoable.",
    );
    await expect(page.getByTestId("rewind-limits")).toContainText(
      "never deletes it",
    );
    // Conversation-only is the safe default and needs no TD-25 receipt.
    await expect(page.getByTestId("rewind-choice-conversation")).toBeChecked();
    await expect(page.getByTestId("rewind-choice-code")).toBeDisabled();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("rewind-dialog")).toHaveCount(0);
    // Nothing was dispatched, so this is the one case where "unchanged" is true.
    await expect(page.getByTestId("action-canceled")).toContainText(
      "Rewind canceled before anything was requested",
    );
    await expect(page.getByTestId("action-canceled")).toContainText(
      "source was left unchanged",
    );
    expect(await requests(page)).toEqual([]);
    expect(await focusedTestId(page)).toBe("action-rewind");
  });

  test("confirming a conversation rewind sends exactly the confirmed scope", async ({
    page,
  }) => {
    await page.goto(url);
    await page.evaluate(() => window.__td33.setMode("succeed"));
    await page.getByTestId("action-rewind").click();
    await page.getByTestId("rewind-confirm").click();

    expect(await requests(page)).toEqual([
      {
        kind: "rewind",
        sourceSessionId: "ses_1",
        entryId: "anchor_1",
        choice: "conversation",
      },
    ]);
    await expect(page.getByTestId("action-succeeded")).toContainText(
      "source conversation is kept as ancestry",
    );
    expect(await focusedTestId(page)).toBe("action-rewind");
  });

  test("code restore stays disabled with its reason until the receipt is admitted", async ({
    page,
  }) => {
    await page.goto(url);
    await page.getByTestId("action-rewind").click();

    await expect(page.getByTestId("rewind-choice-code")).toBeDisabled();
    await expect(page.getByTestId("rewind-choice-both")).toBeDisabled();
    await expect(page.getByTestId("rewind-choice-code-reason")).toContainText(
      "Code restore is not available yet",
    );
    await expect(page.getByTestId("rewind-code-limit")).toBeVisible();
    // The conversation choice is still confirmable.
    await expect(page.getByTestId("rewind-confirm")).toBeEnabled();

    // Once admitted, the chosen scope is what the request carries.
    await page.evaluate(() => window.__td33.setCodeRestore("ready", null));
    await page.getByTestId("rewind-choice-code").check();
    // Changing the scope must not steal focus back to the dialog default.
    expect(await focusedTestId(page)).toBe("rewind-choice-code");
    await expect(page.getByTestId("rewind-confirm")).toBeEnabled();
    await page.getByTestId("rewind-confirm").click();
    expect((await requests(page)).at(-1)).toEqual({
      kind: "rewind",
      sourceSessionId: "ses_1",
      entryId: "anchor_1",
      choice: "code",
    });
  });

  test("a rewind confirmed after the selection moved is refused, never retargeted", async ({
    page,
  }) => {
    await page.goto(url);
    await page.getByTestId("action-rewind").click();
    await page.evaluate(() => window.__td33.setSelection("b"));
    await page.getByTestId("rewind-confirm").click();

    await expect(page.getByTestId("rewind-dialog")).toBeVisible();
    await expect(page.getByTestId("rewind-blocked")).toContainText(
      "selected branch changed",
    );
    // A refused confirmation keeps focus in the open dialog.
    expect(await focusedTestId(page)).toBe("rewind-confirm");
    expect(await requests(page)).toEqual([]);

    // At rest the header follows the live selection, not the refused target.
    await page.getByTestId("rewind-cancel").click();
    await expect(page.getByTestId("fork-point")).toHaveText(
      "Fork point: ses_1 / anchor_2",
    );
  });

  test("an unavailable engine disables every action with its reason, still showing the ancestry", async ({
    page,
  }) => {
    await page.goto(url);
    await page.evaluate(() =>
      window.__td33.setEngine(
        "unavailable",
        "Session revisions are not delivered to the renderer yet.",
      ),
    );

    await expect(page.getByTestId("action-fork")).toBeDisabled();
    await expect(page.getByTestId("action-resume")).toBeDisabled();
    await expect(page.getByTestId("action-rewind")).toBeDisabled();
    await expect(page.getByTestId("action-reasons")).toContainText(
      "Session revisions are not delivered to the renderer yet.",
    );
    await expect(page.getByTestId("fork-point")).toHaveText(
      "Fork point: ses_1 / anchor_1",
    );
  });

  test("the fork position follows the tree selection and states when none is selected", async ({
    page,
  }) => {
    await page.goto(url);
    await page.evaluate(() => window.__td33.setSelection("b"));
    await expect(page.getByTestId("fork-point")).toHaveText(
      "Fork point: ses_1 / anchor_2",
    );
    await expect(page.getByTestId("fork-leaves")).toHaveText("Leaves: e3");

    await page.evaluate(() => window.__td33.setSelection("none"));
    await expect(page.getByTestId("fork-point")).toHaveText(
      "No branch selected",
    );
    await expect(page.getByTestId("action-fork")).toBeDisabled();
    await expect(page.getByTestId("action-reasons")).toContainText(
      "Select a session branch first.",
    );
  });
});
