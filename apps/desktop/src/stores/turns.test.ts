import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  EventKind,
  EventPayloads,
  SplyceEventEnvelope,
} from "@splyce/pi/contracts";
import { describe, expect, it } from "vitest";
import {
  approvalRequestIdFor,
  canRespondToApproval,
  createTurnStreamTransport,
  createTurnsState,
  reduceTurns,
  resyncRequest,
  TRANSPORT_LIMITS,
  type TurnsState,
} from "./turns";

function event<K extends EventKind>(
  seq: number,
  kind: K,
  payload: EventPayloads[K],
  durable = kind !== "turn.stream_delta" && kind !== "turn.thought_delta",
  sessionId = "ses_spec",
): SplyceEventEnvelope {
  return {
    schemaVersion: 1,
    protocolVersion: 2,
    recordId: `rec_${seq}`,
    eventId: `evt_${seq}`,
    createdAt: "2026-10-26T00:00:00.000Z",
    sourceIds: [],
    scopeId: "scope_spec",
    sessionId,
    seq,
    durable,
    kind,
    payload,
  } as unknown as SplyceEventEnvelope;
}

function applyAll(
  state: TurnsState,
  envelopes: SplyceEventEnvelope[],
): TurnsState {
  return envelopes.reduce(
    (current, envelope) => reduceTurns(current, envelope),
    state,
  );
}

const started = (runId = "run_a", turnId = "turn_a"): SplyceEventEnvelope =>
  event(1, "turn.started", { runId, turnId });

function delta(
  seq: number,
  text: string,
  runId = "run_a",
  turnId = "turn_a",
): SplyceEventEnvelope {
  return event(
    seq,
    "turn.stream_delta",
    { runId, delta: text, turnId } as EventPayloads["turn.stream_delta"],
    false,
  );
}

const completed = (seq: number, runId = "run_a"): SplyceEventEnvelope =>
  event(seq, "turn.completed", {
    runId,
    candidateSnapshotId: "snap_clean",
    finalRevision: "rev_1",
  });

const toolIntent = (seq: number, actionId = "act_1"): SplyceEventEnvelope =>
  event(seq, "turn.tool_intent", {
    runId: "run_a",
    actionId,
    capabilityId: "fs.read_tree",
    target: "target_desktop_src",
    argsSummary: "depth: 2",
  });

const snapshot = (
  seq: number,
  state: "ready" | "busy" | "waiting_approval" | "stopped" = "busy",
): SplyceEventEnvelope =>
  event(seq, "run.reconnect_snapshot", {
    runId: "run_a",
    lastDurableSeq: seq - 1,
    turnId: "turn_a",
    activeActionIds: [],
    state,
  });

type GuiFixture = {
  caseId: string;
  eventSequence: { delayMs: number; event: SplyceEventEnvelope }[];
  assertions: {
    expectedState: { runStatus: string; visibleToolCards: number };
  };
};

function guiFixture(file: string): GuiFixture {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), "../../tests/fixtures/gui", file),
      "utf8",
    ),
  ) as GuiFixture;
}

