import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The only fake: the native IPC boundary. Stores, transport and components are real.
const ipc = vi.hoisted(() => ({
  ready: false,
  invoke: vi.fn(),
  selection: null as unknown,
  setup: async (): Promise<unknown> => ({}),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: ipc.invoke,
  Channel: class {
    onmessage = (_event: unknown) => {};
  },
}));

import {
  FOUNDATION,
  PI_REVISION,
  type SplyceEvent,
} from "@splyce/pi/contracts";
import App from "./App.svelte";
import {
  dispatchEngineEvent,
  handshake as engineHandshake,
  selectWorkspace,
} from "./stores/engine";
import { clearSession, selectedSession } from "./stores/session-selection";

const settle = () => new Promise((r) => setTimeout(r, 0));
const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (b) =>
      b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
  )!;
const subscribes = () =>
  ipc.invoke.mock.calls.filter(([c]) => c === "subscribe");

it("keeps the conversation through navigation and reopening from Runs", async () => {
  ipc.ready = true;
  await boot();
  dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
  await settle();
  q("[role=treeitem]")!.click();
  await settle();
  const frames = [
    [
      "turn.started",
      { runId: "run_1", turnId: "turn_1", userPrompt: "My name is Itachi." },
    ],
    ["turn.stream_delta", { runId: "run_1", delta: "ok" }],
    [
      "turn.completed",
      { runId: "run_1", candidateSnapshotId: "snap_1", finalRevision: "rev_1" },
    ],
    [
      "turn.started",
      { runId: "run_2", turnId: "turn_2", userPrompt: "What is my name?" },
    ],
    ["turn.stream_delta", { runId: "run_2", delta: "Itachi" }],
    [
      "turn.completed",
      { runId: "run_2", candidateSnapshotId: "snap_2", finalRevision: "rev_2" },
    ],
  ] as const;
  for (const [index, [kind, payload]] of frames.entries()) {
    dispatchEngineEvent({
      schemaVersion: 1,
      protocolVersion: 2,
      recordId: `rec_${index}`,
      eventId: `evt_${index}`,
      createdAt: "2026-10-26T00:00:00.000Z",
      sourceIds: [],
      scopeId: "scope_1",
      sessionId: "ses_1",
      seq: index + 1,
      durable: kind !== "turn.stream_delta",
      kind,
      payload,
    } as SplyceEvent);
    await settle();
  }
  const transcript = () =>
    [
      ...document.querySelectorAll(
        '[data-testid="turn-user"], [data-testid="turn-text"]',
      ),
    ].map((node) => node.textContent?.trim().replace(/\s+/g, " "));
  const expected = [
    "USER My name is Itachi.",
    "ok",
    "USER What is my name?",
    "Itachi",
  ];
  expect(transcript()).toEqual(expected);
  button("Models").click();
  await settle();
  button("Work").click();
  await settle();
  expect(transcript()).toEqual(expected);
  dispatchEngineEvent(treeEvent("ses_2", "scope_1"));
  await settle();
  button("Runs").click();
  await settle();
  [...document.querySelectorAll<HTMLElement>("[role=treeitem]")]
    .find((node) => node.textContent?.includes("ses_2"))!
    .click();
  await settle();
  [...document.querySelectorAll<HTMLElement>("[role=treeitem]")]
    .find((node) => node.textContent?.includes("ses_1"))!
    .click();
  await settle();
  button("Work").click();
  await settle();
  expect(transcript()).toEqual(expected);
});

let app: object | undefined;
const readyHandshake = {
  protocolVersion: 2,
  schemaVersion: 1,
  engineProtocolVersion: 2,
  bridgeProtocolVersion: 2,
  piRevision: PI_REVISION,
  entryMode: FOUNDATION.entryMode,
  disabledBuiltinExtensions: [...FOUNDATION.disabledBuiltinExtensions],
  readiness: {
    state: "ready",
    policy: true,
    store: true,
    receipts: true,
    ports: { generation: true, provider: true, workspace: true, modules: true },
  },
};
beforeEach(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  ipc.ready = false;
  ipc.selection = null;
  ipc.setup = async () => ({
    profileId: "profile_1",
    profileRevision: "pr_1",
    configRevision: "cfg_1",
  });
  ipc.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "dialog_select_workspace") return ipc.selection;
    if (
      cmd === "send" &&
      (args as { payload?: { frame?: string } })?.payload?.frame === "setup"
    )
      return ipc.setup();
    if (cmd !== "handshake") return undefined;
    if (!ipc.ready) throw new Error("no native backend");
    return readyHandshake;
  });
  window.innerWidth = 1400;
  ipc.invoke.mockClear();
  clearSession();
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = "";
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function boot(props: Record<string, unknown> = {}) {
  app = mount(App, { target: document.body, props });
  await settle();
}

