import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Modules from "./Modules.svelte";
import {
  d1BaseSetup,
  engineUnavailable,
  w10Modules,
  w10ReadyForEnable,
} from "../../tests/td29/fixtures";

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = "";
});

async function render(props: Record<string, unknown>): Promise<void> {
  app = mount(Modules, {
    target: document.body,
    props: props as never,
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

const row = (packageId: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="module-row"][data-package-id="${packageId}"]`,
  );
  if (!element) throw new Error(`missing row ${packageId}`);
  return element;
};

const rowButton = (packageId: string, testId: string): HTMLButtonElement => {
  const element = row(packageId).querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`missing ${testId} for ${packageId}`);
  return element;
};

async function openDialog(testId: string, packageId: string): Promise<void> {
  rowButton(packageId, testId).click();
  flushSync();
  await tick();
  flushSync();
}

describe("TD-29 Modules.svelte", () => {
  it("FUI-W10: keeps installed, requested, effective, shared and retained state distinct", async () => {
    await render({ snapshot: w10Modules });

    expect(document.querySelectorAll('[data-testid="module-row"]').length).toBe(
      3,
    );
    const a = row("fixture-a");
    expect(a.querySelector('[data-testid="row-effective"]')?.textContent).toBe(
      "Off",
    );
    expect(a.textContent).toContain("Off requested");
    expect(
      a.querySelector('[data-testid="shared-deps"]')?.textContent,
    ).toContain("fixture-d");
    expect(
      a.querySelector('[data-testid="retained-data"]')?.textContent,
    ).toContain("fixture-a notes");
    expect(a.textContent).toContain("Installed");

    const cleanup = row("fixture-cleanup");
    expect(cleanup.textContent).toContain("Cleanup incomplete");
    expect(rowButton("fixture-cleanup", "delete-data").disabled).toBe(true);
    // Uninstall is not offered as a way to delete data.
    expect(rowButton("fixture-a", "uninstall-module").disabled).toBe(false);
    expect(rowButton("fixture-a", "delete-data").disabled).toBe(false);
    expect(rowButton("fixture-d", "uninstall-module").disabled).toBe(true);
    expect(row("fixture-d").textContent).toContain("Required by fixture-a");
  });

  it("FUI-W10: blocks enable until the shared dependency is enabled and ready", async () => {
    await render({ snapshot: w10Modules });
    const enable = rowButton("fixture-a", "enable-module");
    expect(enable.disabled).toBe(true);
    expect(row("fixture-a").textContent).toContain(
      "Enable dependencies separately first",
    );
    expect(row("fixture-a").textContent).toContain("fixture-d");

    if (app) unmount(app);
    app = null;
    document.body.innerHTML = "";

    await render({ snapshot: w10ReadyForEnable });
    expect(rowButton("fixture-a", "enable-module").disabled).toBe(false);
    expect(rowButton("fixture-d", "disable-module").disabled).toBe(false);
  });

  it("opens a dialog with focus inside and restores the opener on Escape", async () => {
    const onUninstall = vi.fn();
    await render({ snapshot: w10Modules, onUninstall });

    const opener = rowButton("fixture-a", "uninstall-module");
    opener.focus();
    await openDialog("uninstall-module", "fixture-a");

    const dialog = byTestId("module-dialog");
    expect(dialog.dataset.kind).toBe("uninstall");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.textContent).toContain("Kept after uninstall");
    expect(dialog.textContent).toContain("fixture-a notes");

    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    flushSync();
    await tick();
    flushSync();

    expect(maybeTestId("module-dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onUninstall).not.toHaveBeenCalled();
  });

  it("uninstalls owned code without deleting retained data", async () => {
    const onUninstall = vi.fn();
    const onDeleteData = vi.fn();
    await render({ snapshot: w10Modules, onUninstall, onDeleteData });

    await openDialog("uninstall-module", "fixture-a");
    const confirm = byTestId("dialog-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    confirm.click();
    flushSync();

    expect(onUninstall).toHaveBeenCalledWith("fixture-a");
    expect(onDeleteData).not.toHaveBeenCalled();
    expect(maybeTestId("module-dialog")).toBeNull();
  });

  it("deletes retained data only as its own scoped action", async () => {
    const onUninstall = vi.fn();
    const onDeleteData = vi.fn();
    await render({ snapshot: w10Modules, onUninstall, onDeleteData });

    await openDialog("delete-data", "fixture-a");
    const dialog = byTestId("module-dialog");
    expect(dialog.dataset.kind).toBe("delete-data");
    expect(dialog.textContent).toContain("does not uninstall package code");

    (byTestId("dialog-confirm") as HTMLButtonElement).click();
    flushSync();

    expect(onDeleteData).toHaveBeenCalledWith("fixture-a");
    expect(onUninstall).not.toHaveBeenCalled();
  });

  it("starts the add flow with an empty selection and hands roots to review", async () => {
    const onAdd = vi.fn();
    await render({ snapshot: w10Modules, onAdd });

    (byTestId("add-module") as HTMLButtonElement).click();
    flushSync();
    await tick();
    flushSync();

    const dialog = byTestId("module-dialog");
    expect(dialog.dataset.kind).toBe("add");
    const boxes = [
      ...dialog.querySelectorAll<HTMLInputElement>(
        '[data-testid="add-option"] input',
      ),
    ];
    expect(boxes.length).toBe(3);
    expect(boxes.every((box) => !box.checked)).toBe(true);
    expect((byTestId("dialog-review-add") as HTMLButtonElement).disabled).toBe(
      true,
    );

    const a = dialog.querySelector<HTMLInputElement>(
      '[data-testid="add-option"][data-package-id="fixture-a"] input',
    )!;
    a.click();
    flushSync();
    (byTestId("dialog-review-add") as HTMLButtonElement).click();
    flushSync();

    expect(onAdd).toHaveBeenCalledWith(["fixture-a"]);
  });

  it("traps Tab inside the dialog", async () => {
    await render({ snapshot: w10Modules });
    await openDialog("uninstall-module", "fixture-a");

    const dialog = byTestId("module-dialog");
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      ),
    ];
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    last.focus();
    last.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    flushSync();
    expect(document.activeElement).toBe(first);

    first.focus();
    first.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }),
    );
    flushSync();
    expect(document.activeElement).toBe(last);
  });

  it("disables every effect with no engine and never calls back", async () => {
    const handlers = {
      onRefreshCatalog: vi.fn(),
      onAdd: vi.fn(),
      onEnable: vi.fn(),
      onDisable: vi.fn(),
      onUninstall: vi.fn(),
      onDeleteData: vi.fn(),
    };
    await render({ snapshot: engineUnavailable, ...handlers });

    expect(byTestId("modules-engine-unavailable").textContent).toContain(
      "Engine process exited.",
    );
    expect((byTestId("add-module") as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId("refresh-catalog") as HTMLButtonElement).disabled).toBe(
      true,
    );
    for (const packageId of ["fixture-a", "fixture-d", "fixture-cleanup"]) {
      for (const testId of [
        "enable-module",
        "disable-module",
        "uninstall-module",
        "delete-data",
      ]) {
        expect(
          rowButton(packageId, testId).disabled,
          `${packageId} ${testId}`,
        ).toBe(true);
      }
    }

    (byTestId("add-module") as HTMLButtonElement).click();
    (byTestId("refresh-catalog") as HTMLButtonElement).click();
    rowButton("fixture-a", "uninstall-module").click();
    flushSync();

    for (const handler of Object.values(handlers)) {
      expect(handler).not.toHaveBeenCalled();
    }
    expect(maybeTestId("module-dialog")).toBeNull();
  });

  it("reports an operation outcome honestly and never offers an unreconciled retry", async () => {
    const onRetryOperation = vi.fn();
    await render({ snapshot: w10Modules, onRetryOperation });

    const outcome = byTestId("modules-operation-outcome");
    expect(outcome.dataset.tone).toBe("positive");
    expect(outcome.textContent).toContain("Uninstalled");
    const retry = byTestId("modules-retry-operation") as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    retry.click();
    flushSync();
    expect(onRetryOperation).not.toHaveBeenCalled();
  });

  it("keeps installed modules manageable while the catalog is offline", async () => {
    await render({ snapshot: d1BaseSetup });

    expect(byTestId("modules-empty").textContent).toContain("base is complete");
    expect((byTestId("add-module") as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId("modules-catalog-unavailable").textContent).toContain(
      "Catalog unavailable",
    );
    // Generation is still honestly unconfigured; install does not imply it.
    expect(byTestId("modules-generation").textContent).toContain(
      "Generation unconfigured",
    );
    expect(byTestId("modules-generation-note").textContent).toContain(
      "does not configure generation",
    );
  });

  it("TD-68: explains a switched-off module in text and adds no control", async () => {
    await render({ snapshot: w10Modules });

    const help = row("fixture-a").querySelector<HTMLElement>(
      '[data-testid="optional-state-help"]',
    );
    expect(help).not.toBeNull();
    expect(help!.getAttribute("data-state")).toBe("off");
    expect(help!.getAttribute("aria-label")).toContain("Switched off");
    expect(help!.textContent).toContain("Switched off");
    // The glyph is decoration; the condition is readable text.
    expect(help!.querySelector('[aria-hidden="true"]')).not.toBeNull();
    // Help never acts: every control in the row belongs to the module itself.
    expect(
      help!.querySelectorAll("button, a[href], input, select, textarea").length,
    ).toBe(0);
    expect(help!.textContent).toContain("Fixture editor A");
  });

  it("TD-68: stays silent for a module that is installed and ready", async () => {
    await render({ snapshot: w10ReadyForEnable });

    expect(
      row("fixture-d").querySelector('[data-testid="optional-state-help"]'),
    ).toBeNull();
    // A is still off, so silence is per-row, not global.
    expect(
      row("fixture-a").querySelector('[data-testid="optional-state-help"]'),
    ).not.toBeNull();
  });

  it("TD-68: calls an incompatible catalog option unsupported, not a choice", async () => {
    const snapshot = {
      ...w10Modules,
      entries: w10Modules.entries.map((entry) =>
        entry.packageId === "fixture-cleanup"
          ? { ...entry, incompatibleReason: "requires Windows 11 24H2" }
          : entry,
      ),
    };
    await render({ snapshot });

    (byTestId("add-module") as HTMLButtonElement).click();
    flushSync();

    const option = document.querySelector<HTMLElement>(
      '[data-testid="add-option"][data-package-id="fixture-cleanup"]',
    )!;
    const help = option.querySelector<HTMLElement>(
      '[data-testid="optional-state-help"]',
    );
    expect(help).not.toBeNull();
    expect(help!.getAttribute("data-state")).toBe("unsupported");
    expect(help!.textContent).toContain("Not supported on this computer");
    expect(
      option.querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .disabled,
    ).toBe(true);
    // A compatible option gets no unsupported claim.
    expect(
      document.querySelector(
        '[data-testid="add-option"][data-package-id="fixture-a"] [data-testid="optional-state-help"]',
      ),
    ).toBeNull();
  });
});
