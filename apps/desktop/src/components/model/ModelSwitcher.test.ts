import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { SelectionTransitionRecord } from "@splyce/pi/contracts";
import ModelSwitcher from "./ModelSwitcher.svelte";
import {
  applyTransition,
  createModelSelection,
  requestSwitch,
  type ModelOption,
  type ModelCatalogStatus,
  type ModelSelectionState,
} from "../../stores/model-selection";

const options: ModelOption[] = [
  { ref: "bind_a", label: "Model A", locality: "local" },
  {
    ref: "bind_b",
    label: "Model B",
    locality: "hosted",
    labels: ["unbenchmarked"],
  },
  {
    ref: "bind_c",
    label: "Model C",
    locality: "hosted",
    unavailableReason: "service is down",
  },
];

const record = (
  state: SelectionTransitionRecord["state"],
  requestedBindingRef = "bind_b",
): SelectionTransitionRecord =>
  ({
    transitionId: "tr_1",
    runId: "run_1",
    branchAnchorId: "anchor_1",
    previousBindingRef: "bind_a",
    requestedBindingRef,
    profileRevision: "1",
    configRevision: "1",
    intentRef: "intent_1",
    disposition: "next-turn",
    state,
  }) as SelectionTransitionRecord;

let cmp: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (cmp) unmount(cmp);
  cmp = null;
  document.body.innerHTML = "";
});

function render(
  state: ModelSelectionState,
  extra: {
    turnActive?: boolean;
    onRequest?: (r: string, d: string) => void;
    options?: ModelOption[];
    catalogStatus?: ModelCatalogStatus;
    stale?: boolean;
  } = {},
) {
  cmp = mount(ModelSwitcher, {
    target: document.body,
    props: {
      selection: state,
      options,
      onRequest: () => {},
      ...extra,
    } as never,
  });
  flushSync();
}
const text = (id: string) =>
  document
    .querySelector(`[data-testid="${id}"]`)
    ?.textContent?.replace(/\s+/g, " ") ?? "";

