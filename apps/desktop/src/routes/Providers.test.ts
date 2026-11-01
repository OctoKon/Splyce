import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConnectionRecord } from "@splyce/pi/contracts";
import {
  groupByFamily,
  toConnectionView,
  validateCustomEndpoint,
  type ConnectionInput,
  type CredentialStatus,
  type CustomEndpointDraft,
} from "../stores/profiles";
import Providers from "./Providers.svelte";

const matrix = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../../research/docs/design/provider-matrix-proposal.json",
    ),
    "utf8",
  ),
) as { chatApis: { apiId: string }[] };
const families = matrix.chatApis.map((a) => a.apiId);

function conn(
  id: string,
  apiFamily: string,
  credential: CredentialStatus,
  locality: "local" | "hosted" = "hosted",
  endpointLabel = `https://${id}.example.test/v1`,
): ConnectionInput {
  return {
    record: {
      providerConnectionId: id,
      revision: `rev-${id}`,
      apiFamily,
      apiVersion: "1",
      endpointRef: `endpoint:${id}`,
      credentialRef: `credential:${id}`,
      adapterRevision: "a1",
      accountScopeRef: "scope:x",
      locality,
    } as unknown as ProviderConnectionRecord,
    endpointLabel,
    credential,
  };
}

let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = "";
});

function render(
  connections: ConnectionInput[],
  onAddCustom: (d: CustomEndpointDraft) => void = () => {},
): void {
  app = mount(Providers, {
    target: document.body,
    props: { connections, families, onAddCustom },
  });
  flushSync();
}

const draft = (
  over: Partial<CustomEndpointDraft> = {},
): CustomEndpointDraft => ({
  connectionId: "gw",
  baseUrl: "https://gw.example.test/v1",
  headers: [],
  ...over,
});

describe("provider grouping", () => {
  it("groups connections by matrix family in matrix order and keeps unlisted families", () => {
    const groups = groupByFamily(
      [
        conn("b", "anthropic-messages", "configured"),
        conn("a", "openai-completions", "configured"),
        conn("z", "future-api", "configured"),
      ],
      families,
    );
    expect(groups.map((g) => g.apiFamily)).toEqual([...families, "future-api"]);
    expect(
      groups.find((g) => g.apiFamily === "anthropic-messages")?.connections,
    ).toHaveLength(1);
    expect(groups.at(-1)?.connections[0]?.id).toBe("z");
  });

  it("renders one labelled section per family with endpoint, egress and revision", () => {
    render([conn("a", "openai-completions", "configured")]);
    const sections = document.querySelectorAll("[data-testid=family]");
    expect(sections).toHaveLength(families.length);
    const card = document.querySelector("[data-testid=connection]")!;
    expect(card.textContent).toContain("rev-a");
    expect(card.textContent).toContain("Cloud: request content is sent to");
    expect(card.textContent).toContain("Configured");
  });

  it("never prints a credential or endpoint reference and only the sanitised origin", () => {
    render([conn("a", "openai-completions", "configured")]);
    const text = document.querySelector(
      "[data-testid=connection]",
    )!.textContent!;
    expect(text).not.toContain("credential:");
    expect(text).not.toContain("/v1");
    expect(text).toContain("https://a.example.test");
    expect(text).toContain("openai-completions connection");
  });

  it("shows local egress as staying on the device", () => {
    expect(
      toConnectionView(
        conn(
          "l",
          "openai-completions",
          "configured",
          "local",
          "http://localhost:11434/v1",
        ),
      ).egress,
    ).toMatch(/^Local:/);
  });
});

