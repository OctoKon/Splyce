import { afterEach, describe, expect, it } from "vitest";
import { createRawSnippet, mount, unmount } from "svelte";
import Shell from "./Shell.svelte";

const settle = () => new Promise((r) => setTimeout(r, 0));
const snip = (html: string) => createRawSnippet(() => ({ render: () => html }));

const mounted: object[] = [];
afterEach(() => {
  mounted.splice(0).forEach((c) => unmount(c));
  document.body.innerHTML = "";
});

function setup(width: number) {
  window.innerWidth = width;
  mounted.push(
    mount(Shell, {
      target: document.body,
      props: {
        rail: snip('<button id="in-rail">task</button>'),
        transcript: snip("<p>transcript</p>"),
        composer: snip('<textarea id="composer"></textarea>'),
        evidence: snip('<button id="in-evidence">diff</button>'),
      },
    }),
  );
  const q = (s: string) => document.querySelector<HTMLElement>(s);
  const toggle = (name: string) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === name,
    ) as HTMLButtonElement;
  const resize = async (w: number) => {
    window.innerWidth = w;
    window.dispatchEvent(new Event("resize"));
    await settle();
  };
  const press = async (key: string, shiftKey = false) => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, ctrlKey: true, shiftKey }),
    );
    await settle();
  };
  return { q, toggle, resize, press };
}

describe("TD-72 adaptive shell", () => {
  it("wide shows rail and conversation; evidence toggles in alongside", async () => {
    const s = setup(1400);
    expect(s.q("[data-layout]")!.dataset.layout).toBe("wide");
    expect(s.q("nav")).toBeTruthy();
    expect(s.q("main")).toBeTruthy();
    expect(s.q("aside")).toBeNull();
    s.toggle("Changes and evidence").click();
    await settle();
    expect(s.q("aside")).toBeTruthy();
    expect(s.q("nav")).toBeTruthy();
  });

  it("medium opens evidence by closing the rail", async () => {
    const s = setup(900);
    s.toggle("Changes and evidence").click();
    await settle();
    expect(s.q("aside")).toBeTruthy();
    expect(s.q("nav")).toBeNull();
    expect(s.q("main")).toBeTruthy();
  });

  it("narrow shows one content pane at a time, composer always present", async () => {
    const s = setup(500);
    expect(s.q("nav")).toBeNull();
    expect(s.q("main")).toBeTruthy();
    s.toggle("Projects and tasks").click();
    await settle();
    expect(s.q("nav")).toBeTruthy();
    expect(s.q("main")).toBeNull();
    expect(s.q("#composer")).toBeTruthy();
  });

  it("resize across a breakpoint reflows panels", async () => {
    const s = setup(1400);
    await s.resize(500);
    expect(s.q("nav")).toBeNull();
    expect(s.q("main")).toBeTruthy();
    await s.resize(1400);
    expect(s.q("[data-layout]")!.dataset.layout).toBe("wide");
  });

  it("Ctrl+B and Ctrl+Shift+E toggle panels and update aria-expanded", async () => {
    const s = setup(1400);
    const rail = s.toggle("Projects and tasks");
    expect(rail.getAttribute("aria-expanded")).toBe("true");
    await s.press("b");
    expect(s.q("nav")).toBeNull();
    expect(rail.getAttribute("aria-expanded")).toBe("false");
    await s.press("E", true);
    expect(s.q("aside")).toBeTruthy();
  });

  it("collapsing the pane that holds focus moves focus to its toggle", async () => {
    const s = setup(1400);
    s.q("#in-rail")!.focus();
    expect(document.activeElement!.id).toBe("in-rail");
    await s.press("b");
    await settle();
    expect(document.activeElement).toBe(s.toggle("Projects and tasks"));
  });

  it("does not steal focus when an unrelated pane collapses", async () => {
    const s = setup(1400);
    s.q("#composer")!.focus();
    await s.press("b");
    expect(document.activeElement!.id).toBe("composer");
  });

  it("resizing to narrow while focus is in the rail restores focus to the toggle", async () => {
    const s = setup(1400);
    s.q("#in-rail")!.focus();
    await s.resize(500);
    await settle();
    expect(document.activeElement).toBe(s.toggle("Projects and tasks"));
  });

  it("exposes named landmarks and toggle semantics", async () => {
    const s = setup(1400);
    s.toggle("Changes and evidence").click();
    await settle();
    expect(s.q("nav")!.getAttribute("aria-label")).toBe("Projects and tasks");
    expect(s.q("main")!.getAttribute("aria-label")).toBe("Conversation");
    expect(s.q("aside")!.getAttribute("aria-label")).toBe(
      "Changes and evidence",
    );
    expect(s.q("footer")!.getAttribute("aria-label")).toBe("Message composer");
    expect(s.q('[role="toolbar"]')!.getAttribute("aria-label")).toBe("Panels");
    for (const name of ["Projects and tasks", "Changes and evidence"]) {
      const b = s.toggle(name);
      expect(b.getAttribute("aria-controls")).toBeTruthy();
      expect(b.getAttribute("aria-keyshortcuts")).toBeTruthy();
    }
  });
});