describe("FUI-W4 stream & backpressure semantics", () => {
  it("reconstructs the exact interleaved text, card and terminal state", () => {
    const fixture = guiFixture("fui-w4-stream-backpressure.json");
    const state = applyAll(
      createTurnsState(),
      fixture.eventSequence.map((step) => step.event),
    );
    const run = state.runs.run_w4_01;

    expect(run).toBeDefined();
    expect(run.status).toBe(fixture.assertions.expectedState.runStatus);
    expect(run.text).toBe(
      "I will inspect the local repository structure.\n\nScan completed successfully. Found 14 Svelte components.",
    );
    expect(run.thought).toBe(
      "Analyzing directory layout and package dependencies.",
    );
    expect(run.actions).toHaveLength(
      fixture.assertions.expectedState.visibleToolCards,
    );
    expect(run.actions[0]).toMatchObject({
      actionId: "act_w4_scan",
      capabilityId: "cap_fs_read_tree",
      status: "success",
      outcomeRef: "ref_fs_tree_result",
    });
    expect(run.blocks.map((block) => block.type)).toEqual([
      "thought",
      "text",
      "tool",
      "text",
    ]);
    expect(run.blocks[0]).toMatchObject({
      type: "thought",
      text: "Analyzing directory layout and package dependencies.",
    });
    expect(run.blocks[1]).toMatchObject({
      type: "text",
      text: "I will inspect the local repository structure.\n\n",
    });
    expect(run.blocks[2]).toMatchObject({
      type: "tool",
      actionId: "act_w4_scan",
    });
    expect(run.blocks[3]).toMatchObject({
      type: "text",
      text: "Scan completed successfully. Found 14 Svelte components.",
    });
    expect(state.lastDurableSeq).toBe(7);
    expect(state.needsResync).toBe(false);
    expect(state).toMatchObject({
      resyncCount: 0,
      duplicateCount: 0,
      unknownKindCount: 0,
      protocolErrors: 0,
    });
  });

  it("retains the optional outcome summary without inventing absent fields", () => {
    const state = applyAll(createTurnsState(), [
      started(),
      toolIntent(2),
      event(3, "turn.tool_outcome", {
        runId: "run_a",
        actionId: "act_1",
        status: "success",
        outcomeRef: "ref_1",
        summary: {
          exitCode: 1,
          durationMs: 42,
          bytes: 64,
          truncated: true,
          preview: "first line\nsecond line",
        },
      } as unknown as EventPayloads["turn.tool_outcome"]),
    ]);

    expect(state.runs.run_a.actions[0].summary).toEqual({
      exitCode: 1,
      durationMs: 42,
      bytes: 64,
      truncated: true,
      preview: "first line\nsecond line",
    });

    const current = applyAll(createTurnsState(), [
      started(),
      toolIntent(2),
      event(3, "turn.tool_outcome", {
        runId: "run_a",
        actionId: "act_1",
        status: "success",
        outcomeRef: "ref_1",
      }),
    ]);
    expect(current.runs.run_a.actions[0].summary).toBeUndefined();
  });

  it("drops malformed optional summary fields instead of displaying them", () => {
    const state = applyAll(createTurnsState(), [
      started(),
      toolIntent(2),
      event(3, "turn.tool_outcome", {
        runId: "run_a",
        actionId: "act_1",
        status: "success",
        summary: {
          exitCode: "0",
          durationMs: -1,
          bytes: 1.5,
          truncated: "yes",
          preview: 42,
        },
      } as unknown as EventPayloads["turn.tool_outcome"]),
    ]);

    expect(state.runs.run_a.actions[0].summary).toBeUndefined();
  });

  it("keeps a 10x render-rate burst lossless and requests no resync", () => {
    const burst = Array.from({ length: 10_000 }, (_, index) =>
      delta(index + 2, "x"),
    );
    const state = applyAll(createTurnsState(), [
      started(),
      ...burst,
      completed(10_002),
    ]);

    expect(state.runs.run_a.text).toHaveLength(10_000);
    expect(state.runs.run_a.text).toBe("x".repeat(10_000));
    expect(state.runs.run_a.status).toBe("completed");
    expect(state.lastSeq).toBe(10_002);
    expect(state.needsResync).toBe(false);
    expect(state.resyncCount).toBe(0);
  });
});

describe("FUI-W5 approval race semantics", () => {
  it("closes a stale approval on cancel and refuses a late response", () => {
    const fixture = guiFixture("fui-w5-approval-race.json");
    const state = applyAll(
      createTurnsState(),
      fixture.eventSequence.map((step) => step.event),
    );
    const run = state.runs.run_w5_race;

    expect(run.status).toBe(fixture.assertions.expectedState.runStatus);
    expect(run.actions).toHaveLength(1);
    expect(run.actions[0].approval?.state).toBe("canceled");
    expect(run.actions[0].status).toBe("canceled");
    expect(canRespondToApproval(state, "act_w5_exec")).toBe(false);
    expect(approvalRequestIdFor(state, "act_w5_exec")).toBe("app_req_w5_01");
    expect(run.actions[0].outcomeRef).toBeUndefined();
  });

  it("exposes the approval request id and settles to streaming after intent", () => {
    const state = applyAll(createTurnsState(), [
      started(),
      event(2, "approval.requested", {
        approvalRequestId: "apr_1",
        runId: "run_a",
        actionId: "act_1",
        capabilityId: "shell.execute",
        targetScope: "scope_spec",
        normalizedTarget: "F:/test/Splyce/scripts/deploy.sh",
        riskRationale: "Deploy script execution.",
      }),
      event(3, "turn.tool_intent", {
        runId: "run_a",
        actionId: "act_1",
        capabilityId: "shell.execute",
        target: "scripts/deploy.sh",
        argsSummary: "./deploy.sh",
      }),
    ]);

    expect(state.runs.run_a.actions[0].approval?.state).toBe("allowed");
    expect(state.runs.run_a.blocks).toHaveLength(1);
    expect(state.runs.run_a.blocks[0]).toMatchObject({
      type: "tool",
      actionId: "act_1",
    });
    expect(state.runs.run_a.status).toBe("streaming");
    expect(canRespondToApproval(state, "act_1")).toBe(false);
  });
});

