import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PermissionModeSelect from "./PermissionModeSelect.svelte";
import PermissionModeHarness from "../../tests/td30/PermissionModeHarness.svelte";
import {
  acknowledgeMode,
  initialPermissionMode,
  requestPermissionMode,
  type PermissionModeContext,
  type PermissionModeState,
} from "../stores/permission-mode";

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  document.body.innerHTML = "";
});

const context = (
  overrides: Partial<PermissionModeContext> = {},
): PermissionModeContext => ({
  engine: "ready",
  engineReason: null,
  configRevision: "cfg-1",
  policyRevision: "pol-1",
  ...overrides,
});

const pendingAcceptEdits = (): PermissionModeState => {
  const request = requestPermissionMode(
    initialPermissionMode("ses-1"),
    "accept-edits",
    context(),
  );
  if (request.kind !== "requested") throw new Error("expected request");
  return request.state;
};

async function render(
  state: PermissionModeState,
  props: Record<string, unknown> = {},
): Promise<void> {
  if (app) {
    unmount(app);
    app = null;
    document.body.innerHTML = "";
  }
  app = mount(PermissionModeSelect, {
    target: document.body,
    props: { modeState: state, context: context(), ...props } as never,
  });
  flushSync();
  await tick();
  flushSync();
}

const byTestId = (id: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing ${id}`);
  return element;
};

const maybeTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const select = (): HTMLSelectElement =>
  byTestId("permission-mode-select") as HTMLSelectElement;

const dialog = (): HTMLDialogElement =>
  document.querySelector<HTMLDialogElement>("dialog")!;

async function choose(mode: string): Promise<void> {
  const element = select();
  element.value = mode;
  element.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  await tick();
  flushSync();
}

describe("TD-30 PermissionModeSelect", () => {
  it("starts on the safe effective mode and shows no pending or announcement", async () => {
    await render(initialPermissionMode("ses-1"));

    expect(select().disabled).toBe(false);
    expect(select().value).toBe("manual");
    expect(byTestId("permission-effective").textContent).toContain("Manual");
    expect(maybeTestId("permission-pending")).toBeNull();
    expect(byTestId("permission-announcement").textContent?.trim()).toBe("");
  });

  it("reports a request but keeps the effective mode until the engine acknowledges", async () => {
    const onChange = vi.fn();
    await render(initialPermissionMode("ses-1"), { onChange });

    await choose("accept-edits");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("accept-edits");
    // The control does not claim the request is effective.
    expect(byTestId("permission-effective").textContent).toContain("Manual");
    expect(select().value).toBe("manual");

    // The parent then reports the engine-pending state.
    await render(pendingAcceptEdits(), { onChange });
    expect(byTestId("permission-pending").textContent).toContain(
      "Accept edits (pending engine)",
    );
    expect(select().value).toBe("accept-edits");
    expect(byTestId("permission-effective").textContent).toContain("Manual");
  });

  it("announces the acknowledged mode once, without changing the effective mode itself", async () => {
    const acknowledged = acknowledgeMode(pendingAcceptEdits(), "accept-edits");
    await render(acknowledged);

    expect(byTestId("permission-effective").textContent).toContain(
      "Accept edits",
    );
    expect(byTestId("permission-announcement").textContent).toContain(
      "Permission mode is now Accept edits.",
    );
    expect(maybeTestId("permission-pending")).toBeNull();
  });

  it("keeps the previous mode and shows the engine's rejection reason", async () => {
    const rejected: PermissionModeState = {
      ...initialPermissionMode("ses-1"),
      status: "rejected",
      reason: "Policy forbids auto mode.",
    };
    await render(rejected);

    expect(byTestId("permission-effective").textContent).toContain("Manual");
    expect(byTestId("permission-rejected").textContent).toContain(
      "Policy forbids auto mode.",
    );
    expect(select().value).toBe("manual");
  });

  it("is inert and explains why while the engine is unavailable", async () => {
    const onChange = vi.fn();
    await render(initialPermissionMode("ses-1"), {
      context: context({
        engine: "unavailable",
        engineReason: "Engine process exited.",
      }),
      onChange,
    });

    expect(select().disabled).toBe(true);
    expect(byTestId("permission-blocked").textContent).toContain(
      "Engine process exited.",
    );
    await choose("auto");
    expect(onChange).not.toHaveBeenCalled();
    expect(select().value).toBe("manual");
  });

  it("never enables bypass without the separate confirmation", async () => {
    const onChange = vi.fn();
    const onDismissConfirm = vi.fn();
    await render(initialPermissionMode("ses-1"), {
      onChange,
      onDismissConfirm,
    });

    await choose("bypass");
    expect(onChange).not.toHaveBeenCalled();
    expect(dialog().open).toBe(true);
    // The safe choice owns focus, so Enter cannot enable bypass.
    expect(document.activeElement).toBe(byTestId("permission-keep"));
    expect(byTestId("permission-keep").textContent).toContain("Keep Manual");

    dialog().dispatchEvent(new Event("cancel", { cancelable: true }));
    flushSync();
    await tick();
    flushSync();

    expect(dialog().open).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(onDismissConfirm).toHaveBeenCalledTimes(1);
    expect(select().value).toBe("manual");
  });

  it("requests bypass only after the explicit confirmation", async () => {
    const onChange = vi.fn();
    await render(initialPermissionMode("ses-1"), { onChange });

    await choose("bypass");
    byTestId("permission-confirm-bypass").click();
    flushSync();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("bypass");
    expect(dialog().open).toBe(false);
  });

  it("refuses a duplicate pending request and says it is awaiting the engine", async () => {
    const onChange = vi.fn();
    await render(pendingAcceptEdits(), { onChange });

    await choose("accept-edits");
    expect(onChange).not.toHaveBeenCalled();
    expect(byTestId("permission-notice").textContent).toContain(
      "already awaiting the engine",
    );
  });
});

type Live = {
  push(state: PermissionModeState, context?: PermissionModeContext): void;
};

/** Mounts the selector with mutable props, so a context change is observable. */
async function renderLive(props: Record<string, unknown> = {}): Promise<Live> {
  if (app) {
    unmount(app);
    app = null;
    document.body.innerHTML = "";
  }
  app = mount(PermissionModeHarness, {
    target: document.body,
    props: {
      initialModeState: initialPermissionMode("ses-1"),
      initialContext: context(),
      ...props,
    } as never,
  });
  flushSync();
  await tick();
  flushSync();
  return app as unknown as Live;
}

const flush = async (): Promise<void> => {
  flushSync();
  await tick();
  flushSync();
};

describe("TD-30 permission confirmation is bound to what it was opened on", () => {
  it("closes and refuses the confirmation when the session changes", async () => {
    const onChange = vi.fn();
    const onDismissConfirm = vi.fn();
    const live = await renderLive({ onChange, onDismissConfirm });

    await choose("bypass");
    expect(dialog().open).toBe(true);
    expect(document.activeElement).toBe(byTestId("permission-keep"));

    live.push(initialPermissionMode("ses-2"));
    await flush();

    // The old confirmation cannot answer for the new session.
    expect(dialog().open).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(byTestId("permission-notice").textContent).toContain(
      "session changed",
    );
    expect(onDismissConfirm).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(select());
  });

  it("closes and refuses the confirmation when the revisions change", async () => {
    const onChange = vi.fn();
    const live = await renderLive({ onChange });

    await choose("bypass");
    expect(dialog().open).toBe(true);

    live.push(
      initialPermissionMode("ses-1"),
      context({ configRevision: "cfg-2", policyRevision: "pol-2" }),
    );
    await flush();

    expect(dialog().open).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(byTestId("permission-notice").textContent).toContain(
      "Configuration or policy changed",
    );
  });

  it("closes and refuses the confirmation when the engine goes away", async () => {
    const onChange = vi.fn();
    const live = await renderLive({ onChange });

    await choose("bypass");
    expect(dialog().open).toBe(true);

    live.push(
      initialPermissionMode("ses-1"),
      context({
        engine: "unavailable",
        engineReason: "Engine process exited.",
      }),
    );
    await flush();

    // No dead modal and no confirm callback: the engine cannot admit it.
    expect(dialog().open).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(byTestId("permission-notice").textContent).toContain(
      "Engine process exited.",
    );
    expect(byTestId("permission-blocked").textContent).toContain(
      "Engine process exited.",
    );
  });
});
