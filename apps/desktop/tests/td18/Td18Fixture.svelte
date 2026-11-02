<script lang="ts">
  import { onMount } from "svelte";
  import type { EventPayloads, SplyceEventEnvelope } from "@splyce/pi/contracts";
  import TurnStream from "../../src/components/TurnStream.svelte";
  import {
    createTurnStreamTransport,
    createTurnsState,
    type TurnsState,
  } from "../../src/stores/turns";

  type Decision = "approve" | "deny";

  const defaultSessionId = "ses_test_01";
  let state = $state.raw<TurnsState>(createTurnsState());
  let allowApprovals = false;
  let resyncs: number[] = [];
  let errors: string[] = [];
  let dispatches: {
    approvalRequestId: string;
    actionId: string;
    decision: Decision;
  }[] = [];

  const transport = createTurnStreamTransport({
    sessionId: defaultSessionId,
    scopeId: "w-demo",
    onState: (next) => {
      state = next;
    },
    onResync: (fromSeq) => {
      resyncs.push(fromSeq);
    },
    onError: (code) => {
      errors.push(code);
    },
  });

  let run = $derived(
    state.currentRunId ? state.runs[state.currentRunId] : undefined,
  );

  function envelope<K extends keyof EventPayloads>(
    seq: number,
    kind: K,
    payload: EventPayloads[K],
    durable = true,
  ): SplyceEventEnvelope {
    return {
      schemaVersion: 1,
      protocolVersion: 1,
      recordId: `rec_${seq}`,
      eventId: `evt_${seq}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      sourceIds: [],
      scopeId: "w-demo",
      sessionId: "ses_test_01",
      seq,
      durable,
      kind,
      payload,
    } as SplyceEventEnvelope;
  }

  function start() {
    transport.enqueue(
      envelope(1, "turn.started", {
        runId: "run_w4_01",
        turnId: "turn_w4",
      }),
    );
    transport.flush();
  }

  function play(events: SplyceEventEnvelope[]) {
    for (const event of events) transport.enqueue(event);
  }

  function setApprovals(allowed: boolean) {
    allowApprovals = allowed;
  }

  function useSession(sessionId: string) {
    transport.unfollow(defaultSessionId);
    transport.follow(sessionId, "w-demo");
  }

  function burst(count: number) {
    const startSeq = state.lastSeq;
    for (let i = 0; i < count; i += 1) {
      transport.enqueue(
        envelope(
          startSeq + i + 1,
          "turn.stream_delta",
          { runId: "run_w4_01", delta: "x", turnId: "turn_w4" },
          false,
        ),
      );
    }
  }

  function overflow() {
    for (let i = 0; i < 600; i += 1) {
      const seq = state.lastSeq + i + 1;
      transport.enqueue(
        i % 2 === 0
          ? envelope(
              seq,
              "turn.thought_delta",
              { runId: "run_w4_01", delta: "t", turnId: "turn_w4" },
              false,
            )
          : envelope(
              seq,
              "turn.stream_delta",
              { runId: "run_w4_01", delta: "s", turnId: "turn_w4" },
              false,
            ),
      );
    }
  }

  function recover() {
    const seq = state.lastSeq + 1;
    transport.enqueue(
      envelope(seq, "run.reconnect_snapshot", {
        runId: "run_w4_01",
        lastDurableSeq: seq - 1,
        turnId: "turn_w4",
        activeActionIds: [],
        state: "busy",
      }),
    );
    transport.flush();
  }

  function snapshot() {
    return {
      run: run
        ? {
            text: run.text,
            thought: run.thought,
            status: run.status,
            blocks: run.blocks,
            actions: run.actions,
          }
        : null,
      lastSeq: state.lastSeq,
      lastDurableSeq: state.lastDurableSeq,
      needsResync: state.needsResync,
      resyncCount: state.resyncCount,
      resyncs: [...resyncs],
      errors: [...errors],
      dispatches: [...dispatches],
    };
  }

  onMount(() => {
    (
      window as unknown as {
        __td18: {
          start: typeof start;
          play: typeof play;
          burst: typeof burst;
          overflow: typeof overflow;
          recover: typeof recover;
          setApprovals: typeof setApprovals;
          useSession: typeof useSession;
          snapshot: typeof snapshot;
        };
      }
    ).__td18 = {
      start,
      play,
      burst,
      overflow,
      recover,
      setApprovals,
      useSession,
      snapshot,
    };
  });
</script>

{#if run}
  <TurnStream
    {run}
    canRespond={() => allowApprovals}
    onApproval={(approvalRequestId, _runId, actionId, decision) => {
      dispatches.push({ approvalRequestId, actionId, decision });
    }}
  />
{:else}
  <p data-testid="empty">No turn</p>
{/if}
