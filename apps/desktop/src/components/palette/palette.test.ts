import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandHandler } from "../../stores/commands";
import PaletteHost from "./PaletteHost.svelte";
import ShortcutReference from "../help/ShortcutReference.svelte";
import HelpPanel from "../help/HelpPanel.svelte";
import SettingsView from "../settings/SettingsView.svelte";
import { CATALOG } from "../../stores/commands";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  document.body.innerHTML = "";
});

function setup(handlers: Record<string, CommandHandler> = {}) {
  const opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.append(opener);
  opener.focus();
  const app = mount(PaletteHost, {
    target: document.body,
    props: { handlers, scopeLabel: "Workspace: demo" },
  });
  cleanup = () => unmount(app);
  return { opener };
}

async function openIt(_s: ReturnType<typeof setup>) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true }),
  );
  flushSync();
  await tick();
  await Promise.resolve();
}

const input = () =>
  document.querySelector<HTMLInputElement>('[role="combobox"]')!;
const options = () => [
  ...document.querySelectorAll<HTMLElement>('[role="option"]'),
];
const press = (k: string, init: KeyboardEventInit = {}) => {
  input().dispatchEvent(
    new KeyboardEvent("keydown", {
      key: k,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  flushSync();
};

describe("command palette", () => {
  it("exposes dialog/combobox/listbox/option roles with accessible names", async () => {
    const s = setup({ "landmark.rail": { run: () => {} } });
    await openIt(s);
    expect(
      document.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
    ).toBe("Command palette");
    expect(input().getAttribute("aria-label")).toBe("Search commands");
    expect(
      document.querySelector('[role="listbox"]')?.getAttribute("aria-label"),
    ).toBe("Commands");
    expect(options().length).toBeGreaterThan(0);
    expect(input().getAttribute("aria-activedescendant")).toBe(
      options()[0]!.id,
    );
    expect(document.body.textContent).toContain("Workspace: demo");
    expect(document.activeElement).toBe(input());
  });

  it("filters, arrow-navigates and Enter runs the selected command then restores focus", async () => {
    const run = vi.fn();
    const s = setup({
      "landmark.transcript": { run },
      "landmark.rail": { run: () => {} },
    });
    await openIt(s);
    input().value = "transcript";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(options()).toHaveLength(1);
    press("ArrowDown");
    press("ArrowUp");
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    press("Enter");
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(s.opener);
  });

  it("ArrowDown moves selection", async () => {
    const s = setup({
      "landmark.rail": { run: () => {} },
      "landmark.transcript": { run: () => {} },
    });
    await openIt(s);
    press("ArrowDown");
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("Escape closes and restores focus to the exact opener", async () => {
    const s = setup();
    await openIt(s);
    press("Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(s.opener);
  });

  it("disabled commands show their reason, are aria-disabled and Enter does not run or close", async () => {
    const run = vi.fn();
    const s = setup({
      "landmark.rail": { run, unavailable: () => "No workspace selected" },
    });
    await openIt(s);
    const first = options()[0]!;
    expect(first.getAttribute("aria-disabled")).toBe("true");
    expect(first.textContent).toContain("No workspace selected");
    press("Enter");
    await Promise.resolve();
    await tick();
    expect(run).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("No workspace selected");
  });

  it("Enter during IME composition does not run", async () => {
    const run = vi.fn();
    const s = setup({ "landmark.rail": { run } });
    await openIt(s);
    press("Enter", { isComposing: true });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it("shows a labelled empty state", async () => {
    const s = setup();
    await openIt(s);
    input().value = "qqqqq";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(document.body.textContent).toContain("No matching commands");
  });
});

describe("shortcut reference (TD-77)", () => {
  it("lists exactly the registry catalog bindings, no more, no less", () => {
    const app = mount(ShortcutReference, { target: document.body });
    cleanup = () => unmount(app);
    flushSync();
    const shown = [...document.querySelectorAll("tbody tr")].map((r) => [
      r.children[0]!.textContent,
      [...r.querySelectorAll("kbd")].map((k) => k.textContent),
    ]);
    expect(shown.sort()).toEqual(
      CATALOG.map((c) => [c.label, [...c.shortcuts]]).sort(),
    );
    expect(
      document.querySelectorAll("table[aria-label]").length,
    ).toBeGreaterThan(1);
  });

  it("filter narrows rows and never dispatches keys", () => {
    const app = mount(ShortcutReference, { target: document.body });
    cleanup = () => unmount(app);
    const q = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search shortcuts"]',
    )!;
    q.value = "palette";
    q.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(
      [...document.querySelectorAll("tbody tr")].map((r) => r.textContent),
    ).toEqual([expect.stringContaining("Ctrl+K")]);
  });
});

describe("settings and help (TD-57)", () => {
  it("settings is read-only, labelled, states missing values honestly and links help", () => {
    const back = vi.fn();
    const app = mount(SettingsView, {
      target: document.body,
      props: {
        onBack: back,
        sections: [
          {
            id: "engine",
            title: "Engine",
            helpTopic: "start",
            items: [
              { label: "Connection", value: "ready" },
              { label: "Theme" },
            ],
          },
        ],
      },
    });
    cleanup = () => unmount(app);
    expect(
      document.querySelector("main")?.getAttribute("aria-labelledby"),
    ).toBe("settings-title");
    expect(document.querySelectorAll("input, select, textarea")).toHaveLength(
      0,
    );
    expect(document.body.textContent).toContain("Not configurable yet");
    expect(document.querySelector("a")?.getAttribute("href")).toBe(
      "#help-start",
    );
    document.querySelector("button")!.click();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("help topic links resolve to sections and include the shortcut reference", () => {
    const app = mount(HelpPanel, {
      target: document.body,
      props: { onBack: () => {} },
    });
    cleanup = () => unmount(app);
    for (const a of document.querySelectorAll<HTMLAnchorElement>("nav a")) {
      const id = a.getAttribute("href")!.slice(1);
      expect(document.getElementById(id), id).not.toBeNull();
    }
    expect(
      document.querySelector('nav[aria-label="Help topics"]'),
    ).not.toBeNull();
  });
});

describe("palette key path failures", () => {
  it("a throwing shortcut handler is shown as an alert and the app stays usable", async () => {
    const s = setup({
      "landmark.rail": {
        run: () => {
          throw new Error("rail exploded");
        },
      },
    });
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "1",
        ctrlKey: true,
        cancelable: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "rail exploded",
    );
    await openIt(s);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
