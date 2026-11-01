import { afterEach, describe, expect, it } from "vitest";
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import ThemeSpecimen from "./ThemeSpecimen.svelte";
import StateMessage, { STATE_KINDS } from "./StateMessage.svelte";
import StateSpecimen from "./StateSpecimen.svelte";
import {
  CONCRETE_THEMES,
  CONTRAST_PAIRS,
  TOKENS,
  TOKEN_NAMES,
  contrastRatio,
  resolveTheme,
} from "./tokens";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const FORCED_QUERY = "(forced-colors: active)";
type MediaListener = (event: MediaQueryListEvent) => void;

function mockMedia(initial: { dark: boolean; forced: boolean }) {
  const original = window.matchMedia;
  const listeners = new Map<string, Set<MediaListener>>();
  const fake = (query: string): MediaQueryList => {
    const set = listeners.get(query) ?? new Set<MediaListener>();
    listeners.set(query, set);
    return {
      matches: query === DARK_QUERY ? initial.dark : initial.forced,
      media: query,
      onchange: null,
      addEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject | null,
      ) => {
        if (typeof listener === "function") set.add(listener as MediaListener);
      },
      removeEventListener: (
        _type: string,
        listener: EventListenerOrEventListenerObject | null,
      ) => {
        if (typeof listener === "function")
          set.delete(listener as MediaListener);
      },
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
  };
  window.matchMedia = fake;
  return {
    emit(query: string, matches: boolean) {
      for (const listener of listeners.get(query) ?? []) {
        listener({ matches, media: query } as MediaQueryListEvent);
      }
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

const mounted: object[] = [];
function render(c: unknown, props: Record<string, unknown>) {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(c as never, { target, props: props as never }));
  flushSync();
  return target;
}
afterEach(() => {
  mounted.splice(0).forEach((c) => unmount(c));
  document.body.innerHTML = "";
});

describe("TD-75 theme specimens", () => {
  it("every token pair meets its contrast minimum in every theme", () => {
    for (const theme of CONCRETE_THEMES)
      for (const p of CONTRAST_PAIRS)
        expect(
          contrastRatio(TOKENS[theme][p.fg], TOKENS[theme][p.bg]),
          `${theme} ${p.fg}/${p.bg}`,
        ).toBeGreaterThanOrEqual(p.min);
  });

  it("contrast function is correct and rejects bad colours", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(() => contrastRatio("red", "#fff")).toThrow();
  });

  it("renders every token in every theme with passing text results", () => {
    for (const theme of CONCRETE_THEMES) {
      const t = render(ThemeSpecimen, { theme });
      for (const name of TOKEN_NAMES) {
        const li = t.querySelector(`[data-token=${name}]`);
        expect(li, `${theme} ${name}`).not.toBeNull();
        expect(li!.textContent).toContain(TOKENS[theme][name]);
      }
      const rows = t.querySelectorAll("tbody tr");
      expect(rows.length).toBe(CONTRAST_PAIRS.length);
      rows.forEach((r) => expect(r.textContent).toContain("Pass"));
    }
  });

  it("resolves system from the OS preference, with forced colors winning", () => {
    expect(resolveTheme("system", { prefersDark: true })).toBe("dark");
    expect(resolveTheme("system", { prefersDark: false })).toBe("light");
    expect(
      resolveTheme("system", { prefersDark: true, forcedColors: true }),
    ).toBe("high-contrast");
    expect(resolveTheme("light", { prefersDark: true })).toBe("light");
    expect(resolveTheme("light", { forcedColors: true })).toBe("high-contrast");
  });

  it("renders the resolved system sheet", () => {
    const dark = render(ThemeSpecimen, { theme: "system", prefersDark: true });
    const darkSection = dark.querySelector("[data-testid=theme-specimen]")!;
    expect(darkSection.getAttribute("data-resolved-theme")).toBe("dark");
    expect(dark.textContent).toContain(TOKENS.dark.surface);
    expect(dark.textContent).toContain("system (dark)");

    const hc = render(ThemeSpecimen, {
      theme: "system",
      prefersDark: false,
      forcedColors: true,
    });
    const hcSection = hc.querySelector("[data-testid=theme-specimen]")!;
    expect(hcSection.getAttribute("data-resolved-theme")).toBe("high-contrast");
    expect(hc.textContent).toContain(TOKENS["high-contrast"].selection);
    expect(hc.textContent).toContain("system (high-contrast)");
  });

  it("follows live system preference and forced-colors changes", () => {
    const media = mockMedia({ dark: false, forced: false });
    try {
      const t = render(ThemeSpecimen, { theme: "system" });
      const section = () => t.querySelector("[data-testid=theme-specimen]")!;
      expect(section().getAttribute("data-resolved-theme")).toBe("light");

      media.emit(DARK_QUERY, true);
      flushSync();
      expect(section().getAttribute("data-resolved-theme")).toBe("dark");
      expect(t.textContent).toContain("system (dark)");

      media.emit(FORCED_QUERY, true);
      flushSync();
      expect(section().getAttribute("data-resolved-theme")).toBe(
        "high-contrast",
      );
      expect(t.textContent).toContain("system (high-contrast)");

      media.emit(FORCED_QUERY, false);
      flushSync();
      expect(section().getAttribute("data-resolved-theme")).toBe("dark");
    } finally {
      media.restore();
    }
  });

  it("status samples carry glyph and text, not colour alone", () => {
    const t = render(ThemeSpecimen, { theme: "dark" });
    const chips = [...t.querySelectorAll(".chip")].map((c) => c.textContent);
    expect(chips).toEqual(["✕ Failed", "? Uncertain", "✓ Completed"]);
  });
});

describe("TD-76 state specimens", () => {
  it("renders every state distinguishable by text", () => {
    const t = render(StateSpecimen, {});
    const kinds = [...t.querySelectorAll("[data-testid=state-kind]")].map(
      (e) => e.textContent,
    );
    expect(kinds).toEqual([
      "Loading",
      "Nothing here yet",
      "Error",
      "Out of date",
      "Unavailable",
    ]);
    expect(new Set(kinds).size).toBe(STATE_KINDS.length);
  });

  it("error is an alert, loading is busy, others are status", () => {
    const t = render(StateSpecimen, {});
    const by = (k: string) => t.querySelector(`[data-kind=${k}]`)!;
    expect(by("error").getAttribute("role")).toBe("alert");
    expect(by("loading").getAttribute("aria-busy")).toBe("true");
    expect(by("empty").getAttribute("role")).toBe("status");
    expect(by("empty").hasAttribute("aria-busy")).toBe(false);
  });

  it("is inert: no buttons unless the parent supplies an action slot", () => {
    expect(render(StateSpecimen, {}).querySelector("button")).toBeNull();
    const action = createRawSnippet(() => ({
      render: () => "<button>Retry</button>",
    }));
    const t = render(StateMessage, { kind: "error", title: "x", action });
    expect(t.querySelector(".action button")!.textContent).toBe("Retry");
  });

  it("long text wraps without being truncated", () => {
    const long = "a".repeat(500);
    const t = render(StateMessage, {
      kind: "unavailable",
      title: long,
      detail: long,
    });
    expect(t.querySelector(".title")!.textContent).toBe(long);
    expect(t.querySelector(".detail")!.textContent).toBe(long);
  });
});
