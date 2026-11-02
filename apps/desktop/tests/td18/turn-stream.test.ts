import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type {
  EventKind,
  EventPayloads,
  SplyceEventEnvelope,
} from "@splyce/pi/contracts";
import TurnStream from "../../src/components/TurnStream.svelte";
import {
  createTurnsState,
  reduceTurns,
  type TurnsState,
} from "../../src/stores/turns";

type GuiFixture = {
  eventSequence: { event: SplyceEventEnvelope }[];
};

function guiFixture(file: string): GuiFixture {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), "../../tests/fixtures/gui", file),
      "utf8",
    ),
  ) as GuiFixture;
}

function event<K extends EventKind>(
  seq: number,
  kind: K,
  payload: EventPayloads[K],
  durable = kind !== "turn.stream_delta" && kind !== "turn.thought_delta",
): SplyceEventEnvelope {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    recordId: `rec_${seq}`,
    eventId: `evt_${seq}`,
    createdAt: "2026-10-26T00:00:00.000Z",
    sourceIds: [],
    scopeId: "scope_spec",
    sessionId: "ses_spec",
    seq,
    durable,
    kind,
    payload,
  } as unknown as SplyceEventEnvelope;
}

function applyAll(events: SplyceEventEnvelope[]): TurnsState {
  return events.reduce(
    (state, step) => reduceTurns(state, step),
    createTurnsState(),
  );
}

function started(seq = 1): SplyceEventEnvelope {
  return event(seq, "turn.started", { runId: "run_a", turnId: "turn_a" });
}

function text(seq: number, delta: string): SplyceEventEnvelope {
  return event(
    seq,
    "turn.stream_delta",
    {
      runId: "run_a",
      delta,
      turnId: "turn_a",
    } as EventPayloads["turn.stream_delta"],
    false,
  );
}

function intent(seq = 2): SplyceEventEnvelope {
  return event(seq, "turn.tool_intent", {
    runId: "run_a",
    actionId: "act_1",
    capabilityId: "cap_fs_read_tree",
    target: "target_desktop_src",
    argsSummary: "depth: 2, filter: '*.svelte'",
  });
}

function approval(seq = 3): SplyceEventEnvelope {
  return event(seq, "approval.requested", {
    approvalRequestId: "appr_1",
    runId: "run_a",
    actionId: "act_1",
    capabilityId: "cap_fs_read_tree",
    targetScope: "target_desktop_src",
    normalizedTarget: "target_desktop_src",
    riskRationale: "Reads workspace tree.",
  });
}

let app: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  document.body.innerHTML = "";
});

function render(
  run: TurnsState["runs"][string],
  props: Partial<{
    stale: boolean;
    showApprovalControls: boolean;
    canRespond: (actionId: string) => boolean;
    onApproval: (
      approvalRequestId: string,
      runId: string,
      actionId: string,
      decision: "approve" | "deny",
    ) => void;
  }> = {},
) {
  const target = document.createElement("div");
  document.body.append(target);
  app = mount(TurnStream, {
    target,
    props: { run, onApproval: props.onApproval ?? (() => {}), ...props },
  });
  flushSync();
}

describe("TurnStream component", () => {
  it("renders the FUI-W4 interleaved transcript with exact text and one attributed card", () => {
    const fixture = guiFixture("fui-w4-stream-backpressure.json");
    const state = applyAll(fixture.eventSequence.map((step) => step.event));
    const run = state.runs.run_w4_01;

    render(run);

    const stream = document.querySelector('[data-testid="turn-stream"]');
    expect(stream?.getAttribute("data-status")).toBe("completed");

    const visibleText = [
      ...document.querySelectorAll('[data-testid="turn-text"]'),
    ]
      .map((node) => node.textContent ?? "")
      .join("");
    expect(visibleText).toBe(run.text);

    const cards = document.querySelectorAll('[data-testid="tool-card"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.getAttribute("data-action-id")).toBe("act_w4_scan");
    expect(cards[0]?.textContent).toContain("Outcome:");
  });

  it("never shows requested arguments as an executed outcome", () => {
    const state = applyAll([started(), intent()]);
    render(state.runs.run_a);

    const card = document.querySelector('[data-testid="tool-card"]');
    expect(card?.textContent).toContain("Pending - not executed");
    expect(card?.textContent).toContain("Requested arguments");
    expect(card?.textContent).not.toContain("Outcome:");
  });

  it("focuses Deny and resolves Escape/Y through the ApprovalCard", async () => {
    const onApproval = vi.fn();
    render(applyAll([started(), intent(), approval()]).runs.run_a, {
      canRespond: () => true,
      onApproval,
    });

    const deny = document.querySelector<HTMLButtonElement>(
      '[data-testid="approval-deny-button"]',
    );
    expect(document.activeElement).toBe(deny);

    deny?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();

    expect(onApproval).toHaveBeenCalledWith("appr_1", "run_a", "act_1", "deny");
    expect(
      document.querySelector('[data-testid="approval-deny-button"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain("Resolved: Denied");
  });

  it("sends approve from Y without moving focus first", async () => {
    const onApproval = vi.fn();
    render(applyAll([started(), intent(), approval()]).runs.run_a, {
      canRespond: () => true,
      onApproval,
    });

    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "y",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();

    expect(onApproval).toHaveBeenCalledWith(
      "appr_1",
      "run_a",
      "act_1",
      "approve",
    );
    expect(document.body.textContent).toContain("Resolved: Approved");
  });

  it("neutralizes approval controls when the engine stream is stale", () => {
    render(applyAll([started(), intent(), approval()]).runs.run_a, {
      stale: true,
      canRespond: () => false,
    });

    expect(
      document.querySelector('[data-testid="approval-deny-button"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="approval-allow-button"]'),
    ).toBeNull();
    expect(document.body.textContent).toContain("Approval closed");
    expect(document.body.textContent).toContain("Engine stopped");
  });

  it("does not render approval controls without an authoritative command context", () => {
    render(applyAll([started(), intent(), approval()]).runs.run_a, {
      showApprovalControls: false,
    });

    expect(
      document.querySelector('[data-testid="approval-deny-button"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="approval-allow-button"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Approval controls are not available",
    );
  });

  it("keeps partial text visible on cancel and announces the stop", () => {
    const state = applyAll([
      started(),
      text(2, "partial answer"),
      event(3, "turn.canceled", { runId: "run_a", cleanedUp: true }),
    ]);
    render(state.runs.run_a);

    expect(
      document.querySelector('[data-testid="turn-text"]')?.textContent,
    ).toBe("partial answer");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Run was canceled.",
    );
  });
});