const treeEvent = (sessionId: string, scopeId: string) =>
  ({
    kind: "session.tree_updated",
    sessionId,
    scopeId,
    seq: 1,
    payload: { sessionId, branchAnchorId: "b1", leaves: ["e1"] },
  }) as never;

const admitted = {
  selectionRef: "ws_1",
  workspace: {
    workspaceId: "ws_1",
    displayName: "splyce-demo",
    admittedAt: "2026-10-28T00:00:00.000Z",
    revision: "rev_1",
  },
};

async function chooseProject(selection: unknown = admitted) {
  ipc.selection = selection;
  button("Choose project").click();
  await settle();
}

async function approvalApp() {
  ipc.invoke.mockImplementation(async (cmd: string, args?: { op?: string }) => {
    if (cmd === "handshake") {
      return readyHandshake;
    }
    if (cmd === "dialog_select_workspace") return admitted;
    if (cmd === "send") {
      if (args?.op === "setup.read")
        return {
          configRevision: "cfg_0",
          selectedProfileId: null,
          profiles: [],
        };
      if (args?.op === "sessions.list")
        return { sessions: [], truncated: false };
      if (args?.op === "provider.configure")
        return {
          profileId: "profile_1",
          profileRevision: "pr_1",
          configRevision: "cfg_1",
        };
      if (args?.op === "profile.select")
        return {
          selectedProfileId: "profile_1",
          profileRevision: "pr_2",
          configRevision: "cfg_2",
        };
      if (args?.op === "session.start")
        return {
          sessionId: "session_1",
          sessionRevision: "sr_1",
          policyRevision: "7",
          readiness: { state: "ready" },
        };
    }
  });
  await boot();
  await chooseProject();
  button("Models").click();
  flushSync();
  for (const [id, value] of Object.entries({
    "setup-endpoint": "https://example.test/v1",
    "setup-model": "model",
    "setup-key": "key",
  })) {
    const input = q(`#${id}`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  flushSync();
  (q('[aria-label="Provider setup"]') as HTMLFormElement).requestSubmit();
  await settle();
  button("Use this profile").click();
  await settle();
  button("Work").click();
  await settle();
}

async function approvalEvent(seq: number, kind: string, payload: object) {
  dispatchEngineEvent({
    schemaVersion: 1,
    protocolVersion: 2,
    recordId: `rec_${seq}`,
    eventId: `evt_${seq}`,
    createdAt: "2026-10-26T00:00:00.000Z",
    sourceIds: [],
    scopeId: "ws_1",
    sessionId: "session_1",
    seq,
    durable: true,
    kind,
    payload,
  } as SplyceEvent);
  await new Promise((resolve) => setTimeout(resolve, 30));
  flushSync();
}
async function approvalRun(seq: number, runId: string) {
  await approvalEvent(seq, "turn.started", { runId, turnId: `turn_${runId}` });
  await approvalEvent(seq + 1, "approval.requested", {
    approvalRequestId: `apr_${runId}`,
    runId,
    actionId: "act_1",
    capabilityId: "fs.write",
    targetScope: "ws_1",
    normalizedTarget: "target_app",
    riskRationale: "Writes a file",
  });
}

it("only enables the current rendered run when action IDs overlap", async () => {
  await approvalApp();
  await approvalRun(1, "old");
  await approvalRun(3, "new");
  const runs = document.querySelectorAll('[data-testid="turn-stream"]');
  expect(runs).toHaveLength(2);
  expect(
    runs[0].querySelector('[data-testid="approval-allow-button"]'),
  ).toBeNull();
  expect(
    runs[1].querySelector('[data-testid="approval-allow-button"]'),
  ).not.toBeNull();
});

describe("App wiring", () => {
  it("shows generation unconfigured while the native core is ready and runnable ports are unavailable", async () => {
    ipc.invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "handshake") return undefined;
      return {
        ...readyHandshake,
        readiness: {
          ...readyHandshake.readiness,
          ports: {
            generation: false,
            provider: false,
            workspace: false,
            modules: false,
          },
        },
      };
    });
    await boot();
    const shell = q("[data-testid=app-shell]")!;
    expect(shell.dataset.connectionState).toBe("unavailable");
    for (const service of ["Policy", "Store", "Receipts"])
      expect(shell.dataset[`readiness${service}`]).toBe("true");
    const banner = q("[data-testid=unavailable-banner]")!;
    expect(banner.textContent).toContain("Generation unconfigured");
    expect(banner.textContent).not.toMatch(/initializing/);
    expect(button("Send").disabled).toBe(true);
  });

  it("refreshes native readiness after Retry and observes the recovered engine exiting", async () => {
    await boot();
    ipc.ready = true;
    button("Retry").click();
    await settle();
    const shell = q("[data-testid=app-shell]")!;
    expect(shell.dataset.connectionState).toBe("ready");
    for (const service of ["Policy", "Store", "Receipts"])
      expect(shell.dataset[`readiness${service}`]).toBe("true");
    const nativeHandshake = ipc.invoke.mock.calls
      .filter(([command]) => command === "handshake")
      .at(-1)!;
    nativeHandshake[1].onLifecycle.onmessage({
      protocolVersion: 2,
      kind: "engine_exited",
      expected: false,
      exitCode: 1,
      cleanupComplete: true,
    });
    await settle();
    expect(q("[data-testid=unavailable-banner]")?.textContent).toMatch(
      /Engine stopped/,
    );
  });

  it("retains native readiness and shows engine loss beside the last transcript", async () => {
    ipc.ready = true;
    await boot();
    const shell = q("[data-testid=app-shell]")!;
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(shell.dataset.connectionState).toBe("ready");
    for (const service of ["Policy", "Store", "Receipts"])
      expect(shell.dataset[`readiness${service}`]).toBe("true");
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    q("[role=treeitem]")!.click();
    await settle();
    dispatchEngineEvent({
      schemaVersion: 1,
      protocolVersion: 2,
      recordId: "rec_1",
      eventId: "evt_1",
      createdAt: "2026-10-26T00:00:00.000Z",
      sourceIds: [],
      scopeId: "scope_1",
      sessionId: "ses_1",
      seq: 1,
      durable: true,
      kind: "turn.started",
      payload: { runId: "run_1", turnId: "turn_1" },
    } as SplyceEvent);
    await settle();
    expect(q('[aria-label="Transcript"]')).not.toBeNull();
    const nativeHandshake = ipc.invoke.mock.calls.find(
      ([command]) => command === "handshake",
    )!;
    nativeHandshake[1].onLifecycle.onmessage({
      protocolVersion: 2,
      kind: "engine_exited",
      expected: false,
      exitCode: 1,
      cleanupComplete: true,
    });
    await settle();
    expect(shell.dataset.connectionState).toBe("disconnected");
    for (const service of ["Policy", "Store", "Receipts"])
      expect(shell.dataset[`readiness${service}`]).toBe("unknown");
    expect(q("[data-testid=unavailable-banner]")?.textContent).toMatch(
      /Engine stopped.*last transcript may be incomplete/s,
    );
    expect(q('[aria-label="Transcript"]')).not.toBeNull();
    expect(button("Send").disabled).toBe(true);
  });

  it("shows an unavailable, disabled composer when no session is selected", async () => {
    await boot();
    expect(q("[data-testid=unavailable-banner]")).not.toBeNull();
    expect(q("#composer-status")?.textContent).toMatch(
      /not connected|unavailable|error/i,
    );
    expect(button("Send").disabled).toBe(true);
    // Sessions never read as empty or loading while the engine is down.
    expect(q("[data-testid=session-tree]")?.textContent).toMatch(
      /could not be loaded/,
    );
    expect(get(selectedSession)).toBeNull();
  });

  it("mounts each surface from shell navigation", async () => {
    await boot();
    button("Models").click();
    flushSync();
    const providers = q("[data-testid=providers-view]")!;
    expect(providers).not.toBeNull();
    // No engine: the setup form is disabled until it connects.
    expect(button("Save provider").disabled).toBe(true);
    expect(q("#setup-note")?.textContent).toContain("engine is not connected");
    expect(
      providers.querySelector<HTMLFieldSetElement>("fieldset.custom")!.disabled,
    ).toBe(true);
    expect(q("#providers-title")?.textContent).toBe("Provider connections");
    // No support record is delivered: the honest empty state, never a claim.
    expect(q("[data-testid=support-status-empty]")?.textContent).toMatch(
      /No support record available/,
    );
    expect(q("[data-testid=support-status] table")).toBeNull();

    button("Settings").click();
    flushSync();
    expect(q("[data-testid=usage-unavailable-note]")).not.toBeNull();
    expect(q("[data-testid=providers-view]")).toBeNull();

    // Setup and Modules are mounted from the shell and stay honest with no service.
    button("Settings").click();
    flushSync();
    expect(q("[data-testid=setup]")).not.toBeNull();
    expect(q("[data-testid=engine-unavailable]")?.textContent).toContain(
      "No setup or module service is connected.",
    );
    expect(q("[data-testid=generation]")?.textContent).toContain(
      "Generation unconfigured",
    );
    // No engine means no install review or confirmation to offer.
    expect(q("[data-testid=confirm-install]")).toBeNull();
    // Continuing with the base is still valid and returns to the workbench.
    button("Continue with base only").click();
    flushSync();
    expect(q("[data-testid=setup]")).toBeNull();
    expect(q("[data-testid=unavailable-banner]")).not.toBeNull();

    // Skip setup must enter the workbench too, not leave a dead button.
    button("Settings").click();
    flushSync();
    button("Skip setup").click();
    flushSync();
    expect(q("[data-testid=setup]")).toBeNull();
    expect(q("[data-testid=unavailable-banner]")).not.toBeNull();

    button("Extensions").click();
    flushSync();
    expect(q("[data-testid=modules]")).not.toBeNull();
    expect(
      q("[data-testid=modules-engine-unavailable]")?.textContent,
    ).toContain("No setup or module service is connected.");
    expect((q("[data-testid=add-module]") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (q("[data-testid=refresh-catalog]") as HTMLButtonElement).disabled,
    ).toBe(true);

    button("Work").click();
    flushSync();
    expect(q("[data-testid=unavailable-banner]")).not.toBeNull();
  });

  it("mounts the TD-33 session actions disabled with their own reasons", async () => {
    await boot();
    const actions = q("[data-testid=session-actions]")!;
    expect(actions).not.toBeNull();
    expect(q("[data-testid=fork-point]")?.textContent).toBe(
      "No branch selected",
    );
    for (const id of ["resume", "fork", "rewind"]) {
      expect(
        (q(`[data-testid=action-${id}]`) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    const reasons = q("[data-testid=action-reasons]")!.textContent ?? "";
    expect(reasons).toContain(
      "Session revisions are not delivered to the renderer yet.",
    );
    // One stated reason per disabled action, not one shared banner.
    expect(
      q("[data-testid=action-reasons]")!.querySelectorAll("li"),
    ).toHaveLength(3);
    // Initial state: no request can have been produced.
    expect(q("[data-testid=action-busy]")).toBeNull();
    expect(q("[data-testid=rewind-dialog]")).toBeNull();
  });

  it("shows the action target only from the ancestry the tree delivered", async () => {
    ipc.ready = true;
    await boot();
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    q("[role=treeitem]")!.click();
    await settle();

    expect(q("[data-testid=fork-point]")?.textContent).toBe(
      "Fork point: ses_1 / b1",
    );
    expect(q("[data-testid=fork-leaves]")?.textContent).toBe("Leaves: e1");
    // The ancestry is known, but the engine still cannot admit the request.
    expect((q("[data-testid=action-fork]") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("selecting a session follows and subscribes exactly once, and the composer binds to it", async () => {
    ipc.ready = true;
    await boot();
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    const item = q("[role=treeitem]")!;
    expect(item).not.toBeNull();
    item.click();
    await settle();
    item.click(); // re-selecting keeps the channel
    await settle();

    expect(get(selectedSession)).toEqual({
      sessionId: "ses_1",
      scopeId: "scope_1",
    });
    expect(subscribes()).toHaveLength(1);
    expect(subscribes()[0][1]).toMatchObject({ sessionId: "ses_1" });
    // Composer now sees a session; sending stays disabled for an honest reason.
    expect(q("#composer-status")?.textContent).not.toMatch(
      /No session is selected/,
    );
    expect(button("Send").disabled).toBe(true);
  });

  it("keeps Send disabled with a draft and makes no send IPC", async () => {
    ipc.ready = true;
    await boot();
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    q("[role=treeitem]")!.click();
    await settle();
    await chooseProject();
    const ta = q("textarea") as HTMLTextAreaElement;
    ta.value = "hello";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    await settle();
    expect(button("Send").disabled).toBe(true);
    expect(q("#composer-status")?.textContent).toBe(
      "No profile is selected. Use a configured profile first.",
    );
    expect(
      ipc.invoke.mock.calls.filter(
        ([c, a]) =>
          c === "send" && (a as { op: string }).op === "session.prompt",
      ),
    ).toHaveLength(0);
  });

  it("updates generation readiness dynamically without reconnect, clears ports on late exit, and preserves draft", async () => {
    ipc.ready = true;
    await boot();
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    q("[role=treeitem]")!.click();
    await settle();
    await chooseProject();

    const ta = q("textarea") as HTMLTextAreaElement;
    ta.value = "draft preserved across exit";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    // 1. Initial state: readyHandshake has generation: true -> honest wiring gap
    expect(button("Send").disabled).toBe(true);
    expect(q("#composer-status")?.textContent).toBe(
      "No profile is selected. Use a configured profile first.",
    );

    for (const missing of ["provider", "workspace"] as const) {
      dispatchEngineEvent({
        schemaVersion: 1,
        protocolVersion: 2,
        recordId: `rec_${missing}`,
        eventId: `evt_${missing}`,
        createdAt: "2026-10-26T00:00:00.000Z",
        sourceIds: [],
        scopeId: "scope_1",
        sessionId: "ses_1",
        seq: 1,
        durable: true,
        kind: "engine.status",
        payload: {
          state: "ready",
          activeWorkers: 0,
          ports: {
            generation: true,
            provider: true,
            workspace: true,
            modules: true,
            [missing]: false,
          },
        },
      } as SplyceEvent);
      await settle();
      expect(button("Send").disabled).toBe(true);
      expect(q("[data-testid=app-shell]")?.dataset.connectionState).toBe(
        "unavailable",
      );
      expect(
        ipc.invoke.mock.calls.filter(
          ([command, args]) =>
            command === "send" &&
            (args as { op?: string }).op === "session.prompt",
        ),
      ).toHaveLength(0);
      expect(q("#composer-status")?.textContent).toContain(
        missing === "provider"
          ? "Generation unconfigured"
          : "Engine is unavailable",
      );
      if (missing === "workspace")
        expect(document.body.textContent).toContain(
          "Workspace tools unavailable",
        );
    }

    // 2. Dynamic engine.status event with generation: false without reconnect
    dispatchEngineEvent({
      schemaVersion: 1,
      protocolVersion: 2,
      recordId: "rec_status_1",
      eventId: "evt_status_1",
      createdAt: "2026-10-26T00:00:00.000Z",
      sourceIds: [],
      scopeId: "scope_1",
      sessionId: "ses_1",
      seq: 2,
      durable: false,
      kind: "engine.status",
      payload: {
        state: "ready",
        activeWorkers: 0,
        ports: {
          generation: false,
          provider: true,
          workspace: true,
          modules: true,
        },
      },
    } as SplyceEvent);
    await settle();

    // Now generation is false: blocks with generation unconfigured copy
    expect(button("Send").disabled).toBe(true);
    expect(q("#composer-status")?.textContent).toBe(
      "Generation unconfigured. Connect a provider and select a model.",
    );
    expect(ta.value).toBe("draft preserved across exit");

    // 3. Dynamic engine.status event back to generation: true without reconnect
    dispatchEngineEvent({
      schemaVersion: 1,
      protocolVersion: 2,
      recordId: "rec_status_2",
      eventId: "evt_status_2",
      createdAt: "2026-10-26T00:00:00.000Z",
      sourceIds: [],
      scopeId: "scope_1",
      sessionId: "ses_1",
      seq: 3,
      durable: false,
      kind: "engine.status",
      payload: {
        state: "ready",
        activeWorkers: 0,
        ports: {
          generation: true,
          provider: true,
          workspace: true,
          modules: true,
        },
      },
    } as SplyceEvent);
    await settle();

    expect(button("Send").disabled).toBe(true);
    expect(q("#composer-status")?.textContent).toBe(
      "No profile is selected. Use a configured profile first.",
    );
    expect(ta.value).toBe("draft preserved across exit");

    // 4. Late engine exit: clears ports, status disconnected, blocks composer, draft kept
    const nativeHandshake = ipc.invoke.mock.calls
      .filter(([command]) => command === "handshake")
      .at(-1)!;
    nativeHandshake[1].onLifecycle.onmessage({
      protocolVersion: 2,
      kind: "engine_exited",
      expected: false,
      exitCode: 1,
      cleanupComplete: true,
    });
    await settle();

    const shell = q("[data-testid=app-shell]")!;
    expect(shell.dataset.connectionState).toBe("disconnected");
    expect(shell.dataset.readinessGeneration).toBe("unknown");
    expect(button("Send").disabled).toBe(true);
    expect(q("#composer-status")?.textContent).toBe("Engine is not connected.");
    expect(ta.value).toBe("draft preserved across exit");
  });

  async function dropAndRecover() {
    ipc.ready = false;
    await engineHandshake().catch(() => {});
    await settle();
    ipc.ready = true;
    button("Retry").click();
    await settle();
  }

  it("keeps the selection and binding across Retry when no snapshot arrives", async () => {
    ipc.ready = true;
    await boot();
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    q("[role=treeitem]")!.click();
    await settle();
    await dropAndRecover();
    expect(q("[data-testid=lost-selection]")).toBeNull();
    expect(get(selectedSession)?.sessionId).toBe("ses_1");
    expect(q("[role=treeitem]")?.getAttribute("aria-selected")).toBe("true");
    expect(subscribes()).toHaveLength(1);
  });

  it("mounts the TD-30 approval surface without claiming a pending approval", async () => {
    await boot();
    expect(q("[data-testid=approval-dialog]")).toBeNull();
    expect(q("[data-testid=approval-submitted]")).toBeNull();
    expect(document.body.textContent).not.toContain("Approval required");
  });

  it("mounts the Supervisor permission mode disabled with the revision reason", async () => {
    await boot();
    button("Settings").click();
    flushSync();
    const supervisor = q("[data-testid=supervisor]")!;
    expect(supervisor.textContent).toContain("Supervisor");
    const select = supervisor.querySelector<HTMLSelectElement>(
      "[data-testid=permission-mode-select]",
    )!;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("manual");
    expect(
      supervisor.querySelector("[data-testid=permission-blocked]")?.textContent,
    ).toContain("Start a ready session to change permissions.");
    expect(
      supervisor.querySelector("[data-testid=permission-effective]")
        ?.textContent,
    ).toContain("Manual");
    // A disabled control must not report a mode change.
    expect(
      supervisor.querySelector("[data-testid=permission-pending]"),
    ).toBeNull();
  });

  it("clears the selection when a real snapshot lacks the session", async () => {
    ipc.ready = true;
    const snapshots = [[treeEvent("ses_1", "scope_1")], []];
    await boot({ loadSessions: async () => snapshots.shift() ?? [] });
    q("[role=treeitem]")!.click();
    await settle();
    expect(get(selectedSession)?.sessionId).toBe("ses_1");
    await dropAndRecover();
    expect(q("[data-testid=lost-selection]")).not.toBeNull();
    expect(get(selectedSession)).toBeNull();
  });

  it("keeps Send blocked until a project is chosen, then shows the next honest gap", async () => {
    ipc.ready = true;
    await boot();
    dispatchEngineEvent(treeEvent("ses_1", "scope_1"));
    await settle();
    q("[role=treeitem]")!.click();
    await settle();
    expect(q("#composer-status")?.textContent).toBe(
      "No project is selected. Choose a project first.",
    );
    expect(button("Send").disabled).toBe(true);
    await chooseProject();
    expect(q("#composer-status")?.textContent).toBe(
      "No profile is selected. Use a configured profile first.",
    );
  });

  it("disables the project chooser with a reason until the engine is connected", async () => {
    await boot();
    expect(button("Choose project").disabled).toBe(true);
    expect(q("#project-status")?.textContent).toContain(
      "engine is not connected",
    );
    expect(
      ipc.invoke.mock.calls.filter(([c]) => c === "dialog_select_workspace"),
    ).toHaveLength(0);
  });

  it("shows only the display name of a chosen project and keeps it on cancel", async () => {
    ipc.ready = true;
    await boot();
    expect(q("[data-testid=project-name]")?.textContent).toBe("Choose project");
    await chooseProject();
    expect(q("[data-testid=project-name]")?.textContent).toBe("splyce-demo");
    // Cancel returns null: the chosen project stays.
    await chooseProject(null);
    expect(q("[data-testid=project-name]")?.textContent).toBe("splyce-demo");
    expect(q("#project-status")?.textContent).toBe("");
    // A malformed native reply changes nothing and shows fixed copy.
    await chooseProject({ selectionRef: "x", workspace: { workspaceId: "" } });
    expect(q("[data-testid=project-name]")?.textContent).toBe("splyce-demo");
    expect(q("#project-status")?.textContent).toBe(
      "Could not open the project. Nothing changed.",
    );
    expect(document.body.innerHTML).not.toMatch(/ws_1|rev_1|admittedAt/);
  });

  it("the chooser bridge keeps only the workspace id and display name", async () => {
    ipc.selection = admitted;
    expect(await selectWorkspace()).toStrictEqual({
      workspaceId: "ws_1",
      displayName: "splyce-demo",
    });
    ipc.selection = null;
    expect(await selectWorkspace()).toBeNull();
    expect(
      ipc.invoke.mock.calls.filter(([c]) => c === "dialog_select_workspace"),
    ).toEqual([["dialog_select_workspace"], ["dialog_select_workspace"]]);
  });

  describe("provider.configure", () => {
    const SECRET = "sk-app-secret-987";
    const providerPorts = {
      generation: false,
      provider: true,
      workspace: false,
      modules: false,
    };

    async function openSetup() {
      ipc.ready = true;
      await boot();
      dispatchEngineEvent({
        schemaVersion: 1,
        protocolVersion: 2,
        recordId: "rec_p",
        eventId: "evt_p",
        createdAt: "2026-10-28T00:00:00.000Z",
        sourceIds: [],
        scopeId: "scope_1",
        sessionId: "ses_1",
        seq: 1,
        durable: false,
        kind: "engine.status",
        payload: { state: "ready", activeWorkers: 0, ports: providerPorts },
      } as SplyceEvent);
      await settle();
      button("Models").click();
      flushSync();
    }

    function fillAndSubmit() {
      const set = (id: string, value: string) => {
        const el = q(`#${id}`) as HTMLInputElement;
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set("setup-endpoint", "http://localhost:11434/v1/");
      set("setup-model", "qwen3:8b");
      set("setup-context", "32768");
      set("setup-output", "4096");
      set("setup-key", SECRET);
      (q("#setup-image") as HTMLInputElement).click();
      flushSync();
      (
        q('form[aria-label="Provider setup"]') as HTMLFormElement
      ).requestSubmit();
      flushSync();
    }

    const setupSends = () =>
      ipc.invoke.mock.calls.filter(
        ([c, a]) =>
          c === "send" && (a as { op: string }).op === "provider.configure",
      );

    it("requires a chosen project before the form can send", async () => {
      await openSetup();
      expect(button("Save provider").disabled).toBe(true);
      expect(q("#setup-note")?.textContent).toContain("Choose a project first");
    });

    it("sends the exact frozen payload once, then clears the key", async () => {
      await openSetup();
      await chooseProject();
      expect(button("Save provider").disabled).toBe(false);
      const log = vi.spyOn(console, "log");
      fillAndSubmit();
      await settle();
      expect(setupSends()).toHaveLength(1);
      const args = setupSends()[0]![1] as {
        op: string;
        payload: Record<string, unknown>;
      };
      expect(Object.keys(args).sort()).toEqual(["op", "payload"]);
      expect(args.op).toBe("provider.configure");
      const frame = args.payload;
      expect(Object.keys(frame).sort()).toEqual([
        "command",
        "frame",
        "payload",
        "requestId",
      ]);
      expect(frame.frame).toBe("setup");
      expect(frame.command).toBe("provider.configure");
      expect(frame.requestId).toMatch(/^[0-9a-f-]{36}$/);
      const payload = frame.payload as Record<string, unknown>;
      expect(payload).toStrictEqual({
        requestId: frame.requestId,
        workspaceId: "ws_1",
        providerConnectionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        profileId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        apiFamily: "openai-completions",
        endpoint: "http://localhost:11434/v1",
        locality: "loopback",
        chat: {
          modelId: "qwen3:8b",
          model: {
            contextWindow: 32768,
            maxOutputTokens: 4096,
            reasoning: false,
            input: ["text", "image"],
          },
        },
        accountScopeRef: "provider-default",
        credential: { kind: "new", secret: SECRET },
        expectedConnectionRevision: null,
        expectedProfileRevision: null,
        expectedEndpointRevision: null,
      });
      expect(payload.providerConnectionId).not.toBe(payload.profileId);
      expect((q("#setup-key") as HTMLInputElement).value).toBe("");
      expect(q("#connect-status")?.textContent).toContain("Provider saved");
      expect(document.body.innerHTML).not.toContain(SECRET);
      expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
      log.mockRestore();
    });

    it("maps a native rejection to typed copy and clears the key", async () => {
      await openSetup();
      await chooseProject();
      ipc.setup = async () => {
        throw {
          code: "STALE_REVISION",
          message: `C:\\private\\path ${SECRET}`,
          correlationId: "r",
          retryable: false,
        };
      };
      fillAndSubmit();
      await settle();
      expect(setupSends()).toHaveLength(1);
      expect(q("#connect-status")?.textContent).toContain(
        "changed since this form was opened",
      );
      expect((q("#setup-key") as HTMLInputElement).value).toBe("");
      expect(document.body.innerHTML).not.toMatch(/private|sk-app/);
    });
  });
});

describe("approved prototype shell", () => {
  it("shows unavailable history until real session records arrive", async () => {
    ipc.ready = true;
    await boot();
    const history = q("[data-testid=session-tree]")!;
    expect(history.textContent).toContain("Session history is unavailable");
    expect(history.textContent).not.toMatch(/Loading sessions|No sessions yet/);
    dispatchEngineEvent(treeEvent("received_session", "received_scope"));
    await settle();
    expect(q("[role=treeitem]")?.textContent).toContain("received_session");
  });

  it("renders Work first with the approved hero and truthful unavailable pages", async () => {
    await boot();
    const links = [
      ...document.querySelectorAll('[aria-label="Workspace"] button'),
    ];
    expect(links.map((b) => b.textContent?.trim())).toEqual([
      "Work",
      "Runs",
      "Memory",
      "Models",
      "Extensions",
      "Settings",
    ]);
    expect(q("h1 em")?.textContent).toBe("Evidence by design.");
    expect(document.body.textContent).not.toContain("payments-api");
    expect(document.body.textContent).toContain("Pi engine · unavailable");
    button("Memory").click();
    flushSync();
    expect(q("[data-testid=memory-empty]")?.textContent).toContain(
      "Memory is unavailable",
    );
    button("Models").click();
    flushSync();
    expect(document.body.textContent).toContain(
      "Choose a configured profile to load its models.",
    );
    expect(document.querySelectorAll("main")).toHaveLength(1);
    button("Runs").click();
    flushSync();
    expect(
      document.querySelectorAll("[data-testid=session-tree]"),
    ).toHaveLength(1);
    expect(q("[data-testid=session-tree]")?.textContent).toContain(
      "could not be loaded",
    );
    expect(
      ipc.invoke.mock.calls.filter(([command]) => command === "send"),
    ).toHaveLength(0);
  });

  it("preserves the unsent draft across navigation and exposes runtime setup", async () => {
    await boot();
    const input = q("textarea") as HTMLTextAreaElement;
    input.value = "keep this task";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    button("Configure runtime").click();
    flushSync();
    expect(q(".work-panel")?.hidden).toBe(true);
    expect(q("[data-testid=providers-view]")).not.toBeNull();
    button("Work").click();
    flushSync();
    expect(q(".work-panel")?.hidden).toBe(false);
    expect(q("textarea")).toBe(input);
    expect(input.value).toBe("keep this task");
    expect(button("Send").disabled).toBe(true);
  });

  it("toggles the theme and collapses the sidebar using the keyboard", async () => {
    await boot();
    button("Switch to dark theme").click();
    flushSync();
    expect(document.documentElement.dataset.theme).toBe("dark");
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", ctrlKey: true }),
    );
    await settle();
    expect(q("#app-sidebar")?.inert).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Open sidebar",
    );
    button("Open sidebar").click();
    await settle();
    expect(q("#app-sidebar")?.inert).toBe(false);
    button("Switch to light theme").click();
    flushSync();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("keeps mobile navigation focus inside the drawer and restores it on Escape", async () => {
    window.innerWidth = 390;
    await boot();
    button("Open navigation").click();
    await settle();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close navigation",
    );
    expect(q("main")?.inert).toBe(true);
    button("Switch to dark theme").focus();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", cancelable: true }),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Close navigation",
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(q("main")?.inert).toBe(false);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Open navigation",
    );
  });
});
