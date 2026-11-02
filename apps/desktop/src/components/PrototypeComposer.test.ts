import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import Composer from "../../prototype/src/lib/Composer.svelte";

const mounted: object[] = [];
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((component) => unmount(component)));
  document.body.innerHTML = "";
});

function setup() {
  const send = vi.fn();
  mounted.push(
    mount(Composer, {
      target: document.body,
      props: { value: "にほん", onsend: send },
    }),
  );
  flushSync();
  const input = document.querySelector("textarea")!;
  const key = (init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...init,
    });
    input.dispatchEvent(event);
    return event;
  };
  return { input, key, send };
}

// Synthetic events cover dispatch guards; real Windows IME qualification is separate.
describe("prototype composer keyboard dispatch", () => {
  it.each([
    ["isComposing", { isComposing: true }],
    ["legacy keyCode 229", { keyCode: 229 }],
  ] as const)(
    "does not submit candidate confirmation with %s",
    async (_, init) => {
      const c = setup();
      const event = c.key(init);
      await tick();
      expect(c.send).not.toHaveBeenCalled();
      expect(c.input.value).toBe("にほん");
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it("tracks composition until compositionend even without keyboard flags", async () => {
    const c = setup();
    c.input.dispatchEvent(new CompositionEvent("compositionstart"));
    const confirmation = c.key();
    await tick();
    expect(c.send).not.toHaveBeenCalled();
    expect(c.input.value).toBe("にほん");
    expect(confirmation.defaultPrevented).toBe(false);

    c.input.dispatchEvent(new CompositionEvent("compositionend"));
    c.key();
    await tick();
    expect(c.send).toHaveBeenCalledExactlyOnceWith("にほん");
    expect(c.input.value).toBe("");
  });

  it("still sends and clears the draft on ordinary Enter", async () => {
    const c = setup();
    const event = c.key();
    await tick();
    expect(c.send).toHaveBeenCalledExactlyOnceWith("にほん");
    expect(c.input.value).toBe("");
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves Shift+Enter available for a newline without submitting", async () => {
    const c = setup();
    const event = c.key({ shiftKey: true });
    await tick();
    expect(c.send).not.toHaveBeenCalled();
    expect(c.input.value).toBe("にほん");
    expect(event.defaultPrevented).toBe(false);
  });
});
