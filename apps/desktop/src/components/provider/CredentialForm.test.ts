import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderSetupDraft } from "../../stores/profiles";
import CredentialForm from "./CredentialForm.svelte";

const SECRET = "sk-live-secret-123";
const mounted: object[] = [];
afterEach(() => {
  mounted.splice(0).forEach((c) => unmount(c));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function render(submit?: (d: ProviderSetupDraft) => Promise<void>) {
  mounted.push(
    mount(CredentialForm, { target: document.body, props: { submit } }),
  );
  flushSync();
}

const field = (id: string) =>
  document.querySelector<HTMLInputElement>(`#${id}`)!;

function set(id: string, value: string) {
  field(id).value = value;
  field(id).dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function fill(over: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "setup-endpoint": "https://api.example.test/v1",
    "setup-model": "gpt-test",
    "setup-context": "128000",
    "setup-output": "8192",
    "setup-key": SECRET,
    ...over,
  };
  for (const [id, value] of Object.entries(values)) set(id, value);
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};

function submit() {
  document.querySelector("form")!.requestSubmit();
  flushSync();
}

const button = () =>
  document.querySelector<HTMLButtonElement>("button[type=submit]")!;

describe("provider setup form", () => {
  it("defaults Pollinations limits without replacing an explicit model", () => {
    render(async () => {});
    set("setup-endpoint", "https://gen.pollinations.ai");
    expect(field("setup-model").value).toBe("stealth/glyph-cluster");
    expect(field("setup-context").value).toBe("256000");
    expect(field("setup-output").value).toBe("8192");
    set("setup-model", "chosen-model");
    set("setup-endpoint", "https://gen.pollinations.ai/v1");
    expect(field("setup-model").value).toBe("chosen-model");
  });
  it("stays disabled and names the missing native route when no seam is injected", () => {
    render();
    expect(button().disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "native provider setup route is not available",
    );
    fill();
    submit();
    expect(document.body.textContent).not.toContain("Provider saved");
  });

  it("hands the typed draft to the seam once, then clears the key", async () => {
    const submitFn = vi.fn(async (_d: ProviderSetupDraft) => {});
    render(submitFn);
    fill();
    const family = document.querySelector<HTMLSelectElement>("#setup-family")!;
    family.value = "openai-responses";
    family.dispatchEvent(new Event("change", { bubbles: true }));
    field("setup-reasoning").click();
    field("setup-image").click();
    flushSync();
    submit();
    await settle();
    expect(submitFn).toHaveBeenCalledExactlyOnceWith({
      endpoint: "https://api.example.test/v1",
      apiFamily: "openai-responses",
      modelId: "gpt-test",
      contextWindow: "128000",
      maxOutputTokens: "8192",
      reasoning: true,
      image: true,
      apiKey: SECRET,
    });
    expect(field("setup-key").value).toBe("");
    expect(document.getElementById("connect-status")!.textContent).toContain(
      "Provider saved",
    );
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it.each([
    ["STALE_REVISION", "changed since this form was opened"],
    ["POLICY_DENIED", "engine refused this provider setup"],
    [
      "SETUP_CREDENTIAL_UNAVAILABLE",
      "Check Windows Credential Manager access before retrying",
    ],
    [
      "SETUP_CREDENTIAL_INVENTORY_UNAVAILABLE",
      "Windows credential inventory could not be validated. Review Splyce entries in Windows Credential Manager. Nothing was saved and the key was discarded.",
    ],
    [undefined, "Could not confirm the provider save"],
  ])(
    "rejection %s shows fixed copy, clears the key and never echoes it",
    async (code, copy) => {
      const log = vi.spyOn(console, "error");
      render(async () => {
        throw Object.assign(
          new Error(`ENOENT C:\\Users\\bob\\.ssh\\id_rsa ${SECRET}`),
          { code },
        );
      });
      fill();
      submit();
      await settle();
      const text = document.body.textContent!;
      expect(text).toContain(copy);
      expect(text).not.toMatch(/ENOENT|\.ssh|sk-live-secret/);
      expect(field("setup-key").value).toBe("");
      expect(document.body.innerHTML).not.toContain(SECRET);
      expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    },
  );

  it.each([
    [
      { "setup-endpoint": "http://api.example.test/v1" },
      "setup-endpoint",
      "must use https",
    ],
    [
      { "setup-endpoint": "http://user:pw@127.0.0.1/v1" },
      "setup-endpoint",
      "must not contain credentials",
    ],
    [
      { "setup-endpoint": "https://a.test/v1?token=x" },
      "setup-endpoint",
      "query string",
    ],
    [{ "setup-endpoint": "not a url" }, "setup-endpoint", "not a valid URL"],
    [{ "setup-model": "" }, "setup-model", "Model ID is required"],
    [{ "setup-model": "gpt\u200btest" }, "setup-model", "no spaces or control"],
    [{ "setup-context": "0" }, "setup-context", "1 to 2097152"],
    [{ "setup-context": "2097153" }, "setup-context", "1 to 2097152"],
    [{ "setup-context": "1.5" }, "setup-context", "whole number"],
    [
      { "setup-output": "1048577", "setup-context": "2097152" },
      "setup-output",
      "1 to 1048576",
    ],
    [
      { "setup-output": "9000", "setup-context": "8192" },
      "setup-output",
      "must not exceed the context window",
    ],
    [{ "setup-key": "  " }, "setup-key", "API key is required"],
  ])(
    "blocks %o with a described error on the field and focuses it",
    (over, id, message) => {
      const submitFn = vi.fn(async (_d: ProviderSetupDraft) => {});
      render(submitFn);
      fill(over);
      submit();
      expect(submitFn).not.toHaveBeenCalled();
      const input = field(id);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const described = document.getElementById(
        input.getAttribute("aria-describedby")!.split(" ")[0]!,
      )!;
      expect(described.textContent).toContain(message);
      expect(document.activeElement).toBe(input);
      expect(document.body.textContent).not.toContain(SECRET);
    },
  );

  it("accepts loopback http and the inclusive limits", async () => {
    const submitFn = vi.fn(async (_d: ProviderSetupDraft) => {});
    render(submitFn);
    fill({
      "setup-endpoint": "http://127.0.0.1:11434/v1",
      "setup-context": "2097152",
      "setup-output": "1048576",
    });
    submit();
    await settle();
    expect(submitFn).toHaveBeenCalledTimes(1);
  });

  it("labels every control and masks the key", () => {
    render(vi.fn(async () => {}));
    for (const el of document.querySelectorAll("input, select")) {
      const label =
        document.querySelector(`label[for="${el.id}"]`) ?? el.closest("label");
      expect(label?.textContent?.trim(), el.outerHTML).toBeTruthy();
      expect(el.getAttribute("tabindex")).toBeNull();
    }
    expect(field("setup-key").type).toBe("password");
    expect(document.querySelector("form")!.getAttribute("aria-label")).toBe(
      "Provider setup",
    );
  });
});
