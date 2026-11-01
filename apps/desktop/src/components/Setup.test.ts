import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Setup from "./Setup.svelte";

const mounted: object[] = [];
afterEach(() => {
  mounted.splice(0).forEach((component) => unmount(component));
  document.body.innerHTML = "";
});

function render(
  defaultOption: "base-only" | "optional-modules" | "skip-setup" = "base-only",
) {
  const target = document.createElement("div");
  document.body.append(target);
  const onSetupOption = vi.fn();
  mounted.push(
    mount(Setup, { target, props: { defaultOption, onSetupOption } }),
  );
  flushSync();
  return {
    target,
    onSetupOption,
    option: (name: string) =>
      target.querySelector<HTMLElement>(`[data-testid="setup-${name}"]`)!,
  };
}

describe("setup choices", () => {
  it.each(["base-only", "optional-modules", "skip-setup"] as const)(
    "reads the supplied %s default while retaining all choices",
    (option) => {
      const view = render(option);
      expect(view.target.querySelector("h3")?.textContent).toBe(
        option === "skip-setup" ? "Skip Setup" : "Welcome to Splyce Setup",
      );
      expect(view.option("base").textContent).toContain(
        "Continue with base only",
      );
      expect(view.option("modules").textContent).toContain(
        "Choose optional modules",
      );
      expect(view.option("skip").textContent).toContain("Skip setup");
    },
  );

  it.each([
    ["base", "base-only"],
    ["modules", "optional-modules"],
    ["skip", "skip-setup"],
  ] as const)(
    "delivers %s only to its component's callback",
    (name, option) => {
      const selected = render();
      const other = render();
      selected.option(name).click();
      expect(selected.onSetupOption).toHaveBeenCalledExactlyOnceWith({
        option,
      });
      expect(other.onSetupOption).not.toHaveBeenCalled();
    },
  );

  it.each(["Enter", " "])(
    "activates once with %j and prevents the browser default",
    (key) => {
      const view = render();
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      view.option("base").dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(view.onSetupOption).toHaveBeenCalledExactlyOnceWith({
        option: "base-only",
      });
    },
  );

  it("does not choose a setup option for unrelated keys", () => {
    const view = render();
    view
      .option("base")
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    expect(view.onSetupOption).not.toHaveBeenCalled();
  });
});
