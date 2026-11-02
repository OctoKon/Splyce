import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptPayload } from "../stores/composer";
import type { EngineConnectionState } from "../stores/engine";
import Composer from "./Composer.svelte";

type Props = {
  connection: EngineConnectionState;
  sessionId: string | null;
  stale?: boolean;
  generationReady?: boolean;
  workspaceSelected?: boolean;
  profileSelected?: boolean;
  sessionReadiness?: "ready" | "unavailable";
  cancellable?: boolean;
  contextArtifactIds?: string[];
  send: (p: PromptPayload) => Promise<void>;
  cancel?: () => void;
};

const mounted: object[] = [];
afterEach(() => {
  mounted.splice(0).forEach((c) => unmount(c));
  document.body.innerHTML = "";
});

function setup(over: Partial<Props> = {}) {
  const send = vi.fn(async (_p: PromptPayload) => {});
  const cancel = vi.fn();
  const props: Props = {
    connection: "ready",
    sessionId: "ses_1",
    // Default the harness to an enabled composer; the fail-closed cases opt in
    // to generationReady: false explicitly.
    generationReady: true,
    workspaceSelected: true,
    profileSelected: true,
    sessionReadiness: "ready",
    send,
    cancel,
    ...over,
  };
  mounted.push(mount(Composer, { target: document.body, props }));
  const ta = document.querySelector("textarea")!;
  const sendBtn = () =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Send",
    )!;
  const type = (value: string) => {
    ta.value = value;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
  };
  const key = (init: KeyboardEventInit & { keyCode?: number }) => {
    const e = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    ta.dispatchEvent(e);
    return e;
  };
  const status = () => document.getElementById("composer-status")!.textContent!;
  return { ta, sendBtn, type, key, status, send, cancel };
}