describe("ordering, replay and attribution", () => {
  it("ignores a duplicate eventId and never appends the same text twice", () => {
    const first = started();
    const state = applyAll(createTurnsState(), [
      first,
      first,
      delta(2, "once"),
    ]);

    expect(state.runs.run_a.text).toBe("once");
    expect(state.duplicateCount).toBe(1);
  });

  it("refuses a completion after a gap, then accepts one resync snapshot", () => {
    const gapped = applyAll(createTurnsState(), [started(), completed(3)]);

    expect(gapped.runs.run_a.status).toBe("streaming");
    expect(gapped.needsResync).toBe(true);
    expect(gapped.resyncFromSeq).toBe(2);
    expect(gapped.resyncCount).toBe(0);
    expect(resyncRequest(gapped)).toEqual({ afterSeq: 1 });

    const reconciled = reduceTurns(gapped, snapshot(4));
    expect(reconciled.needsResync).toBe(false);
    expect(reconciled.resyncCount).toBe(1);
    expect(resyncRequest(reconciled)).toBeNull();

    const late = reduceTurns(reconciled, delta(2, "late"));
    expect(late.runs.run_a.text).toBe("");
    expect(late.duplicateCount).toBe(1);

    const done = reduceTurns(late, completed(5));
    expect(done.runs.run_a.status).toBe("completed");
  });

  it("applies durable replay below the transient high-water mark after a snapshot", () => {
    const state = applyAll(createTurnsState(), [
      started(),
      delta(2, "partial"),
      event(5, "run.reconnect_snapshot", {
        runId: "run_a",
        lastDurableSeq: 2,
        activeActionIds: ["act_replay"],
        state: "busy",
      }),
      event(3, "turn.tool_intent", {
        runId: "run_a",
        actionId: "act_replay",
        capabilityId: "fs.read_tree",
        target: "apps/desktop/src",
        argsSummary: "depth: 2",
      }),
      event(4, "turn.tool_outcome", {
        runId: "run_a",
        actionId: "act_replay",
        status: "success",
        outcomeRef: "ref_replay",
      }),
    ]);

    expect(state.needsResync).toBe(false);
    expect(state.lastDurableSeq).toBe(4);
    expect(state.lastSeq).toBe(5);
    expect(state.runs.run_a.actions[0]).toMatchObject({
      actionId: "act_replay",
      status: "success",
    });
  });

  it("keeps a late completion on its own run without completing the current run", () => {
    const state = applyAll(createTurnsState(), [
      started("run_a", "turn_a"),
      event(2, "turn.started", { runId: "run_b", turnId: "turn_b" }),
      completed(3, "run_a"),
    ]);

    expect(state.currentRunId).toBe("run_b");
    expect(state.runs.run_a.status).toBe("completed");
    expect(state.runs.run_b.status).toBe("streaming");
  });

  it("counts an unknown kind and keeps the sequence moving", () => {
    const unknown = {
      ...event(2, "turn.started", { runId: "run_a", turnId: "turn_a" }),
      kind: "future.event",
      payload: { anything: true },
    } as unknown as SplyceEventEnvelope;
    const state = applyAll(createTurnsState(), [
      started(),
      unknown,
      delta(3, "after unknown"),
    ]);

    expect(state.unknownKindCount).toBe(1);
    expect(state.runs.run_a.text).toBe("after unknown");
    expect(state.needsResync).toBe(false);
  });

  it("rejects a delta that arrives before turn.started", () => {
    const state = applyAll(createTurnsState(), [delta(1, "orphan")]);

    expect(state.runs.run_a).toBeUndefined();
    expect(state.protocolErrors).toBe(1);
  });

  it("preserves partial text and cards through cancel", () => {
    const state = applyAll(createTurnsState(), [
      started(),
      delta(2, "partial answer"),
      toolIntent(3, "act_cancel"),
      event(4, "turn.canceled", { runId: "run_a", cleanedUp: true }),
    ]);

    expect(state.runs.run_a.text).toBe("partial answer");
    expect(state.runs.run_a.actions).toHaveLength(1);
    expect(state.runs.run_a.actions[0].status).toBe("canceled");
    expect(state.runs.run_a.cleanedUp).toBe(true);
  });

  it("never applies an unresolved durable payload and marks the projection stale", () => {
    const { payload: _payload, ...rest } = event(2, "turn.completed", {
      runId: "run_a",
      candidateSnapshotId: "snap",
      finalRevision: "rev",
    });
    const reference = {
      ...rest,
      payloadArtifactId: "art_1",
    } as unknown as SplyceEventEnvelope;
    const state = applyAll(createTurnsState(), [started(), reference]);

    expect(state.runs.run_a.status).toBe("streaming");
    expect(state.stale).toBe(true);
    expect(state.unresolvedPayloadCount).toBe(1);
    expect(state.pendingPayloadIds).toEqual(["evt_2"]);
    expect(state.lastSeq).toBe(2);
  });

  it("skips a transient artifact ref without staling the stream", () => {
    const { payload: _payload, ...rest } = delta(2, "unused");
    const reference = {
      ...rest,
      payloadArtifactId: "art_2",
    } as unknown as SplyceEventEnvelope;
    const state = applyAll(createTurnsState(), [started(), reference]);

    expect(state.runs.run_a.text).toBe("");
    expect(state.stale).toBe(false);
    expect(state.unresolvedPayloadCount).toBe(1);
    expect(state.pendingPayloadIds).toEqual([]);
  });

  it("marks the stream stale on engine.stop without failing the turn", () => {
    const state = applyAll(createTurnsState(), [
      started(),
      event(2, "engine.status", { state: "stopped", activeWorkers: 0 }),
    ]);

    expect(state.stale).toBe(true);
    expect(state.runs.run_a.status).toBe("streaming");
  });
});

