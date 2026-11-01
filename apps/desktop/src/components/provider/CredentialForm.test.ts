import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import CredentialForm from "./CredentialForm.svelte";
import type { CredentialDraft } from "../../stores/profiles";

const mounted: object[] = [];
afterEach(() => {
  mounted.splice(0).forEach((c) => unmount(c));
  document.body.innerHTML = "";
});

function render(submit?: (d: CredentialDraft) => Promise<void>) {
  mounted.push(
    mount(CredentialForm, { target: document.body, props: { submit } }),
  );
  flushSync();
}

function set(id: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`#${id}`)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function submit() {
  document.querySelector("form")!.requestSubmit();
  flushSync();
}

function button() {
  return document.querySelector<HTMLButtonElement>("button[type=submit]")!;
}

describe("provider credential form", () => {
  it("stays disabled and names the missing native writer when no seam is injected", () => {
    render();
    expect(button().disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "native credential writer is not available",
    );
    set("connect-name", "Work");
    set("connect-url", "https://api.example.test/v1");
    set("connect-key", "sk-should-never-leave");
    submit();
    expect(document.body.textContent).not.toContain(
      "handed to the native writer",
    );
  });

  it("hands a valid draft to the seam, then clears the key from the DOM", async () => {
    const submitFn = vi.fn(async (_d: CredentialDraft) => {});
    render(submitFn);
    set("connect-name", "Work gateway");
    set("connect-url", "https://api.example.test/v1");
    set("connect-key", "sk-live-secret-123");
    submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(submitFn).toHaveBeenCalledExactlyOnceWith({
      displayName: "Work gateway",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-live-secret-123",
    });
    expect(
      document.querySelector<HTMLInputElement>("#connect-key")!.value,
    ).toBe("");
    expect(document.body.textContent).not.toContain("sk-live-secret-123");
  });

  it("refuses an unsafe base URL and never echoes the key in the errors", () => {
    const submitFn = vi.fn(async (_d: CredentialDraft) => {});
    render(submitFn);
    set("connect-name", "Work");
    set("connect-url", "http://user:pass@evil.example/v1?token=abc");
    set("connect-key", "sk-live-secret-123");
    submit();
    expect(submitFn).not.toHaveBeenCalled();
    const errors = document.querySelector("[data-testid=credential-errors]")!;
    expect(errors.textContent).toContain("must use https");
    expect(errors.textContent).not.toContain("sk-live-secret-123");
    expect(errors.textContent).not.toContain("pass");
  });

  it("shows fixed copy and discards the key when the native write is rejected", async () => {
    const submitFn = vi.fn(async (_d: CredentialDraft) => {
      throw new Error(
        "ENOENT C:\\Users\\bob\\.ssh\\id_rsa sk-live-secret-123 at Object.<anonymous>",
      );
    });
    render(submitFn);
    set("connect-name", "Work");
    set("connect-url", "https://api.example.test/v1");
    set("connect-key", "sk-live-secret-123");
    submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const text = document.body.textContent!;
    expect(text).toContain("Could not save the credential");
    expect(text).not.toMatch(/ENOENT|\.ssh|sk-live-secret|Object\.<anonymous>/);
    expect(
      document.querySelector<HTMLInputElement>("#connect-key")!.value,
    ).toBe("");
  });
});
