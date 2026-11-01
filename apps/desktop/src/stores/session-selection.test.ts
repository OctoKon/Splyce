import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import type { SplyceEventEnvelope } from "@splyce/pi/contracts";
import {
  bindSelection,
  clearSession,
  selectedSession,
  selectSession,
} from "./session-selection";
import { createTurnStreamTransport } from "./turns";

function started(sessionId: string, scopeId: string): SplyceEventEnvelope {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    recordId: "rec_1",
    eventId: `evt_${sessionId}_${scopeId}`,
    createdAt: "2026-10-26T00:00:00.000Z",
    sourceIds: [],
    scopeId,
    sessionId,
    seq: 1,
    durable: true,
    kind: "turn.started",
    payload: { runId: `run_${sessionId}`, turnId: "turn_1" },
  } as unknown as SplyceEventEnvelope;
}

function setup() {
  const calls: string[] = [];
  const subscribe = async (sessionId: string, afterSeq?: number) => {
    calls.push(`subscribe ${sessionId} ${afterSeq}`);
    return () => {
      calls.push(`dispose ${sessionId}`);
    };
  };
  const transport = createTurnStreamTransport({ schedule: () => {} });
  const binding = bindSelection(transport, subscribe);
  return { calls, transport, binding };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("session selection binding", () => {
  it("rejects events and subscribes to nothing while no session is selected", async () => {
    clearSession();
    const { calls, transport, binding } = setup();
    transport.enqueue(started("s1", "scopeA"));
    await settle();

    expect(transport.rejectedCount()).toBe(1);
    expect(calls).toEqual([]);
    binding.dispose();
  });

  it("follows and subscribes to the selected session and rejects every other", async () => {
    clearSession();
    const { calls, transport, binding } = setup();
    selectSession({ sessionId: "s1", scopeId: "scopeA" });
    await settle();

    transport.enqueue(started("s2", "scopeA"));
    transport.enqueue(started("s1", "scopeB"));
    transport.enqueue(started("s1", "scopeA"));
    const state = transport.flush();

    expect(calls).toEqual(["subscribe s1 0"]);
    expect(transport.rejectedCount()).toBe(2);
    expect(state.runs.run_s1).toBeDefined();
    binding.dispose();
  });

  it("disposes the previous subscription before following the next session", async () => {
    clearSession();
    const { calls, transport, binding } = setup();
    selectSession({ sessionId: "s1", scopeId: "scopeA" });
    await settle();
    selectSession({ sessionId: "s2", scopeId: "scopeA" });
    await settle();

    expect(calls).toEqual(["subscribe s1 0", "dispose s1", "subscribe s2 0"]);
    transport.enqueue(started("s1", "scopeA"));
    transport.enqueue(started("s2", "scopeA"));
    const state = transport.flush();
    expect(transport.rejectedCount()).toBe(1);
    expect(state.runs.run_s2).toBeDefined();
    expect(state.runs.run_s1).toBeUndefined();
    binding.dispose();
  });

  it("disposes the subscription and stops following when the selection clears", async () => {
    clearSession();
    const { calls, transport, binding } = setup();
    selectSession({ sessionId: "s1", scopeId: "scopeA" });
    await settle();
    clearSession();
    await settle();

    expect(calls).toEqual(["subscribe s1 0", "dispose s1"]);
    transport.enqueue(started("s1", "scopeA"));
    expect(transport.rejectedCount()).toBe(1);
    expect(get(selectedSession)).toBeNull();
    binding.dispose();
  });

  it("re-subscribes only the selected session on recovery", async () => {
    clearSession();
    const { calls, binding } = setup();
    selectSession({ sessionId: "s1", scopeId: "scopeA" });
    await settle();
    await binding.resubscribe("s2", 7);
    await binding.resubscribe("s1", 7);

    expect(calls).toEqual(["subscribe s1 0", "dispose s1", "subscribe s1 7"]);
    binding.dispose();
  });

  it("surfaces a rejected subscribe as failed state and goes live on retry", async () => {
    clearSession();
    let fail = true;
    const calls: string[] = [];
    const transport = createTurnStreamTransport({ schedule: () => {} });
    const binding = bindSelection(transport, async (sessionId) => {
      calls.push(sessionId);
      if (fail) throw new Error("engine offline");
      return () => {};
    });
    selectSession({ sessionId: "s1", scopeId: "scopeA" });
    await settle();

    expect(get(binding.status)).toEqual({
      state: "failed",
      error: "engine offline",
    });

    fail = false;
    await binding.retry();
    expect(get(binding.status)).toEqual({ state: "live" });
    expect(calls).toEqual(["s1", "s1"]);
    binding.dispose();
  });

  it("ignores re-selecting the same session but restarts on A to B to A", async () => {
    clearSession();
    const { calls, transport, binding } = setup();
    selectSession({ sessionId: "s1", scopeId: "scopeA" });
    await settle();
    transport.enqueue(started("s1", "scopeA"));
    transport.flush();
    selectSession({ sessionId: "s1", scopeId: "scopeA" });
    await settle();

    expect(calls).toEqual(["subscribe s1 0"]);
    expect(transport.current("s1").runs.run_s1).toBeDefined();

    // Deliberate: switching away and back drops the channel and replays from the cursor.
    selectSession({ sessionId: "s2", scopeId: "scopeA" });
    selectSession({ sessionId: "s1", scopeId: "scopeA" });
    await settle();
    expect(calls.filter((c) => c === "subscribe s1 0")).toHaveLength(2);
    binding.dispose();
  });
});