describe("TD-18 renderer transport", () => {
  const manual = () => {};

  it("coalesces a 10x render-rate burst without dropping text or requesting resync", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(started());
    transport.flush();

    for (let i = 0; i < 10_000; i += 1) {
      transport.enqueue(delta(i + 2, "x"));
    }
    const state = transport.flush();

    expect(state.runs.run_a.text).toHaveLength(10_000);
    expect(state.lastSeq).toBe(10_001);
    expect(state.needsResync).toBe(false);
    expect(state.lastDurableSeq).toBe(1);
  });

  it("requests one resync when the transient renderer queue overflows", () => {
    const resyncs: number[] = [];
    const errors: string[] = [];
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
      onResync: (fromSeq) => resyncs.push(fromSeq),
      onError: (code) => errors.push(code),
    });
    transport.enqueue(started());
    transport.flush();

    for (let i = 0; i < 600; i += 1) {
      transport.enqueue(
        i % 2 === 0
          ? event(
              i + 2,
              "turn.thought_delta",
              {
                runId: "run_a",
                delta: "t",
                turnId: "turn_a",
              } as EventPayloads["turn.thought_delta"],
              false,
            )
          : delta(i + 2, "s"),
      );
    }

    expect(errors).toEqual(["ERR_STREAM_RENDER_OVERFLOW"]);
    expect(resyncs).toEqual([1]);
    expect(transport.current().needsResync).toBe(true);

    transport.enqueue(snapshot(700));
    const state = transport.flush();
    expect(state.needsResync).toBe(false);
    expect(state.resyncCount).toBe(1);
  });

  it("pauses durable delivery at the frozen queue bound with one resync", () => {
    const resyncs: number[] = [];
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
      onResync: (fromSeq) => resyncs.push(fromSeq),
    });
    transport.enqueue(started());
    transport.flush();

    for (let i = 0; i < TRANSPORT_LIMITS.pendingQueueFrames + 1; i += 1) {
      transport.enqueue(toolIntent(i + 2, `act_${i}`));
    }

    expect(resyncs).toEqual([1]);
    expect(transport.current().needsResync).toBe(true);
  });

  it("rejects an encoded frame over the byte cap before it reaches the reducer", () => {
    const errors: string[] = [];
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
      onError: (code) => errors.push(code),
    });
    transport.enqueue(started());
    transport.flush();
    transport.enqueue(
      event(2, "turn.tool_intent", {
        runId: "run_a",
        actionId: "act_big",
        capabilityId: "cap_fs_read_tree",
        target: "target_desktop_src",
        argsSummary: "x".repeat(TRANSPORT_LIMITS.maxEncodedFrameBytes),
      }),
    );

    expect(errors).toEqual(["ERR_FRAME_TOO_LARGE"]);
    expect(transport.current().needsResync).toBe(true);
  });

  it("preserves FUI-W4 ordering and attribution through the coalescing transport", () => {
    const fixture = guiFixture("fui-w4-stream-backpressure.json");
    const events = fixture.eventSequence.map((step) => step.event);
    const transport = createTurnStreamTransport({
      sessionId: events[0].sessionId,
      scopeId: events[0].scopeId,
      schedule: manual,
    });
    for (const envelope of events) transport.enqueue(envelope);
    const state = transport.flush();
    const expected = applyAll(createTurnsState(), events);
    const run = state.runs.run_w4_01;

    expect(run.text).toBe(expected.runs.run_w4_01.text);
    expect(run.thought).toBe(expected.runs.run_w4_01.thought);
    expect(run.blocks.map((block) => block.type)).toEqual(
      expected.runs.run_w4_01.blocks.map((block) => block.type),
    );
    expect(
      run.actions.map((action) => [action.actionId, action.status]),
    ).toEqual(
      expected.runs.run_w4_01.actions.map((action) => [
        action.actionId,
        action.status,
      ]),
    );
  });

  it("validates and dedupes before coalescing, never duplicating text", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(started());
    transport.flush();

    const duplicate = delta(2, "x");
    transport.enqueue(duplicate);
    transport.enqueue(duplicate);
    const state = transport.flush();

    expect(state.runs.run_a.text).toBe("x");
    expect(state.duplicateCount).toBe(1);
    expect(state.lastSeq).toBe(2);
  });

  it("does not merge across a gap and ignores late out-of-order deltas", () => {
    const resyncs: number[] = [];
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
      onResync: (fromSeq) => resyncs.push(fromSeq),
    });
    transport.enqueue(started());
    transport.flush();

    transport.enqueue(delta(2, "a"));
    transport.enqueue(delta(4, "c"));
    const gapped = transport.flush();

    expect(gapped.runs.run_a.text).toBe("a");
    expect(gapped.needsResync).toBe(true);
    expect(gapped.lastDurableSeq).toBe(1);
    expect(resyncs).toEqual([1]);

    transport.enqueue(delta(3, "b"));
    const paused = transport.flush();
    expect(paused.runs.run_a.text).toBe("a");

    transport.enqueue(snapshot(5));
    const recovered = transport.flush();
    expect(recovered.needsResync).toBe(false);
    expect(recovered.resyncCount).toBe(1);
  });

  it("drops a replayed delta after a flush instead of appending it twice", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(started());
    transport.flush();
    transport.enqueue(delta(2, "x"));
    transport.flush();
    transport.enqueue(delta(2, "x"));
    transport.enqueue(delta(3, "y"));
    const state = transport.flush();

    expect(state.runs.run_a.text).toBe("xy");
    expect(state.duplicateCount).toBe(1);
  });

  it("keeps cross-session state separate instead of dropping one session", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_a",
      scopeId: "scope_spec",
      schedule: manual,
    });
    const sessionA = event(
      1,
      "turn.started",
      {
        runId: "run_a",
        turnId: "turn_a",
      },
      true,
      "ses_a",
    );
    const sessionB = event(
      1,
      "turn.started",
      {
        runId: "run_b",
        turnId: "turn_b",
      },
      true,
      "ses_b",
    );

    transport.follow("ses_b", "scope_spec");
    transport.enqueue(sessionA);
    transport.enqueue(sessionB);
    transport.flush();

    expect(transport.current("ses_a").runs.run_a).toBeDefined();
    expect(transport.current("ses_b").runs.run_b).toBeDefined();
    expect(transport.current("ses_a").duplicateCount).toBe(0);
    expect(transport.current("ses_b").duplicateCount).toBe(0);
  });

  it("rejects an invalid payload before it can mutate the stream", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(started());
    transport.flush();

    transport.enqueue({
      ...delta(2, "x"),
      payload: { runId: "run_a", turnId: "turn_a", delta: 42 },
    } as unknown as SplyceEventEnvelope);
    transport.enqueue({
      ...delta(3, "y"),
      payload: null,
    } as unknown as SplyceEventEnvelope);
    const state = transport.flush();

    expect(state.runs.run_a.text).toBe("");
    expect(state.protocolErrors).toBe(2);
    expect(state.lastSeq).toBe(1);
  });

  it("offers the session id with the recovery request", () => {
    const requests: [number, string][] = [];
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
      onResync: (fromSeq, sessionId) => requests.push([fromSeq, sessionId]),
    });
    transport.enqueue(started());
    transport.flush();
    transport.enqueue(delta(4, "gap"));

    expect(requests).toEqual([[1, "ses_spec"]]);
  });

  it("rejects a malformed frame while paused before inspecting its kind", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(started());
    transport.flush();
    transport.enqueue(delta(4, "gap"));
    transport.flush();

    transport.enqueue({
      ...delta(2, "bad replay"),
      payload: { runId: "run_a", turnId: "turn_a", delta: 42 },
    } as unknown as SplyceEventEnvelope);

    const state = transport.flush();
    expect(state.needsResync).toBe(true);
    expect(state.protocolErrors).toBe(1);
    expect(state.runs.run_a.text).toBe("");
  });

  it("replays durable events after a reconnect snapshot without skipping them", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(started());
    transport.flush();
    transport.enqueue(delta(4, "gap"));
    transport.flush();

    transport.enqueue(
      event(5, "run.reconnect_snapshot", {
        runId: "run_a",
        lastDurableSeq: 2,
        turnId: "turn_a",
        activeActionIds: [],
        state: "busy",
      }),
    );
    transport.flush();
    transport.enqueue(toolIntent(3, "act_replay"));
    transport.enqueue(
      event(4, "turn.tool_outcome", {
        runId: "run_a",
        actionId: "act_replay",
        status: "success",
        outcomeRef: "ref_replay",
      }),
    );

    const state = transport.flush();
    expect(state.needsResync).toBe(false);
    expect(state.runs.run_a.actions[0]).toMatchObject({
      actionId: "act_replay",
      status: "success",
    });
  });

  it("rejects events for sessions it was not told to follow", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_a",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(
      event(
        1,
        "turn.started",
        { runId: "run_b", turnId: "turn_b" },
        true,
        "ses_b",
      ),
    );
    const state = transport.flush();

    expect(state.runs.run_b).toBeUndefined();
    expect(transport.current("ses_b").runs.run_b).toBeUndefined();
    expect(transport.rejectedCount()).toBe(1);

    transport.follow("ses_b", "scope_spec");
    transport.enqueue(
      event(
        1,
        "turn.started",
        { runId: "run_b", turnId: "turn_b" },
        true,
        "ses_b",
      ),
    );
    transport.flush();
    expect(transport.current("ses_b").runs.run_b).toBeDefined();
    expect(transport.current().runs.run_b).toBeUndefined();
    expect(transport.rejectedCount()).toBe(1);
  });

  it("stays inert until a session is followed", () => {
    const transport = createTurnStreamTransport({ schedule: manual });
    transport.enqueue(started());
    const state = transport.flush();

    expect(state.runs.run_a).toBeUndefined();
    expect(state.sessionId).toBeUndefined();
    expect(transport.rejectedCount()).toBe(1);
  });

  it("applies every durable replay frame after a durable-queue overflow and snapshot", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(started());
    transport.flush();

    const count = TRANSPORT_LIMITS.pendingQueueFrames + 1;
    for (let i = 0; i < count; i += 1) {
      transport.enqueue(toolIntent(i + 2, `act_${i}`));
    }
    expect(transport.current().needsResync).toBe(true);
    const from = transport.current().resyncFromSeq ?? 0;
    expect(from).toBe(1);

    transport.enqueue(snapshot(count + 3));
    for (let i = 0; i < count; i += 1) {
      transport.enqueue(toolIntent(i + 2, `act_${i}`));
      if (i % 256 === 255) transport.flush();
    }
    const state = transport.flush();

    expect(state.runs.run_a.actions).toHaveLength(count);
    expect(state.needsResync).toBe(false);
    expect(state.lastDurableSeq).toBe(count + 1);
    expect(state.duplicateCount).toBe(0);
  });

  it("drops a retransmitted eventId instead of merging its text twice", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(started());
    transport.flush();

    transport.enqueue(delta(2, "x"));
    transport.enqueue({ ...delta(3, "x"), eventId: "evt_2" });
    const state = transport.flush();

    expect(state.runs.run_a.text).toBe("x");
    expect(state.duplicateCount).toBe(1);
  });

  it("keeps the live cursor above the snapshot while replaying durable frames", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(started());
    transport.flush();
    transport.enqueue(delta(4, "gap"));
    transport.flush();

    transport.enqueue(
      event(5, "run.reconnect_snapshot", {
        runId: "run_a",
        lastDurableSeq: 2,
        turnId: "turn_a",
        activeActionIds: [],
        state: "busy",
      }),
    );
    transport.enqueue(toolIntent(3, "act_3"));
    transport.enqueue(toolIntent(4, "act_4"));
    transport.enqueue(delta(6, "live"));
    const state = transport.flush();

    expect(state.needsResync).toBe(false);
    expect(state.resyncCount).toBe(1);
    expect(state.runs.run_a.actions.map((a) => a.actionId)).toEqual([
      "act_3",
      "act_4",
    ]);
    expect(state.runs.run_a.text).toBe("live");
  });

  it("rejects an event whose scope differs from the followed scope", () => {
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: manual,
    });
    transport.enqueue(started());
    transport.flush();

    transport.enqueue({
      ...delta(2, "x"),
      scopeId: "scope_other",
    } as SplyceEventEnvelope);
    const state = transport.flush();

    expect(state.runs.run_a.text).toBe("");
    expect(state.lastSeq).toBe(1);
    expect(transport.rejectedCount()).toBe(1);
  });
});

