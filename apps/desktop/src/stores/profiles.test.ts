import type { ProviderConnectionRecord } from "@splyce/pi/contracts";
import { describe, expect, it } from "vitest";
import {
  type ConnectionInput,
  type CredentialStatus,
  providerConfigurePayload,
  toConnectionView,
  validateProviderSetup,
} from "./profiles";

function input(
  over: Partial<ConnectionInput> = {},
  endpointLabel = "https://api.example.test/v1/chat",
): ConnectionInput {
  return {
    record: {
      providerConnectionId: "conn-a",
      revision: "rev-a",
      apiFamily: "openai-completions",
      apiVersion: "1",
      endpointRef: "endpoint:secret-ref",
      credentialRef: "credential:secret-ref",
      adapterRevision: "a1",
      accountScopeRef: "scope:x",
      locality: "hosted",
    } as unknown as ProviderConnectionRecord,
    endpointLabel,
    credential: "configured" as CredentialStatus,
    ...over,
  };
}

/** Anything the renderer could serialise, so a leak cannot hide in a field. */
function serialized(view: unknown): string {
  return JSON.stringify(view);
}

describe("TD-17 provider view hardening", () => {
  it("never exposes a credential or endpoint reference to the renderer", () => {
    const view = toConnectionView(input());
    expect(serialized(view)).not.toContain("credential:");
    expect(serialized(view)).not.toContain("endpoint:");
    expect(Object.keys(view)).not.toContain("credentialRef");
    expect(Object.keys(view)).not.toContain("endpointRef");
  });

  it("reduces the endpoint to a sanitised origin, dropping path, query, fragment and userinfo", () => {
    const view = toConnectionView(
      input(
        {},
        "https://user:pass@api.example.test:8443/v1/chat?token=sk-live#frag",
      ),
    );
    expect(view.endpointHost).toBe("https://api.example.test:8443");
    const text = serialized(view);
    for (const leaked of [
      "user",
      "pass",
      "token",
      "sk-live",
      "/v1",
      "chat",
      "frag",
    ]) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it("does not invent a destination when the endpoint is not an http(s) URL", () => {
    for (const bad of [
      "not a url",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "",
    ]) {
      const view = toConnectionView(input({}, bad));
      expect(view.endpointHost, bad).toBeNull();
      expect(view.egress, bad).toBe("Destination unavailable.");
      expect(view.state, bad).toBe("unavailable");
      if (bad !== "") expect(serialized(view), bad).not.toContain(bad);
    }
  });

  it("keeps a clean user label and falls back when the label is URL or credential shaped", () => {
    expect(
      toConnectionView(input({ displayName: "Work gateway" })).displayName,
    ).toBe("Work gateway");
    for (const bad of [
      "https://evil.example/login",
      "sk-live-1234567890",
      "",
      "x".repeat(65),
    ]) {
      const view = toConnectionView(input({ displayName: bad }));
      expect(view.displayName, bad).toBe("openai-completions connection");
      if (bad !== "") expect(serialized(view), bad).not.toContain(bad);
    }
  });

  it("labels an origin without a scheme-less port as local only for loopback hosts", () => {
    const local = toConnectionView(
      input(
        { record: { ...input().record, locality: "local" } },
        "http://127.0.0.1:11434/v1",
      ),
    );
    expect(local).toMatchObject({
      locality: "local",
      endpointHost: "http://127.0.0.1:11434",
    });
    expect(local.egress).toBe("Local: requests stay on this device");
  });
});

describe("provider setup token limits", () => {
  const draft = (contextWindow: string, maxOutputTokens: string) => ({
    endpoint: "https://api.example.test/v1",
    apiFamily: "openai-completions" as const,
    modelId: "gpt-test",
    contextWindow,
    maxOutputTokens,
    reasoning: false,
    image: false,
    apiKey: "k",
  });

  it("accepts both blank and omits chat.model, never inventing limits", () => {
    expect(validateProviderSetup(draft("", ""))).toEqual({});
    const payload = providerConfigurePayload(draft("", ""), "ws", "req-1");
    expect(payload.requestId).toBe("req-1");
    expect(payload.chat).toStrictEqual({ modelId: "gpt-test" });
  });

  it("uses the native loopback locality in setup", () => {
    expect(
      providerConfigurePayload(
        { ...draft("", ""), endpoint: "http://127.0.0.1:11434/v1" },
        "ws",
        "req",
      ).locality,
    ).toBe("loopback");
  });

  it("requires both limits once either is entered", () => {
    expect(Object.keys(validateProviderSetup(draft("4096", "")))).toEqual([
      "maxOutputTokens",
    ]);
    expect(Object.keys(validateProviderSetup(draft("", "512")))).toEqual([
      "contextWindow",
    ]);
  });

  it("sends explicit limits for a custom model", () => {
    const payload = providerConfigurePayload(draft("8192", "1024"), "ws", "r");
    expect(payload.chat.model).toStrictEqual({
      contextWindow: 8192,
      maxOutputTokens: 1024,
      reasoning: false,
      input: ["text"],
    });
  });
});