describe("custom endpoint validation", () => {
  it("derives locality from the host, never from a flag", () => {
    for (const url of [
      "http://evil.example/v1",
      "http://localhost.evil.example/v1",
      "http://127.0.0.1.evil.example/v1",
    ])
      expect(validateCustomEndpoint(draft({ baseUrl: url }), [])).toContain(
        "Base URL must use https unless the endpoint is local.",
      );
    for (const url of [
      "http://localhost:1/v1",
      "http://127.5.6.7/v1",
      "http://[::1]:8080/v1",
    ])
      expect(validateCustomEndpoint(draft({ baseUrl: url }), [])).toEqual([]);
  });

  it("labels a non-loopback endpoint as cloud even if the record claims local", () => {
    const view = toConnectionView(
      conn(
        "x",
        "openai-completions",
        "configured",
        "local",
        "http://evil.example/v1",
      ),
    );
    expect(view.locality).toBe("hosted");
    expect(view.egress).toMatch(/^Cloud:/);
  });

  it("rejects query strings and fragments on the base URL", () => {
    for (const q of ["?api_key=s", "?key=s", "?token=s", "?x=1", "#frag", "?"])
      expect(
        validateCustomEndpoint(
          draft({ baseUrl: `https://gw.example.test/v1${q}` }),
          [],
        ),
        q,
      ).toContain("Base URL must not contain a query string or fragment.");
  });

  it("rejects hop-by-hop and transport-controlled header names case-insensitively", () => {
    for (const name of [
      "Host",
      "TRANSFER-ENCODING",
      "content-length",
      "Connection",
      "Upgrade",
      "Proxy-Authorization",
      "proxy-x",
      "Keep-Alive",
      "te",
      "Trailer",
    ])
      expect(
        validateCustomEndpoint(draft({ headers: [{ name, value: "v" }] }), []),
        name,
      ).toContain(`Header "${name}" is controlled by the transport.`);
    expect(
      validateCustomEndpoint(
        draft({ headers: [{ name: "Authorization", value: "v" }] }),
        [],
      ),
    ).toEqual([]);
  });

  it("rejects http for hosted, accepts it for local", () => {
    expect(
      validateCustomEndpoint(draft({ baseUrl: "http://gw.example.test" }), []),
    ).toContain("Base URL must use https unless the endpoint is local.");
    expect(
      validateCustomEndpoint(
        draft({ baseUrl: "http://127.0.0.1:11434/v1" }),
        [],
      ),
    ).toEqual([]);
  });

  it("rejects unparsable URLs and embedded credentials", () => {
    expect(
      validateCustomEndpoint(draft({ baseUrl: "not a url" }), []),
    ).toContain("Base URL is not a valid URL.");
    expect(
      validateCustomEndpoint(
        draft({ baseUrl: "https://u:p@gw.example.test/v1" }),
        [],
      ),
    ).toContain("Base URL must not contain credentials; use a header.");
  });

  it("rejects duplicate names and duplicate endpoints", () => {
    const existing = [
      { id: "gw", endpointLabel: "https://gw.example.test/v1/" },
    ];
    const errors = validateCustomEndpoint(draft(), existing);
    expect(errors).toContain("A connection with this name already exists.");
    expect(errors).toContain("A connection to this endpoint already exists.");
  });

  it("rejects invalid, duplicate and valueless headers", () => {
    const errors = validateCustomEndpoint(
      draft({
        headers: [
          { name: "bad name", value: "v" },
          { name: "X-A", value: "v" },
          { name: "x-a", value: "v" },
          { name: "X-B", value: "" },
        ],
      }),
      [],
    );
    expect(errors).toHaveLength(3);
  });

  it("form blocks submit on invalid input and hands off valid input then clears it", () => {
    const onAdd = vi.fn();
    render([], onAdd);
    const set = (name: string, value: string) => {
      const el = document.querySelector<HTMLInputElement>(
        `input[name=${name}]`,
      )!;
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const submit = () => {
      document
        .querySelector('form[aria-labelledby="custom-title"]')!
        .dispatchEvent(
          new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        );
      flushSync();
    };
    set("connectionId", "gw");
    set("baseUrl", "http://gw.example.test");
    submit();
    expect(onAdd).not.toHaveBeenCalled();
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "https",
    );

    set("baseUrl", "https://gw.example.test/v1");
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Add header")!
      .click();
    flushSync();
    set("hn0", "Authorization");
    set("hv0", "Bearer TYPED-SECRET");
    submit();
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0]![0].headers).toEqual([
      { name: "Authorization", value: "Bearer TYPED-SECRET" },
    ]);
    expect(document.body.innerHTML).not.toContain("TYPED-SECRET");
    expect(
      document.querySelector<HTMLInputElement>("input[name=baseUrl]")!.value,
    ).toBe("");
  });

  it("masks header value inputs", () => {
    render([]);
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Add header")!
      .click();
    flushSync();
    expect(
      document.querySelector<HTMLInputElement>("input[name=hv0]")!.type,
    ).toBe("password");
  });
});