describe("reducer event-id memory", () => {
  it("stays bounded and fast across a long run of events", () => {
    let state = createTurnsState();
    state = reduceTurns(
      state,
      event(1, "turn.started", { runId: "run_a", turnId: "turn_a" }),
    );
    const started = performance.now();
    for (let seq = 2; seq < 12_002; seq += 1) {
      state = reduceTurns(state, delta(seq, "x"), { coalesced: true });
    }
    const elapsed = performance.now() - started;
    expect(state.runs.run_a?.text.length).toBe(12_000);
    expect(state.seenEventIds.size).toBeLessThanOrEqual(4096);
    // The old per-event Set copy made this O(n^2); the bounded window keeps it linear.
    expect(elapsed).toBeLessThan(2000);
  });

  it("still rejects a duplicate that is inside the window", () => {
    let state = createTurnsState();
    state = reduceTurns(
      state,
      event(1, "turn.started", { runId: "run_a", turnId: "turn_a" }),
    );
    const repeated = delta(2, "x");
    state = reduceTurns(state, repeated);
    const again = reduceTurns(state, repeated);
    expect(again.duplicateCount).toBe(state.duplicateCount + 1);
    expect(again.runs.run_a?.text).toBe("x");
  });
});

describe("TD-15 stream.resync control frame", () => {
  const resyncControl = (fromSeq: number, extra: object = {}) =>
    ({
      frame: "control",
      kind: "stream.resync",
      sessionId: "ses_spec",
      fromSeq,
      ...extra,
    }) as unknown as SplyceEventEnvelope;

  function setup() {
    const resyncs: number[] = [];
    const transport = createTurnStreamTransport({
      sessionId: "ses_spec",
      scopeId: "scope_spec",
      schedule: (task) => task(),
      onResync: (fromSeq) => resyncs.push(fromSeq),
    });
    return { transport, resyncs };
  }

  const startedAt = (seq: number) =>
    event(seq, "turn.started", { runId: "run_a", turnId: `turn_${seq}` });

  it("R1 fresh client (M=0) requests replay after 0 and applies seq 1", () => {
    const { transport, resyncs } = setup();
    transport.enqueue(resyncControl(0));
    expect(resyncs).toEqual([0]);
    expect(transport.current().needsResync).toBe(true);
    expect(transport.current().lastSeq).toBe(0);
    expect(transport.current().lastDurableSeq).toBe(0);

    transport.enqueue(snapshot(2));
    transport.enqueue(startedAt(1));
    const state = transport.flush();
    expect(state.needsResync).toBe(false);
    expect(state.runs.run_a?.status).toBe("streaming");
    expect(state.lastDurableSeq).toBe(1);
  });

  it("R2 client at M>0 is not duplicate-rejected and keeps its cursors", () => {
    const { transport, resyncs } = setup();
    for (const seq of [1, 2, 3]) transport.enqueue(startedAt(seq));
    const before = transport.flush();
    transport.enqueue(resyncControl(3));
    const after = transport.current();
    expect(resyncs).toEqual([3]);
    expect(after.duplicateCount).toBe(before.duplicateCount);
    expect(after.protocolErrors).toBe(0);
    expect(after.lastSeq).toBe(3);
    expect(after.lastDurableSeq).toBe(3);
    expect([...after.seenEventIds]).toEqual([...before.seenEventIds]);

    // Replay from M+1 is still contiguous: the control moved no cursor.
    transport.enqueue(snapshot(5));
    transport.enqueue(startedAt(4));
    const replayed = transport.flush();
    expect(replayed.needsResync).toBe(false);
    expect(replayed.lastDurableSeq).toBe(4);
  });

  it("R3 exact unsequenced shape is accepted; any extra key is rejected", () => {
    const { transport, resyncs } = setup();
    transport.enqueue(startedAt(1));
    transport.flush();
    transport.enqueue(resyncControl(1, { seq: 2 }));
    transport.enqueue(resyncControl(1, { scopeId: "scope_spec" }));
    expect(resyncs).toEqual([]);
    expect(transport.current().needsResync).toBe(false);
    expect(transport.current().protocolErrors).toBe(2);

    transport.enqueue(resyncControl(1));
    expect(resyncs).toEqual([1]);
    expect(transport.current().protocolErrors).toBe(2);
    expect(transport.rejectedCount()).toBe(0);
  });

  it("R4 replay request uses payload fromSeq, not the local durable cursor", () => {
    const { transport, resyncs } = setup();
    for (const seq of [1, 2, 3]) transport.enqueue(startedAt(seq));
    transport.flush();
    transport.enqueue(resyncControl(2));
    expect(resyncs).toEqual([2]);
    expect(transport.current().lastDurableSeq).toBe(3);
  });

  it("L7 control branch returns before data intake (no rejection, no cursor move)", () => {
    const { transport } = setup();
    transport.enqueue(startedAt(1));
    const before = transport.flush();
    transport.enqueue(resyncControl(1));
    const after = transport.current();
    expect(transport.rejectedCount()).toBe(0);
    expect(after.protocolErrors).toBe(0);
    expect(after.duplicateCount).toBe(before.duplicateCount);
    expect(after.lastSeq).toBe(before.lastSeq);
    expect(after.lastDurableSeq).toBe(before.lastDurableSeq);
  });

  it("B1 recovering accepts the plain durable replay at expectedNext (no snapshot)", () => {
    const { transport, resyncs } = setup();
    transport.enqueue(resyncControl(0));
    expect(resyncs).toEqual([0]);
    transport.enqueue(startedAt(1));
    const state = transport.flush();
    expect(state.needsResync).toBe(false);
    expect(state.resyncCount).toBe(1);
    expect(state.lastDurableSeq).toBe(1);
    expect(state.runs.run_a?.turnId).toBe("turn_1");
  });

  it("B1 seq beyond expectedNext keeps waiting; seq <= applied is a duplicate", () => {
    const { transport, resyncs } = setup();
    transport.enqueue(startedAt(1));
    transport.flush();
    transport.enqueue(resyncControl(1));
    transport.enqueue(startedAt(3));
    expect(transport.current().needsResync).toBe(true);
    transport.enqueue({ ...startedAt(1), eventId: "evt_1_replay" });
    expect(transport.current().duplicateCount).toBe(1);
    expect(transport.current().needsResync).toBe(true);
    transport.enqueue(startedAt(2));
    transport.enqueue(startedAt(3));
    const state = transport.flush();
    expect(resyncs).toEqual([1]);
    expect(state.needsResync).toBe(false);
    expect(state.lastDurableSeq).toBe(3);
  });

  it("B1 a reconnect snapshot at the applied cursor completes recovery", () => {
    const { transport } = setup();
    for (const seq of [1, 2]) transport.enqueue(startedAt(seq));
    transport.flush();
    transport.enqueue(resyncControl(2));
    expect(transport.current().needsResync).toBe(true);
    transport.enqueue({ ...snapshot(2), eventId: "evt_snap_2" });
    const state = transport.flush();
    expect(state.needsResync).toBe(false);
    expect(state.duplicateCount).toBe(0);
    transport.enqueue(startedAt(3));
    expect(transport.flush().lastDurableSeq).toBe(3);
  });

  it("N1 clamps the replay request to the applied cursor (applied 1, fromSeq 3)", () => {
    const { transport, resyncs } = setup();
    transport.enqueue(startedAt(1));
    transport.flush();
    transport.enqueue(resyncControl(3));
    expect(resyncs).toEqual([1]);
    expect(transport.current().resyncAfterSeq).toBe(1);
    transport.enqueue(startedAt(2));
    const state = transport.flush();
    expect(state.needsResync).toBe(false);
    expect(state.lastDurableSeq).toBe(2);
  });

  it("N3 a malformed control counts on the named session's channel", () => {
    const { transport } = setup();
    transport.follow("ses_b", "scope_spec");
    transport.enqueue(startedAt(1));
    transport.flush();
    transport.enqueue(resyncControl(-1, { sessionId: "ses_b" }));
    expect(transport.current("ses_b").protocolErrors).toBe(1);
    expect(transport.current().protocolErrors).toBe(0);
    expect(transport.rejectedCount()).toBe(0);
  });

  it("rejects a control frame for an unfollowed session", () => {
    const { transport, resyncs } = setup();
    transport.enqueue(resyncControl(0, { sessionId: "ses_other" }));
    expect(resyncs).toEqual([]);
    expect(transport.rejectedCount()).toBe(1);
  });
});
