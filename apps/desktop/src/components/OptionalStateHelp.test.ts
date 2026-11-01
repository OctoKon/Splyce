import { afterEach, describe, expect, it } from "vitest";
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import OptionalStateHelp, {
  OPTIONAL_STATES,
  optionalStateCopy,
  type OptionalState,
} from "./OptionalStateHelp.svelte";

let cmp: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = "";
});

function render(props: {
  state: OptionalState;
  feature?: string;
  action?: unknown;
}) {
  // Each call is a fresh mount: a loop must not read the previous instance.
  if (cmp) unmount(cmp);
  document.body.innerHTML = "";
  cmp = mount(OptionalStateHelp, {
    target: document.body,
    props: props as never,
  });
  flushSync();
  return document.body;
}

const group = () =>
  document.querySelector<HTMLElement>('[data-testid="optional-state-help"]')!;
const heading = () => group().querySelector("h3")!;
const text = () => group().textContent?.replace(/\s+/g, " ").trim() ?? "";

/** Text a sighted user can read: aria-hidden decoration does not count. */
function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true")
    return "";
  return [...node.childNodes].map(visibleText).join(" ");
}

describe("optionalStateCopy", () => {
  it("gives every fixed state its own readable label and explanation", () => {
    const labels = new Set<string>();
    const details = new Set<string>();
    for (const state of OPTIONAL_STATES) {
      const copy = optionalStateCopy(state);
      expect(copy.label.length).toBeGreaterThan(3);
      expect(copy.detail.length).toBeGreaterThan(20);
      labels.add(copy.label);
      details.add(copy.detail);
    }
    // Four distinct explanations: a shared fallback would hide which state applies.
    expect(labels.size).toBe(OPTIONAL_STATES.length);
    expect(details.size).toBe(OPTIONAL_STATES.length);
  });

  it("never claims the optional feature is ready, available or running", () => {
    for (const state of OPTIONAL_STATES) {
      const copy = optionalStateCopy(state);
      const all = `${copy.label} ${copy.detail}`.toLowerCase();
      expect(all).not.toContain("ready");
      expect(all).not.toContain("is available");
      expect(all).not.toContain("enabled by default");
      expect(all).not.toContain("will install");
      expect(all).not.toContain("will download");
    }
  });

  it("degrades unknown input to a plain unavailable explanation", () => {
    for (const raw of [undefined, null, "", "Ready", "bogus", 1, {}]) {
      const copy = optionalStateCopy(raw);
      expect(copy.label).toBe("Unavailable");
      expect(copy.label.toLowerCase()).not.toContain("ready");
    }
  });
});

describe("OptionalStateHelp", () => {
  it("states the condition in text, not colour alone, for every state", () => {
    for (const state of OPTIONAL_STATES) {
      render({ state });
      const copy = optionalStateCopy(state);
      expect(group().getAttribute("data-state")).toBe(state);
      // Visible text carries the condition: removing colour changes nothing.
      expect(heading().textContent?.trim()).toBe(copy.label);
      expect(visibleText(group()).replace(/\s+/g, " ")).toContain(copy.label);
      expect(text()).toContain(copy.detail);
      // The glyph is decoration only, so it cannot be the sole signal.
      expect(group().querySelector('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it("names the group with the condition so assistive tech reads the state", () => {
    render({ state: "missing" });
    const label = group().getAttribute("aria-label") ?? "";
    expect(label).toContain(optionalStateCopy("missing").label);
  });

  it("renders no control of its own: help text never acts", () => {
    render({ state: "off" });
    expect(
      group().querySelectorAll("button, a[href], input, select, textarea")
        .length,
    ).toBe(0);
  });

  it("only shows an action when the parent supplies one", () => {
    const action = createRawSnippet(() => ({
      render: () => `<button type="button">Open setup</button>`,
    }));
    render({ state: "missing", action });
    const buttons = [...group().querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Open setup"]);
  });

  it("mentions the optional feature when the caller names it", () => {
    render({ state: "cancelled", feature: "Monaco editor" });
    expect(text()).toContain("Monaco editor");
  });

  it("does not print a feature line when the caller omits it", () => {
    render({ state: "unsupported" });
    expect(text()).not.toContain("Optional feature");
  });
});