describe("TD-71 composer", () => {
  it("Enter sends a typed session.prompt payload and clears the draft", async () => {
    const c = setup();
    c.type("hello");
    const e = c.key({ key: "Enter" });
    await tick();
    await tick();
    expect(e.defaultPrevented).toBe(true);
    expect(c.send).toHaveBeenCalledExactlyOnceWith({ text: "hello" });
    expect(c.ta.value).toBe("");
  });

  it("preserves newer draft text when a delayed send succeeds", async () => {
    let release!: () => void;
    const send = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const c = setup({ send });
    c.type("submitted task");
    c.key({ key: "Enter" });
    await tick();
    expect(send).toHaveBeenCalledExactlyOnceWith({ text: "submitted task" });
    c.type("newer task written while waiting");
    expect(c.sendBtn().disabled).toBe(true);
    release();
    await tick();
    await tick();
    expect(c.ta.value).toBe("newer task written while waiting");
    expect(send).toHaveBeenCalledOnce();
  });

  it("includes context artifact ids in the payload", async () => {
    const c = setup({ contextArtifactIds: ["art_1"] });
    c.type("x");
    c.key({ key: "Enter" });
    await tick();
    expect(c.send).toHaveBeenCalledWith({
      text: "x",
      contextArtifactIds: ["art_1"],
    });
  });

  it("Shift+Enter inserts a newline instead of sending", async () => {
    const c = setup();
    c.type("a");
    const e = c.key({ key: "Enter", shiftKey: true });
    await tick();
    expect(e.defaultPrevented).toBe(false);
    expect(c.send).not.toHaveBeenCalled();
  });

  it("never sends empty or whitespace-only text", async () => {
    const c = setup();
    c.type("  \n ");
    c.key({ key: "Enter" });
    c.sendBtn().click();
    await tick();
    expect(c.send).not.toHaveBeenCalled();
    expect(c.sendBtn().disabled).toBe(true);
  });

  it("does not send while an IME composition is active", async () => {
    const c = setup();
    c.type("にほん");
    c.key({ key: "Enter", isComposing: true });
    c.key({ key: "Enter", keyCode: 229 });
    c.ta.dispatchEvent(new CompositionEvent("compositionstart"));
    c.key({ key: "Enter" });
    await tick();
    expect(c.send).not.toHaveBeenCalled();
    c.ta.dispatchEvent(new CompositionEvent("compositionend"));
    c.key({ key: "Enter" });
    await tick();
    expect(c.send).toHaveBeenCalledOnce();
  });

  it("prevents a double-send while the first is pending", async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<void>((r) => (release = r)));
    const c = setup({ send });
    c.type("once");
    c.key({ key: "Enter" });
    c.key({ key: "Enter" });
    c.sendBtn().click();
    await tick();
    expect(send).toHaveBeenCalledOnce();
    expect(c.status()).toContain("Sending");
    release();
    await tick();
    await tick();
    expect(c.ta.value).toBe("");
  });

  it("keeps the draft and shows honest fixed copy when send fails", async () => {
    const c = setup({
      send: vi.fn(async () => {
        throw new Error("engine said no");
      }),
    });
    c.type("keep me");
    c.key({ key: "Enter" });
    await tick();
    await tick();
    expect(c.ta.value).toBe("keep me");
    // Behaviour change (TD-71): the rejection text is no longer echoed, so this
    // asserts the fixed copy instead of the raw message it used to show.
    expect(c.status()).toContain("may not have reached");
    expect(c.status()).not.toContain("engine said no");
  });

  it("blocks send with the contract copy when generation is unconfigured", async () => {
    const c = setup({ generationReady: false });
    c.type("hi");
    c.key({ key: "Enter" });
    await tick();
    expect(c.send).not.toHaveBeenCalled();
    expect(c.status()).toContain("Generation unconfigured");
    expect(c.sendBtn().disabled).toBe(true);
  });

  it("never claims generation is unconfigured before the engine reports it", async () => {
    // Undefined is "not reported", not "not configured". Telling a user to
    // connect a provider when a provider is connected is a false statement.
    const c = setup({ generationReady: undefined });
    c.type("hi");
    c.key({ key: "Enter" });
    await tick();
    expect(c.send).not.toHaveBeenCalled();
    expect(c.status()).toContain("has not been reported");
    expect(c.status()).not.toContain("Generation unconfigured");
    expect(c.sendBtn().disabled).toBe(true);
  });

  it("blocks send without a selected project even when generation is ready", async () => {
    const c = setup({ workspaceSelected: false });
    c.type("hi");
    c.key({ key: "Enter" });
    c.sendBtn().click();
    await tick();
    expect(c.send).not.toHaveBeenCalled();
    expect(c.status()).toBe("No project is selected. Choose a project first.");
    expect(c.sendBtn().disabled).toBe(true);
  });

  it("sends once a generation port is reported ready", async () => {
    const c = setup({ generationReady: true });
    c.type("hi");
    c.key({ key: "Enter" });
    await tick();
    await tick();
    expect(c.send).toHaveBeenCalledExactlyOnceWith({ text: "hi" });
  });

  it("never echoes a raw rejection: fixed copy, draft kept, no path or secret", async () => {
    const c = setup({
      generationReady: true,
      send: vi.fn(async () => {
        throw new Error(
          "ENOENT C:\\Users\\bob\\.ssh\\id_rsa at Object.<anonymous> sk-secret123",
        );
      }),
    });
    c.type("keep me");
    c.key({ key: "Enter" });
    await tick();
    await tick();
    expect(c.ta.value).toBe("keep me");
    expect(c.status()).not.toMatch(
      /ENOENT|\.ssh|sk-secret|Object\.<anonymous>/,
    );
    expect(c.status()).toMatch(/may not have reached/i);
  });

  it.each([
    ["disconnected", "ses_1", false, "not connected"],
    ["connecting", "ses_1", false, "connecting"],
    ["unavailable", "ses_1", false, "unavailable"],
    ["busy", "ses_1", false, "turn is running"],
    ["ready", null, false, "No session"],
    ["ready", "ses_1", true, "out of date"],
  ] as const)(
    "blocks send with an honest reason: %s / %s / stale=%s",
    async (connection, sessionId, stale, text) => {
      const c = setup({ connection, sessionId, stale });
      c.type("hi");
      c.key({ key: "Enter" });
      await tick();
      expect(c.send).not.toHaveBeenCalled();
      expect(c.status()).toContain(text);
      expect(c.sendBtn().disabled).toBe(true);
    },
  );

  it("Esc cancels only when cancellable", () => {
    const idle = setup();
    idle.key({ key: "Escape" });
    expect(idle.cancel).not.toHaveBeenCalled();
    document.body.innerHTML = "";
    const live = setup({ cancellable: true });
    live.key({ key: "Escape", isComposing: true });
    expect(live.cancel).not.toHaveBeenCalled();
    live.key({ key: "Escape" });
    expect(live.cancel).toHaveBeenCalledOnce();
  });

  it("exposes accessible names", () => {
    const c = setup();
    expect(document.querySelector("form")!.getAttribute("aria-label")).toBe(
      "Composer",
    );
    expect(document.querySelector('label[for="composer-input"]')).toBeTruthy();
    expect(c.ta.getAttribute("aria-describedby")).toBe(
      "composer-status composer-hint",
    );
  });
});