describe("ModelSwitcher", () => {
  it("shows requested separately from active until applied", () => {
    const base = requestSwitch(
      createModelSelection("bind_a"),
      "bind_b",
      "next-turn",
    );
    const pending = applyTransition(base, record("pending"));
    render(pending);
    expect(text("model-current")).toBe("Active: Model A");
    expect(text("model-requested")).toContain("Requested: Model B · Pending");
    expect(text("model-requested")).toContain("next turn");
  });

  it("applied moves the active binding", () => {
    const s = applyTransition(
      requestSwitch(createModelSelection("bind_a"), "bind_b", "next-turn"),
      record("ready"),
    );
    render(s);
    expect(text("model-current")).toBe("Active: Model B");
    expect(text("model-requested")).toContain("Applied");
  });

  it("rejected keeps the old binding visible with the reason", () => {
    const s = applyTransition(
      requestSwitch(createModelSelection("bind_a"), "bind_b", "next-turn"),
      record("failed"),
      "credential revoked",
    );
    render(s);
    expect(text("model-current")).toBe("Active: Model A");
    const req = text("model-requested");
    expect(req).toContain("Rejected");
    expect(req).toContain("credential revoked");
    expect(req).toContain("Still using Model A");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("an engine-chosen different binding is flagged, never shown as success", () => {
    const s = applyTransition(
      requestSwitch(createModelSelection("bind_a"), "bind_b", "next-turn"),
      record("ready", "bind_c"),
    );
    render(s);
    expect(text("model-requested")).toContain(
      "different model than you requested",
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("keeps the user's requested binding across pending(C) then ready(C) after asking for B", () => {
    let s = requestSwitch(
      createModelSelection("bind_a"),
      "bind_b",
      "next-turn",
    );
    s = applyTransition(s, record("pending", "bind_c"));
    render(s);
    expect(text("model-requested")).toContain("Requested: Model B");
    expect(text("model-requested")).toContain(
      "different model than you requested",
    );
    expect(text("model-current")).toBe("Active: Model A");
    unmount(cmp!);
    document.body.innerHTML = "";
    s = applyTransition(s, record("ready", "bind_c"));
    render(s);
    expect(text("model-current")).toBe("Active: Model C");
    expect(text("model-requested")).toContain("Requested: Model B");
    expect(s.transition?.mismatch).toBe(true);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("disables unavailable models with an honest reason and labels unbenchmarked", () => {
    render(createModelSelection("bind_a"));
    const c = document.querySelector<HTMLInputElement>(
      'input[value="bind_c"]',
    )!;
    expect(c.disabled).toBe(true);
    expect(text("model-unavailable")).toContain("service is down");
    expect(document.body.textContent).toContain("[unbenchmarked]");
  });

  it("mid-turn shows when the switch takes effect and offers disposition", () => {
    const s = requestSwitch(
      createModelSelection("bind_a"),
      "bind_b",
      "cancel-and-switch",
    );
    render(s, { turnActive: true });
    expect(text("model-requested")).toContain("Cancels the running turn");
    expect(
      document.querySelector('input[value="cancel-and-switch"]'),
    ).not.toBeNull();
  });

  it("is keyboard operable with accessible names and requests the chosen model", () => {
    const onRequest = vi.fn();
    render(createModelSelection("bind_a"), { turnActive: true, onRequest });
    const radio = document.querySelector<HTMLInputElement>(
      'input[value="bind_b"]',
    )!;
    expect(radio.closest("label")?.textContent).toContain("Model B");
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Request switch"),
    )!;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(onRequest).toHaveBeenCalledWith("bind_b", "next-turn");
    expect(document.querySelector("fieldset legend")?.textContent).toBe(
      "Switch model",
    );
  });

  it("blocks a second request while one is pending", () => {
    const s = applyTransition(
      requestSwitch(createModelSelection("bind_a"), "bind_b", "next-turn"),
      record("pending"),
    );
    render(s);
    expect(document.querySelector("fieldset")!.disabled).toBe(true);
  });

  it("says the catalog is loading instead of showing an empty picker", () => {
    render(createModelSelection("bind_a"), {
      options: [],
      catalogStatus: "loading",
    });

    expect(text("model-catalog-loading")).toContain(
      "Loading the model catalog",
    );
    expect(
      document
        .querySelector('[data-testid="model-switcher"]')!
        .getAttribute("aria-busy"),
    ).toBe("true");
    // The active binding is engine truth and stays visible while it loads; with
    // no catalog there is no label to invent, so it shows the binding ref.
    expect(text("model-current")).toBe("Active: bind_a");
    expect(document.querySelector("fieldset")).toBeNull();
    expect(text("model-catalog-empty")).toBe("");
  });

  it("a refresh during loading keeps the known models pickable", () => {
    render(createModelSelection("bind_a"), { catalogStatus: "loading" });

    expect(text("model-catalog-loading")).toContain("Loading");
    expect(document.querySelectorAll('input[value^="bind_"]').length).toBe(
      options.length,
    );
  });

  it("a failed catalog is an alert and never claims there are no models", () => {
    // Even with previously known options, a failed catalog offers no picker: a
    // switch must not be committed against a catalog the engine did not confirm.
    render(createModelSelection("bind_a"), { catalogStatus: "error" });

    const alert = document.querySelector<HTMLElement>(
      '[data-testid="model-catalog-error"]',
    )!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("could not be loaded");
    expect(document.body.textContent).not.toContain("reported no models");
    expect(document.querySelector("fieldset")).toBeNull();
    expect(document.querySelectorAll('input[value^="bind_"]').length).toBe(0);
  });

  it("an empty catalog is stated rather than rendered as a bare fieldset", () => {
    render(createModelSelection("bind_a"), { options: [] });

    expect(text("model-catalog-empty")).toContain("reported no models");
    expect(document.querySelector("fieldset")).toBeNull();
    expect(text("model-catalog-loading")).toBe("");
  });

  it("a stale catalog is marked as possibly out of date", () => {
    render(createModelSelection("bind_a"), { stale: true });

    expect(text("model-catalog-stale")).toContain("may be out of date");
    expect(document.querySelectorAll('input[value^="bind_"]').length).toBe(
      options.length,
    );
    unmount(cmp!);
    document.body.innerHTML = "";
    render(createModelSelection("bind_a"));
    expect(text("model-catalog-stale")).toBe("");
  });

  it("a stale empty catalog still carries the warning", () => {
    // Empty and stale are independent facts: the engine reported nothing AND
    // the report may be behind. Saying only "no models" hides the second one.
    render(createModelSelection("bind_a"), { options: [], stale: true });

    expect(text("model-catalog-empty")).toContain("reported no models");
    expect(text("model-catalog-stale")).toContain("may be out of date");
  });

  it("a failed catalog never borrows the stale warning", () => {
    render(createModelSelection("bind_a"), {
      catalogStatus: "error",
      stale: true,
    });

    expect(text("model-catalog-error")).toContain("could not be loaded");
    expect(text("model-catalog-stale")).toBe("");
  });
});