describe("secrets", () => {
  it("never reaches state or DOM even when passed in by mistake", () => {
    const leaky = {
      ...conn("a", "openai-completions", "configured"),
      secret: "sk-LEAK-123",
      apiKey: "sk-LEAK-123",
    } as ConnectionInput;
    (leaky.record as unknown as Record<string, unknown>).credentialValue =
      "sk-LEAK-123";
    expect(JSON.stringify(groupByFamily([leaky], families))).not.toContain(
      "sk-LEAK",
    );
    render([leaky]);
    expect(document.body.innerHTML).not.toContain("sk-LEAK");
  });
});

describe("no implicit fallback", () => {
  it.each<CredentialStatus>(["missing", "unavailable"])(
    "%s credential makes only that connection unavailable with an honest error",
    (status) => {
      const groups = groupByFamily(
        [
          conn("bad", "openai-completions", status),
          conn("good", "anthropic-messages", "configured"),
        ],
        families,
      );
      const bad = groups
        .flatMap((g) => g.connections)
        .find((c) => c.id === "bad")!;
      expect(bad.state).toBe("unavailable");
      expect(bad.error).toContain("no other provider is used instead");
      expect(
        groups.find((g) => g.apiFamily === "openai-completions")!.connections,
      ).toHaveLength(1);
      render([conn("bad", "openai-completions", status)]);
      const alert = document.querySelector(
        "[data-testid=connection] [role=alert]",
      );
      expect(alert?.textContent).toContain("Unavailable");
      expect(document.querySelector("[data-state=ready]")).toBeNull();
    },
  );
});

describe("accessibility", () => {
  it("gives every control and region an accessible name and keeps controls natively focusable", () => {
    render([conn("a", "openai-completions", "missing")]);
    const name = (el: Element): string => {
      const labelledBy = el.getAttribute("aria-labelledby");
      const id = el.getAttribute("id");
      return (
        el.getAttribute("aria-label") ??
        (labelledBy
          ? document.getElementById(labelledBy)?.textContent
          : null) ??
        (id
          ? document.querySelector(`label[for="${id}"]`)?.textContent
          : null) ??
        el.closest("label")?.textContent ??
        el.textContent ??
        ""
      ).trim();
    };
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "Add header")!
      .click();
    flushSync();
    const controls = document.querySelectorAll(
      "input, button, form, section, main",
    );
    expect(controls.length).toBeGreaterThan(8);
    for (const el of controls) expect(name(el), el.outerHTML).not.toBe("");
    for (const el of document.querySelectorAll("input, button")) {
      expect(el.getAttribute("tabindex")).toBeNull();
      // A control may only be disabled on purpose: inside a disabled fieldset
      // that carries the visible reason, never a lone dead control.
      if ((el as HTMLButtonElement).disabled)
        expect(
          el.closest("fieldset[disabled]")?.textContent?.trim(),
        ).toBeTruthy();
      else expect((el as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("states credential status as text, not colour alone", () => {
    render([conn("a", "openai-completions", "missing")]);
    expect(
      document.querySelector("[data-testid=connection]")!.textContent,
    ).toContain("Missing");
  });
});
