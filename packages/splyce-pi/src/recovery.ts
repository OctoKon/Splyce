// TD-25 / C3 recovery (interface-first prep). Pure reconciliation of the durable journal after a crash or an explicit
// engine Restart. It decides; it does not write, spawn or dispatch. The caller applies `corrections` through the
// store and shows `uncertain` to the user.
//
// Rules this module pins (plan row TD-25):
//   - an effect that may have started is never replayed: recovery has no "redispatch" output at all;
//   - an action may be `completed` only with an observed-success outcome; anything else is corrected, never invented;
//   - an interrupted run with a possibly-started effect becomes `uncertain`, not `failed`;
//   - a workspace cannot be taken over while any writer may still be alive, or has uncertain actions, even after its
//     lease expired or its client disconnected; only an explicit "not alive" answer releases it;
//   - after Restart nothing is admitted until reconciliation has been applied (`admissionOpen`).
import type {
  ActionRecord,
  OutcomeRecord,
  RunRecord,
  RecordByKind,
} from "./contracts.js";

type Action = Pick<ActionRecord, "actionId" | "runId" | "state">;
type Outcome = Pick<OutcomeRecord, "actionId" | "effectState">;
type Run = Pick<RunRecord, "runId" | "piSessionId" | "state">;
type Lease = Pick<
  RecordByKind["sessionWriterLease"],
  "piSessionId" | "writerId" | "leaseEpoch"
>;

export interface WriterStatus {
  readonly lease: Lease;
  /** true/false only when the owner process was positively observed; anything else is unknown and blocks. */
  readonly alive: boolean | "unknown";
}

export interface RecoveryInput {
  readonly runs: readonly Run[];
  readonly actions: readonly Action[];
  readonly outcomes: readonly Outcome[];
  readonly writers: readonly WriterStatus[];
  /** Recovery runs only after an explicit engine Restart, never silently at launch. */
  readonly explicitRestart: boolean;
}

export interface ActionCorrection {
  readonly actionId: string;
  readonly from: ActionRecord["state"];
  readonly to: "completed" | "failed" | "uncertain" | "canceled";
  readonly reason: string;
}

export interface RunCorrection {
  readonly runId: string;
  readonly from: RunRecord["state"];
  readonly to: "uncertain" | "failed";
  readonly reason: string;
}

export interface RecoveryReport {
  readonly actionCorrections: readonly ActionCorrection[];
  readonly runCorrections: readonly RunCorrection[];
  /** Action ids to show the user as uncertain. Never dispatched again. */
  readonly uncertain: readonly string[];
  /** Session ids whose workspace must not be taken over, with why. */
  readonly takeoverBlocked: readonly { piSessionId: string; reason: string }[];
  /** False until the corrections are applied by the caller; admission must wait on it. */
  readonly admissionOpen: false;
  readonly redispatch: readonly never[];
}

const IN_FLIGHT = new Set<ActionRecord["state"]>([
  "pending",
  "approved",
  "running",
]);

