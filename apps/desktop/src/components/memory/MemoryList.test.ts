import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { MemoryObservationRecord } from "@splyce/pi/contracts";
import { reactiveProps } from "./reactive-props.svelte";
import MemoryList from "./MemoryList.svelte";
import type { MemoryEntry, MemoryStatus } from "../../stores/memory-view";

const entry = (id: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  observation: { observationId: id } as MemoryObservationRecord,
  claim: `claim ${id}`,
  source: "session s1",
  scope: "workspace",
  locality: "local",
  state: "active",
  ...over,
});

let cmp: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = "";
});
function render(
  entries: MemoryEntry[],
  onForget = vi.fn(async () => {}),
  status: MemoryStatus = "on",
  stale = false,
) {
  cmp = mount(MemoryList, {
    target: document.body,
    props: { entries, onForget, status, stale },
  });
  flushSync();
  return onForget;
}
const q = (s: string) => document.querySelector<HTMLElement>(s);
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === name,
  )!;

describe("MemoryList", () => {
  it("shows claim, source, scope and locality for local and cloud", () => {
    render([entry("m1"), entry("m2", { locality: "hosted" })]);
    const loc = [
      ...document.querySelectorAll('[data-testid="memory-locality"]'),
    ].map((n) => n.textContent);
    expect(loc).toEqual(["Local", "Cloud (hosted)"]);
    expect(document.body.textContent).toContain("session s1");
    expect(document.body.textContent).toContain("workspace");
  });

  it("empty states are honest per status", () => {
    render([]);
    expect(q('[data-testid="memory-empty"]')!.textContent).toContain(
      "Nothing is remembered yet",
    );
    unmount(cmp!);
    document.body.innerHTML = "";
    render([entry("m1")], undefined, "off");
    expect(q('[data-testid="memory-empty"]')!.textContent).toContain(
      "Memory is off",
    );
    unmount(cmp!);
    document.body.innerHTML = "";
    render([entry("m1")], undefined, "unavailable");
    expect(q('[data-testid="memory-empty"]')!.textContent).toContain(
      "unavailable",
    );
    expect(
      document.querySelectorAll('[data-testid="memory-item"]').length,
    ).toBe(0);
  });

  it("before the first snapshot it says loading, not that nothing is remembered", () => {
    render([], undefined, "loading");

    expect(q('[data-testid="memory-loading"]')!.textContent).toContain(
      "Loading remembered items",
    );
    expect(q('[data-testid="memory-list"]')!.getAttribute("aria-busy")).toBe(
      "true",
    );
    // An unloaded list is not an empty one.
    expect(q('[data-testid="memory-empty"]')).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Nothing is remembered yet",
    );
    expect(
      document.querySelectorAll('[data-testid="memory-item"]').length,
    ).toBe(0);
  });

  it("a refresh keeps the known items visible while it is loading", () => {
    render([entry("m1")], undefined, "loading");

    expect(q('[data-testid="memory-loading"]')).not.toBeNull();
    expect(
      document.querySelectorAll('[data-testid="memory-item"]').length,
    ).toBe(1);
    expect(q('[data-testid="memory-empty"]')).toBeNull();
  });

  it("a failed load is an alert, not an empty memory", () => {
    render([], undefined, "error");

    const alert = q('[data-testid="memory-error"]')!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("could not be loaded");
    expect(q('[data-testid="memory-empty"]')).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Nothing is remembered yet",
    );
    expect(
      document.querySelectorAll('[data-testid="memory-item"]').length,
    ).toBe(0);
  });

  it("a stale list says it may be out of date and still shows its items", () => {
    render([entry("m1")], undefined, "on", true);

    expect(q('[data-testid="memory-stale"]')!.textContent).toContain(
      "out of date",
    );
    expect(
      document.querySelectorAll('[data-testid="memory-item"]').length,
    ).toBe(1);
    unmount(cmp!);
    document.body.innerHTML = "";
    render([entry("m1")]);
    expect(q('[data-testid="memory-stale"]')).toBeNull();
  });

  it("an empty stale list does not claim nothing is remembered", () => {
    render([], undefined, "on", true);

    const copy = q('[data-testid="memory-empty"]')!.textContent!;
    expect(copy).toContain("out of date");
    expect(copy).not.toContain("Nothing is remembered yet");
    expect(q('[data-testid="memory-stale"]')).toBeNull();
  });

  it("forget requires confirmation and is not called by the first click", async () => {
    const onForget = render([entry("m1")]);
    button("Forget").click();
    flushSync();
    expect(onForget).not.toHaveBeenCalled();
    expect(q('[role="alertdialog"]')).not.toBeNull();
    button("Cancel").click();
    flushSync();
    expect(onForget).not.toHaveBeenCalled();
    button("Forget").click();
    flushSync();
    button("Forget memory").click();
    await tick();
    flushSync();
    expect(onForget).toHaveBeenCalledWith("m1");
  });

  it("never claims deletion complete; only engine purge-pending shows pending", async () => {
    render([entry("m1")]);
    button("Forget").click();
    flushSync();
    button("Forget memory").click();
    await tick();
    flushSync();
    expect(q('[data-testid="memory-purge"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/deleted\.|forgotten\./i);
    expect(
      document.querySelectorAll('[data-testid="memory-item"]').length,
    ).toBe(1);
  });

  it("purge state survives remount because it comes from the engine record", () => {
    render([entry("m1", { state: "purge-pending" })]);
    unmount(cmp!);
    document.body.innerHTML = "";
    render([entry("m1", { state: "purge-pending" })]);
    expect(q('[data-testid="memory-purge"]')!.textContent).toContain(
      "Purge pending",
    );
  });

  it("double-confirm calls onForget once while pending", async () => {
    let release!: () => void;
    const onForget = vi.fn(() => new Promise<void>((r) => (release = r)));
    render([entry("m1")], onForget);
    button("Forget").click();
    flushSync();
    const confirm = button("Forget memory");
    confirm.click();
    confirm.click();
    flushSync();
    expect(onForget).toHaveBeenCalledTimes(1);
    expect((button("Forget memory") as HTMLButtonElement).disabled).toBe(true);
    release();
    await tick();
  });

  it("restores focus to the item's Forget button after cancel and after failure", async () => {
    render(
      [entry("m1")],
      vi.fn(async () => {
        throw new Error("x");
      }),
    );
    button("Forget").click();
    flushSync();
    button("Cancel").click();
    await tick();
    flushSync();
    await tick();
    await tick();
    expect(document.activeElement).toBe(button("Forget"));
    button("Forget").click();
    flushSync();
    button("Forget memory").click();
    await tick();
    await tick();
    flushSync();
    await tick();
    await tick();
    expect(document.activeElement).toBe(button("Forget"));
  });

  it("moves focus to the list when the forgotten item is gone", async () => {
    const onForget = vi.fn(async () => {});
    const props = reactiveProps({
      entries: [entry("m1")],
      onForget,
      status: "on" as MemoryStatus,
    });
    cmp = mount(MemoryList, { target: document.body, props });
    flushSync();
    button("Forget").click();
    flushSync();
    button("Forget memory").click();
    props.entries = [];
    await tick();
    await tick();
    flushSync();
    await tick();
    await tick();
    expect(document.activeElement).toBe(q('[data-testid="memory-list"]'));
  });

  it("engine purge-pending differs from active", () => {
    render([entry("m1", { state: "purge-pending" })]);
    expect(q('[data-testid="memory-purge"]')!.textContent).toContain(
      "Purge pending",
    );
  });

  it("a failed forget shows fixed copy, never the raw error, and stays forgettable", async () => {
    render(
      [entry("m1")],
      vi.fn(async () => {
        throw new Error("C:\secret\path token=abc at stack");
      }),
    );
    button("Forget").click();
    flushSync();
    button("Forget memory").click();
    await tick();
    await tick();
    flushSync();
    const t = q('[role="alert"]')!.textContent!;
    expect(t).toContain("Forget failed");
    expect(t).not.toMatch(/secret|token|stack/);
    expect(button("Forget")).toBeTruthy();
  });

  it("forget buttons have accessible names and the dialog focuses Cancel first", async () => {
    render([entry("m1")]);
    expect(button("Forget").getAttribute("aria-label")).toBe(
      "Forget: claim m1",
    );
    button("Forget").click();
    flushSync();
    expect(q('[role="alertdialog"]')!.getAttribute("aria-label")).toBe(
      "Confirm forget",
    );
    await tick();
    await tick();
    expect(document.activeElement).toBe(button("Cancel"));
  });

  it.each([
    ["resolves", true],
    ["rejects", false],
  ])(
    "a forget that %s after unmount raises no unhandled error",
    async (_name, ok) => {
      const unhandled: unknown[] = [];
      const on = (e: PromiseRejectionEvent): void => {
        unhandled.push(e.reason);
      };
      let settle!: () => void;
      let fail!: () => void;
      const onForget = vi.fn(
        () =>
          new Promise<void>((res, rej) => {
            settle = res;
            fail = () => rej(new Error("boom"));
          }),
      );
      process.on("unhandledRejection", on as never);
      render([entry("m1")], onForget);
      button("Forget").click();
      flushSync();
      button("Forget memory").click();
      unmount(cmp!);
      cmp = null;
      (ok ? settle : fail)();
      await tick();
      await tick();
      await new Promise((r) => setTimeout(r, 0));
      process.off("unhandledRejection", on as never);
      expect(unhandled).toEqual([]);
    },
  );
});