export function reconcile(input: RecoveryInput): RecoveryReport {
  if (!input.explicitRestart) {
    throw new Error("recovery runs only after an explicit engine Restart");
  }
  const outcomeOf = new Map(input.outcomes.map((o) => [o.actionId, o]));
  const actionCorrections: ActionCorrection[] = [];

  for (const action of input.actions) {
    const outcome = outcomeOf.get(action.actionId);
    if (action.state === "completed") {
      if (outcome?.effectState !== "observed-success") {
        actionCorrections.push({
          actionId: action.actionId,
          from: action.state,
          to: "uncertain",
          reason: "completed without an observed-success outcome",
        });
      }
      continue;
    }
    if (!IN_FLIGHT.has(action.state)) continue;
    if (outcome?.effectState === "observed-success") {
      actionCorrections.push({
        actionId: action.actionId,
        from: action.state,
        to: "completed",
        reason: "outcome was durably observed before the crash",
      });
    } else if (outcome?.effectState === "observed-failure") {
      actionCorrections.push({
        actionId: action.actionId,
        from: action.state,
        to: "failed",
        reason: "failure was durably observed before the crash",
      });
    } else if (action.state === "running" || outcome !== undefined) {
      actionCorrections.push({
        actionId: action.actionId,
        from: action.state,
        to: "uncertain",
        reason: "the effect may have started and its result was not observed",
      });
    } else {
      // pending/approved without any outcome never reached its effect. After a Restart it must not stay dispatchable
      // (a stale approval would otherwise run under a run that recovery has already closed): cancel it. A new task
      // needs a new admission.
      actionCorrections.push({
        actionId: action.actionId,
        from: action.state,
        to: "canceled",
        reason: "never reached its effect; stale after the engine Restart",
      });
    }
  }

  const finalState = new Map(
    input.actions.map((a) => [a.actionId, a.state as string]),
  );
  for (const c of actionCorrections) finalState.set(c.actionId, c.to);
  const uncertain = [...finalState]
    .filter(([, state]) => state === "uncertain")
    .map(([id]) => id)
    .sort();

  const actionsByRun = new Map<string, string[]>();
  for (const action of input.actions) {
    const list = actionsByRun.get(action.runId) ?? [];
    list.push(action.actionId);
    actionsByRun.set(action.runId, list);
  }
  const runCorrections: RunCorrection[] = [];
  for (const run of input.runs) {
    if (run.state !== "running" && run.state !== "pending") continue;
    const hasUncertain = (actionsByRun.get(run.runId) ?? []).some(
      (id) => finalState.get(id) === "uncertain",
    );
    runCorrections.push({
      runId: run.runId,
      from: run.state,
      to: hasUncertain ? "uncertain" : "failed",
      reason: hasUncertain
        ? "interrupted with an action whose effect is unknown"
        : "interrupted before any effect could have started",
    });
  }

  // Takeover is decided from the FINAL uncertain actions' owning runs, whatever label the run carries (a "completed"
  // run can own an uncertain action, and so can a failed one) and from runs that are themselves uncertain.
  const runById = new Map(input.runs.map((r) => [r.runId, r]));
  const uncertainRuns = new Set<string>(
    input.runs.filter((r) => r.state === "uncertain").map((r) => r.runId),
  );
  for (const run of runCorrections) {
    if (run.to === "uncertain") uncertainRuns.add(run.runId);
  }
  for (const action of input.actions) {
    if (finalState.get(action.actionId) === "uncertain") {
      uncertainRuns.add(action.runId);
    }
  }
  const blocked = new Map<string, string>();
  for (const { lease, alive } of input.writers) {
    if (alive !== false) {
      blocked.set(
        lease.piSessionId,
        alive === true
          ? `writer ${lease.writerId} is still alive`
          : `writer ${lease.writerId} liveness is unknown`,
      );
    }
  }
  for (const runId of uncertainRuns) {
    const run = runById.get(runId);
    // An action whose run is missing from the journal cannot be attributed to a session: that is itself unsafe.
    const piSessionId = run?.piSessionId ?? `unattributed:${runId}`;
    if (!blocked.has(piSessionId)) {
      blocked.set(
        piSessionId,
        `run ${runId} has uncertain effects awaiting review`,
      );
    }
  }

  return {
    actionCorrections,
    runCorrections,
    uncertain,
    takeoverBlocked: [...blocked].map(([piSessionId, reason]) => ({
      piSessionId,
      reason,
    })),
    admissionOpen: false,
    redispatch: [],
  };
}

/**
 * Admission after Restart: closed until the caller reports the corrections applied. A report with outstanding
 * corrections can never open it, so a new task cannot be admitted beside unreconciled state.
 */
export function admissionOpen(
  report: RecoveryReport,
  applied: {
    readonly actionIds: readonly string[];
    readonly runIds: readonly string[];
  },
): boolean {
  const actions = new Set(applied.actionIds);
  const runs = new Set(applied.runIds);
  return (
    report.actionCorrections.every((c) => actions.has(c.actionId)) &&
    report.runCorrections.every((c) => runs.has(c.runId))
  );
}
