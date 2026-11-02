import {
  type ContractContext,
  type EventKind,
  type EventPayloads,
  type SplyceErrorPayload,
  type SplyceEventEnvelope,
  validateControlFrame,
  validateEvent,
} from "@splyce/pi/contracts";

export type ApprovalState = "requested" | "allowed" | "denied" | "canceled";

export interface ApprovalView {
  approvalRequestId: string;
  runId: string;
  actionId: string;
  capabilityId: string;
  targetScope: string;
  normalizedTarget: string;
  riskRationale: string;
  timeoutMs?: number;
  state: ApprovalState;
}

export type ToolCallStatus =
  "pending" | "success" | "error" | "uncertain" | "canceled";

export interface ToolOutcomeSummary {
  exitCode?: number;
  durationMs?: number;
  bytes?: number;
  truncated?: boolean;
  preview?: string;
}

export interface ToolCallView {
  actionId: string;
  capabilityId: string;
  target: string;
  argsSummary: string;
  status: ToolCallStatus;
  outcomeRef?: string;
  error?: string;
  approval?: ApprovalView;
  summary?: ToolOutcomeSummary;
}

export type TurnStatus =
  | "streaming"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "canceled"
  | "stopped";

export type TurnBlock =
  | { type: "thought"; id: string; text: string }
  | { type: "text"; id: string; text: string }
  | { type: "tool"; id: string; actionId: string };

export interface TurnView {
  runId: string;
  userPrompt?: string;
  turnId?: string;
  status: TurnStatus;
  text: string;
  thought: string;
  actions: ToolCallView[];
  blocks: TurnBlock[];
  error?: SplyceErrorPayload;
  candidateSnapshotId?: string;
  finalRevision?: string;
  cleanedUp?: boolean;
}

export interface TurnsState {
  sessionId?: string;
  currentRunId?: string;
  runs: Record<string, TurnView>;
  lastSeq: number;
  lastDurableSeq: number;
  seenEventIds: Set<string>;
  needsResync: boolean;
  resyncFromSeq?: number;
  resyncAfterSeq?: number;
  resyncCount: number;
  duplicateCount: number;
  unknownKindCount: number;
  unresolvedPayloadCount: number;
  pendingPayloadIds: string[];
  protocolErrors: number;
  stale: boolean;
}

export function createTurnsState(): TurnsState {
  return {
    runs: {},
    lastSeq: 0,
    lastDurableSeq: 0,
    seenEventIds: new Set(),
    needsResync: false,
    resyncCount: 0,
    duplicateCount: 0,
    unknownKindCount: 0,
    unresolvedPayloadCount: 0,
    pendingPayloadIds: [],
    protocolErrors: 0,
    stale: false,
  };
}

function emptyTurn(runId: string): TurnView {
  return {
    runId,
    status: "streaming",
    text: "",
    thought: "",
    actions: [],
    blocks: [],
  };
}

function withRun(state: TurnsState, runId: string): TurnsState {
  if (state.runs[runId]) return state;
  return { ...state, runs: { ...state.runs, [runId]: emptyTurn(runId) } };
}

function updateRun(
  state: TurnsState,
  runId: string,
  update: (turn: TurnView) => TurnView,
): TurnsState {
  const next = withRun(state, runId);
  const current = next.runs[runId] ?? emptyTurn(runId);
  const updated = update({
    ...current,
    actions: [...current.actions],
    blocks: [...current.blocks],
  });
  return { ...next, runs: { ...next.runs, [runId]: updated } };
}

function ensureToolBlock(turn: TurnView, actionId: string): TurnView {
  if (
    turn.blocks.some(
      (block) => block.type === "tool" && block.actionId === actionId,
    )
  )
    return turn;
  return {
    ...turn,
    blocks: [
      ...turn.blocks,
      { type: "tool", id: `tool:${actionId}`, actionId },
    ],
  };
}

function appendStreamBlock(
  turn: TurnView,
  type: "text" | "thought",
  id: string,
  delta: string,
): TurnView {
  const blocks = [...turn.blocks];
  const last = blocks[blocks.length - 1];
  if (last?.type === type)
    blocks[blocks.length - 1] = { ...last, text: last.text + delta };
  else blocks.push({ type, id, text: delta });
  return type === "text"
    ? { ...turn, text: turn.text + delta, blocks }
    : { ...turn, thought: turn.thought + delta, blocks };
}

function isTerminal(turn: TurnView): boolean {
  return (
    turn.status === "completed" ||
    turn.status === "failed" ||
    turn.status === "canceled"
  );
}

function findAction(
  state: TurnsState,
  actionId: string,
): ToolCallView | undefined {
  for (const turn of Object.values(state.runs)) {
    const action = turn.actions.find((item) => item.actionId === actionId);
    if (action) return action;
  }
  return undefined;
}

function updateAction(
  state: TurnsState,
  runId: string,
  actionId: string,
  update: (action: ToolCallView) => ToolCallView,
): TurnsState {
  return updateRun(state, runId, (turn) => {
    const index = turn.actions.findIndex((item) => item.actionId === actionId);
    if (index === -1) {
      turn.actions.push(
        update({
          actionId,
          capabilityId: "unknown",
          target: "",
          argsSummary: "",
          status: "pending",
        }),
      );
      return ensureToolBlock(turn, actionId);
    }
    const action = turn.actions[index];
    if (action) turn.actions[index] = update(action);
    return turn;
  });
}

function closeApprovals(
  turn: TurnView,
  state: "canceled" | "denied",
): TurnView {
  let changed = false;
  const actions = turn.actions.map((action) => {
    if (action.approval?.state !== "requested") return action;
    changed = true;
    return { ...action, approval: { ...action.approval, state } };
  });
  return changed ? { ...turn, actions } : turn;
}

function closePendingActions(
  turn: TurnView,
  status: "canceled" | "uncertain",
): TurnView {
  let changed = false;
  const actions = turn.actions.map((action) => {
    if (action.status !== "pending") return action;
    changed = true;
    return { ...action, status };
  });
  return changed ? { ...turn, actions } : turn;
}

function settleApprovalStatus(turn: TurnView): TurnView {
  const waiting = turn.actions.some(
    (action) => action.approval?.state === "requested",
  );
  if (!waiting && turn.status === "waiting_approval")
    return { ...turn, status: "streaming" };
  if (waiting && turn.status === "streaming")
    return { ...turn, status: "waiting_approval" };
  return turn;
}

function payloadOf<K extends EventKind>(
  envelope: SplyceEventEnvelope,
  kind: K,
): EventPayloads[K] | undefined {
  if (envelope.kind !== kind) return undefined;
  return (envelope as { payload?: EventPayloads[K] }).payload;
}

function missingPayload(state: TurnsState): TurnsState {
  return { ...state, protocolErrors: state.protocolErrors + 1 };
}

// The optional summary is additive to the frozen event; read it defensively so
// an older engine and a malformed field both keep the current card shape.
function toolSummaryOf(
  payload: EventPayloads["turn.tool_outcome"],
): ToolOutcomeSummary | undefined {
  const source = (payload as { summary?: unknown }).summary;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return undefined;
  }
  const value = source as Record<string, unknown>;
  const summary: ToolOutcomeSummary = {};
  if (
    typeof value.exitCode === "number" &&
    Number.isSafeInteger(value.exitCode)
  ) {
    summary.exitCode = value.exitCode;
  }
  if (
    typeof value.durationMs === "number" &&
    Number.isSafeInteger(value.durationMs) &&
    value.durationMs >= 0
  ) {
    summary.durationMs = value.durationMs;
  }
  if (
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0
  ) {
    summary.bytes = value.bytes;
  }
  if (typeof value.truncated === "boolean") {
    summary.truncated = value.truncated;
  }
  if (
    typeof value.preview === "string" &&
    value.preview.length > 0 &&
    value.preview.length <= 2048
  ) {
    summary.preview = value.preview;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

const EVENT_ID_WINDOW = 4096;

/**
 * Remembers an event id in a bounded window instead of copying the whole set per event, which made a burst of n events
 * cost O(n^2). Anything older than the window is already rejected by the sequence checks, so pruning loses nothing.
 */
function rememberEventId(seen: Set<string>, eventId: string): Set<string> {
  seen.add(eventId);
  if (seen.size > EVENT_ID_WINDOW) seen.delete(seen.values().next().value!);
  return seen;
}

// Mirrors the subscribe cursor to the engine; TD-15 owns replay, TD-18 owns gap detection.
export function reduceTurns(
  state: TurnsState,
  envelope: SplyceEventEnvelope,
  options?: { coalesced?: boolean },
): TurnsState {
  if (
    !envelope ||
    typeof envelope.seq !== "number" ||
    typeof envelope.kind !== "string" ||
    typeof envelope.eventId !== "string"
  ) {
    return { ...state, protocolErrors: state.protocolErrors + 1 };
  }
  const isSnapshot = envelope.kind === "run.reconnect_snapshot";
  if (
    state.seenEventIds.has(envelope.eventId) ||
    (isSnapshot && state.needsResync
      ? envelope.seq < state.lastDurableSeq
      : envelope.durable
        ? envelope.seq <= state.lastDurableSeq
        : envelope.seq <= state.lastSeq)
  ) {
    return { ...state, duplicateCount: state.duplicateCount + 1 };
  }

  if (state.needsResync && !isSnapshot) return state;
  if (
    !isSnapshot &&
    !options?.coalesced &&
    envelope.seq > state.lastSeq &&
    envelope.seq !== state.lastSeq + 1
  ) {
    return {
      ...state,
      needsResync: true,
      resyncFromSeq: state.lastSeq + 1,
      resyncAfterSeq: state.lastSeq,
    };
  }

  const next: TurnsState = {
    ...state,
    sessionId: envelope.sessionId,
    lastSeq: Math.max(state.lastSeq, envelope.seq),
    lastDurableSeq:
      envelope.durable && !isSnapshot
        ? Math.max(state.lastDurableSeq, envelope.seq)
        : state.lastDurableSeq,
    seenEventIds: rememberEventId(state.seenEventIds, envelope.eventId),
  };

  if (!("payload" in envelope)) {
    next.unresolvedPayloadCount = state.unresolvedPayloadCount + 1;
    if (envelope.durable) {
      next.stale = true;
      next.pendingPayloadIds = [...state.pendingPayloadIds, envelope.eventId];
    }
    return next;
  }

  switch (envelope.kind) {
    case "turn.started": {
      const payload = payloadOf(envelope, "turn.started");
      if (!payload) return missingPayload(next);
      next.currentRunId = payload.runId;
      return updateRun(next, payload.runId, (turn) => ({
        ...turn,
        turnId: turn.turnId ?? payload.turnId,
        ...(payload.userPrompt !== undefined
          ? { userPrompt: payload.userPrompt }
          : {}),
      }));
    }

    case "turn.stream_delta":
    case "turn.thought_delta": {
      const payload = payloadOf(envelope, envelope.kind);
      if (!payload) return missingPayload(next);
      const { runId, delta } = payload;
      const turnId = (payload as { turnId?: string }).turnId;
      if (!next.runs[runId] || isTerminal(next.runs[runId])) {
        return missingPayload(next);
      }
      if (
        turnId &&
        next.runs[runId].turnId &&
        turnId !== next.runs[runId].turnId
      ) {
        return missingPayload(next);
      }
      const field = envelope.kind === "turn.stream_delta" ? "text" : "thought";
      return updateRun(next, runId, (turn) =>
        appendStreamBlock(turn, field, `${field}:${envelope.seq}`, delta),
      );
    }

    case "turn.tool_intent": {
      const payload = payloadOf(envelope, "turn.tool_intent");
      if (!payload) return missingPayload(next);
      const { runId, actionId, capabilityId, target, argsSummary } = payload;
      if (!next.runs[runId] || isTerminal(next.runs[runId])) {
        return missingPayload(next);
      }
      return updateRun(next, runId, (turn) => {
        const index = turn.actions.findIndex(
          (item) => item.actionId === actionId,
        );
        const previous = index === -1 ? undefined : turn.actions[index];
        const approval = previous?.approval
          ? { ...previous.approval, state: "allowed" as const }
          : undefined;
        const action: ToolCallView = {
          ...(previous ?? { actionId, status: "pending" }),
          actionId,
          capabilityId,
          target,
          argsSummary,
          ...(approval ? { approval } : {}),
        };
        if (index === -1) turn.actions.push(action);
        else turn.actions[index] = action;
        return settleApprovalStatus(ensureToolBlock(turn, actionId));
      });
    }

    case "turn.tool_outcome": {
      const payload = payloadOf(envelope, "turn.tool_outcome");
      if (!payload) return missingPayload(next);
      const { runId, actionId, status, outcomeRef, error } = payload;
      if (!next.runs[runId]) return missingPayload(next);
      const summary = toolSummaryOf(payload);
      return updateAction(next, runId, actionId, (action) => ({
        ...action,
        status,
        ...(outcomeRef !== undefined ? { outcomeRef } : {}),
        ...(error !== undefined ? { error } : {}),
        ...(summary ? { summary } : {}),
      }));
    }

    case "turn.completed": {
      const payload = payloadOf(envelope, "turn.completed");
      if (!payload) return missingPayload(next);
      const { runId, candidateSnapshotId, finalRevision } = payload;
      if (!next.runs[runId]) return missingPayload(next);
      return updateRun(next, runId, (turn) => ({
        ...closeApprovals(turn, "canceled"),
        status: "completed",
        candidateSnapshotId,
        finalRevision,
      }));
    }

    case "turn.failed": {
      const payload = payloadOf(envelope, "turn.failed");
      if (!payload) return missingPayload(next);
      const { runId, error } = payload;
      if (!next.runs[runId]) return missingPayload(next);
      return updateRun(next, runId, (turn) => ({
        ...closeApprovals(closePendingActions(turn, "uncertain"), "denied"),
        status: "failed",
        error,
      }));
    }

    case "turn.canceled": {
      const payload = payloadOf(envelope, "turn.canceled");
      if (!payload) return missingPayload(next);
      const { runId, cleanedUp } = payload;
      if (!next.runs[runId]) return missingPayload(next);
      return updateRun(next, runId, (turn) => ({
        ...closeApprovals(closePendingActions(turn, "canceled"), "canceled"),
        status: "canceled",
        cleanedUp,
      }));
    }

    case "approval.requested": {
      const event = payloadOf(envelope, "approval.requested");
      if (!event) return missingPayload(next);
      const requestRun = next.runs[event.runId];
      if (!requestRun || isTerminal(requestRun)) {
        return missingPayload(next);
      }
      return updateRun(next, event.runId, (turn) => {
        const index = turn.actions.findIndex(
          (item) => item.actionId === event.actionId,
        );
        const previous: ToolCallView | undefined =
          index === -1 ? undefined : turn.actions[index];
        const approval: ApprovalView = {
          approvalRequestId: event.approvalRequestId,
          runId: event.runId,
          actionId: event.actionId,
          capabilityId: event.capabilityId,
          targetScope: event.targetScope,
          normalizedTarget: event.normalizedTarget,
          riskRationale: event.riskRationale,
          ...(event.timeoutMs !== undefined
            ? { timeoutMs: event.timeoutMs }
            : {}),
          state: "requested",
        };
        const action: ToolCallView = {
          ...(previous ?? {
            actionId: event.actionId,
            capabilityId: event.capabilityId,
            target: event.normalizedTarget,
            argsSummary: "",
            status: "pending",
          }),
          approval,
        };
        if (index === -1) turn.actions.push(action);
        else turn.actions[index] = action;
        return settleApprovalStatus(ensureToolBlock(turn, event.actionId));
      });
    }

    case "run.reconnect_snapshot": {
      const payload = payloadOf(envelope, "run.reconnect_snapshot");
      if (!payload) return missingPayload(next);
      const { runId, lastDurableSeq, turnId, state: snapshotState } = payload;
      next.resyncCount = state.needsResync
        ? state.resyncCount + 1
        : state.resyncCount;
      next.needsResync = false;
      delete next.resyncFromSeq;
      delete next.resyncAfterSeq;
      // Assumption: the snapshot is a hint, not applied history. The durable cursor
      // only advances when a durable event is reduced, so authoritative replay
      // from resyncFromSeq is applied exactly once and never skipped.
      next.lastSeq = Math.max(next.lastSeq, lastDurableSeq);
      const status: TurnStatus =
        snapshotState === "waiting_approval"
          ? "waiting_approval"
          : snapshotState === "stopped"
            ? "stopped"
            : "streaming";
      return updateRun(next, runId, (turn) => {
        const nextTurnId = turn.turnId ?? turnId;
        return {
          ...turn,
          ...(nextTurnId ? { turnId: nextTurnId } : {}),
          status:
            turn.status === "completed" || turn.status === "failed"
              ? turn.status
              : status,
        };
      });
    }

    case "engine.status": {
      const payload = payloadOf(envelope, "engine.status");
      if (!payload) return missingPayload(next);
      next.stale = payload.state === "stopped";
      return next;
    }

    case "session.tree_updated":
      return next;

    default:
      return { ...next, unknownKindCount: next.unknownKindCount + 1 };
  }
}

export function resyncRequest(state: TurnsState): { afterSeq: number } | null {
  if (!state.needsResync) return null;
  return { afterSeq: state.resyncAfterSeq ?? state.lastDurableSeq };
}

export function approvalRequestIdFor(
  state: TurnsState,
  actionId: string,
): string | undefined {
  return findAction(state, actionId)?.approval?.approvalRequestId;
}

export function canRespondToApproval(
  state: TurnsState,
  actionId: string,
): boolean {
  if (state.needsResync) return false;
  return findAction(state, actionId)?.approval?.state === "requested";
}

// TD-15 frozen limits (UNMEASURED proposal): renderer leg is 256 frames / 4 MiB;
// durable delivery pauses on 1024 frames / 8 MiB. fromSeq is cursor-exclusive.
export const TRANSPORT_LIMITS = {
  maxInlineBytes: 65536,
  maxEncodedFrameBytes: 262144,
  maxPayloadBytes: 262140,
  pendingQueueFrames: 1024,
  pendingQueueBytes: 8388608,
  rendererQueueFrames: 256,
  rendererQueueBytes: 4194304,
  transientCoalesceWindowMs: 16,
} as const;

export type TurnStreamErrorCode =
  "ERR_STREAM_RENDER_OVERFLOW" | "ERR_FRAME_TOO_LARGE";

interface PendingFrame {
  event: SplyceEventEnvelope;
  coalesced: boolean;
}

interface SessionChannel {
  state: TurnsState;
  acceptedSeq: number;
  pending: PendingFrame[];
  durableFrames: number;
  durableBytes: number;
  transientFrames: number;
  transientBytes: number;
  resyncNotified: boolean;
  /** While recovering: the one durable seq whose replay completes recovery. */
  recoverNext: number | undefined;
  durableSeq: number;
  replayUntil: number;
  seenEventIds: Set<string>;
}

export interface TurnStreamTransportOptions {
  state?: TurnsState;
  sessionId?: string;
  scopeId?: string;
  schedule?: (task: () => void) => void;
  onState?: (state: TurnsState) => void;
  onResync?: (fromSeq: number, sessionId: string) => void;
  onError?: (code: TurnStreamErrorCode) => void;
}

export interface TurnStreamTransport {
  enqueue(event: SplyceEventEnvelope): void;
  flush(): TurnsState;
  current(sessionId?: string): TurnsState;
  follow(sessionId: string, scopeId: string): void;
  unfollow(sessionId: string): void;
  rejectedCount(): number;
  dispose(): void;
}

const frameEncoder = new TextEncoder();
const fallbackState = createTurnsState();

function isTransientKind(kind: EventKind): boolean {
  return kind === "turn.stream_delta" || kind === "turn.thought_delta";
}

function frameBytes(event: SplyceEventEnvelope): number {
  return 4 + frameEncoder.encode(JSON.stringify(event)).length;
}

function payloadBytes(event: SplyceEventEnvelope): number {
  return "payload" in event && event.payload !== undefined
    ? frameEncoder.encode(JSON.stringify(event.payload)).length
    : 0;
}

function rendererValidationContext(event: {
  scopeId: string;
  sessionId: string;
}): ContractContext {
  return {
    scopeId: event.scopeId,
    sessionId: event.sessionId,
    configRevision: "renderer",
    profileRevision: "renderer",
    policyRevision: "renderer",
    lastDurableSeq: Number.MAX_SAFE_INTEGER,
    maxInlineBytes: TRANSPORT_LIMITS.maxInlineBytes,
    resolveReference: () => true,
  };
}

// Scope and session come from the followed subscription, never from the event.
function validateForRenderer(
  event: unknown,
  scopeId: string,
  sessionId: string,
): SplyceEventEnvelope | null {
  try {
    return validateEvent(
      event,
      rendererValidationContext({ scopeId, sessionId }),
    );
  } catch {
    return null;
  }
}

/**
 * Bounded renderer intake. Every frame is validated and sequence-checked per
 * session before transient coalescing, so duplicates, gaps and cross-session
 * traffic cannot reorder or merge into the rendered transcript.
 */
export function createTurnStreamTransport(
  options: TurnStreamTransportOptions = {},
): TurnStreamTransport {
  const channels = new Map<string, SessionChannel>();
  let selectedSessionId: string | undefined =
    options.sessionId ?? options.state?.sessionId;
  // sessionId -> scopeId, supplied by the caller (workbench/subscription).
  const followed = new Map<string, string>(
    selectedSessionId && options.scopeId
      ? [[selectedSessionId, options.scopeId]]
      : [],
  );
  const channelKey = (scopeId: string, sessionId: string) =>
    `${scopeId}\u0000${sessionId}`;
  const keyOf = (sessionId: string) => {
    const scopeId = followed.get(sessionId);
    return scopeId === undefined ? undefined : channelKey(scopeId, sessionId);
  };
  let rejected = 0;
  let scheduled = false;
  let disposed = false;

  const schedule =
    options.schedule ??
    ((task: () => void) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(task);
      } else {
        queueMicrotask(task);
      }
    });

  function channelFor(scopeId: string, sessionId: string): SessionChannel {
    const key = channelKey(scopeId, sessionId);
    const existing = channels.get(key);
    if (existing) return existing;
    const initial =
      options.state?.sessionId === sessionId
        ? options.state
        : createTurnsState();
    initial.sessionId = sessionId;
    const channel: SessionChannel = {
      state: initial,
      acceptedSeq: initial.lastSeq,
      pending: [],
      durableFrames: 0,
      durableBytes: 0,
      transientFrames: 0,
      transientBytes: 0,
      resyncNotified: false,
      recoverNext: undefined,
      durableSeq: initial.lastDurableSeq,
      replayUntil: 0,
      seenEventIds: new Set(),
    };
    channels.set(key, channel);
    return channel;
  }

  function selectedChannel(): SessionChannel | undefined {
    const key = selectedSessionId ? keyOf(selectedSessionId) : undefined;
    return key ? channels.get(key) : undefined;
  }

  function emit(channel: SessionChannel) {
    if (channel.state.sessionId === selectedSessionId) {
      options.onState?.(channel.state);
    }
  }

  function notifyResync(
    channel: SessionChannel,
    afterSeq = channel.state.lastDurableSeq,
  ) {
    if (!channel.state.needsResync || channel.resyncNotified) return;
    channel.resyncNotified = true;
    // Replay after afterSeq may be plain contiguous durable history (no
    // snapshot): its first unapplied frame completes recovery.
    channel.recoverNext = Math.max(afterSeq, channel.acceptedSeq) + 1;
    options.onResync?.(afterSeq, channel.state.sessionId ?? "");
  }

  // Unsequenced engine control. It is not data, so no seq, duplicate, applied
  // or durable cursor moves; replay is requested after
  // min(fromSeq, applied durable cursor) so no unseen seq is ever skipped.
  function applyControl(event: unknown) {
    const named = (event as { sessionId?: unknown }).sessionId;
    const scopeId = typeof named === "string" ? followed.get(named) : undefined;
    if (scopeId === undefined) {
      rejected += 1;
      return;
    }
    const channel = channelFor(scopeId, named as string);
    let control;
    try {
      control = validateControlFrame(event);
    } catch {
      channel.state = {
        ...channel.state,
        protocolErrors: channel.state.protocolErrors + 1,
      };
      emit(channel);
      return;
    }
    // Reduce queued frames first so the clamp sees the true applied cursor.
    applyPending(channel);
    const afterSeq = Math.min(control.fromSeq, channel.state.lastDurableSeq);
    channel.state = {
      ...channel.state,
      needsResync: true,
      resyncFromSeq: control.fromSeq,
      resyncAfterSeq: afterSeq,
    };
    // Each engine resync is its own replay request.
    channel.resyncNotified = false;
    notifyResync(channel, afterSeq);
    emit(channel);
  }

  function clearQueue(channel: SessionChannel) {
    channel.pending = [];
    channel.durableFrames = 0;
    channel.durableBytes = 0;
    channel.transientFrames = 0;
    channel.transientBytes = 0;
  }

  function overflow(channel: SessionChannel, code: TurnStreamErrorCode) {
    options.onError?.(code);
    // Discarded frames were never reduced: forget their ids so the authoritative
    // replay (from the applied durable cursor) is not dropped as a duplicate.
    for (const frame of channel.pending) {
      channel.seenEventIds.delete(frame.event.eventId);
    }
    clearQueue(channel);
    if (channel.state.needsResync) return;
    channel.acceptedSeq = channel.state.lastSeq;
    channel.durableSeq = channel.state.lastDurableSeq;
    channel.state = {
      ...channel.state,
      needsResync: true,
      resyncFromSeq: channel.state.lastDurableSeq,
      resyncAfterSeq: channel.state.lastDurableSeq,
    };
    notifyResync(channel);
    emit(channel);
  }

  function applyPending(channel: SessionChannel) {
    if (!channel.pending.length) return;
    const batch = channel.pending;
    clearQueue(channel);
    const hadResync = channel.state.needsResync;
    for (const frame of batch) {
      channel.state = reduceTurns(
        channel.state,
        frame.event,
        frame.coalesced ? { coalesced: true } : undefined,
      );
    }
    if (channel.state.needsResync && !hadResync) notifyResync(channel);
    if (!channel.state.needsResync) {
      channel.resyncNotified = false;
      channel.recoverNext = undefined;
    }
  }

  function pauseForResync(channel: SessionChannel) {
    applyPending(channel);
    channel.acceptedSeq = channel.state.lastSeq;
    channel.durableSeq = channel.state.lastDurableSeq;
    channel.state = {
      ...channel.state,
      needsResync: true,
      resyncFromSeq: channel.state.lastDurableSeq,
      resyncAfterSeq: channel.state.lastDurableSeq,
    };
    notifyResync(channel);
    emit(channel);
  }

  function scheduleFlush() {
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      if (!disposed) flush();
    });
  }

  function canMerge(
    previous: PendingFrame,
    event: SplyceEventEnvelope,
  ): boolean {
    if (!isTransientKind(event.kind) || previous.event.kind !== event.kind) {
      return false;
    }
    if (previous.event.seq + 1 !== event.seq) return false;
    if (!("payload" in previous.event) || !("payload" in event)) return false;
    const previousPayload = previous.event.payload as {
      runId?: string;
      turnId?: string;
    };
    const eventPayload = event.payload as { runId?: string; turnId?: string };
    return (
      previousPayload.runId === eventPayload.runId &&
      previousPayload.turnId === eventPayload.turnId
    );
  }

  function mergedEvent(
    previous: SplyceEventEnvelope,
    event: SplyceEventEnvelope,
  ): SplyceEventEnvelope {
    if (
      event.kind !== "turn.stream_delta" &&
      event.kind !== "turn.thought_delta"
    ) {
      return event;
    }
    const { payload: _payload, payloadArtifactId: _artifact, ...base } = event;
    const eventPayload = event.payload as { delta: string };
    return {
      ...base,
      payload: {
        ...eventPayload,
        delta:
          (previous.payload as { delta: string }).delta + eventPayload.delta,
      },
    } as SplyceEventEnvelope;
  }

  function enqueue(event: SplyceEventEnvelope) {
    if (disposed) return;
    // Control frames are dispatched before any data scope/shape/seq check.
    if ((event as { frame?: unknown } | null)?.frame === "control") {
      applyControl(event);
      return;
    }
    const claim = event as { sessionId?: unknown; scopeId?: unknown } | null;
    if (
      typeof claim?.sessionId === "string" &&
      followed.get(claim.sessionId) !== claim.scopeId
    ) {
      rejected += 1;
      return;
    }
    let bytes: number;
    try {
      bytes = frameBytes(event);
    } catch {
      const channel = selectedChannel();
      if (channel) {
        channel.state = {
          ...channel.state,
          protocolErrors: channel.state.protocolErrors + 1,
        };
        emit(channel);
      }
      return;
    }
    if (bytes > TRANSPORT_LIMITS.maxEncodedFrameBytes) {
      const channel = selectedChannel();
      if (channel) overflow(channel, "ERR_FRAME_TOO_LARGE");
      return;
    }
    const validated = claim
      ? validateForRenderer(
          event,
          claim.scopeId as string,
          claim.sessionId as string,
        )
      : null;
    if (!validated) {
      const channel = selectedChannel();
      if (channel) {
        channel.state = {
          ...channel.state,
          protocolErrors: channel.state.protocolErrors + 1,
        };
        emit(channel);
      }
      return;
    }
    const channel = channelFor(validated.scopeId, validated.sessionId);

    const isSnapshot = validated.kind === "run.reconnect_snapshot";
    const recovering = channel.state.needsResync;
    if (recovering && !isSnapshot) {
      if (!validated.durable || validated.seq !== channel.recoverNext) {
        if (validated.seq <= channel.acceptedSeq) {
          channel.state = {
            ...channel.state,
            duplicateCount: channel.state.duplicateCount + 1,
          };
          emit(channel);
        }
        // Beyond recoverNext: keep waiting for the requested replay.
        return;
      }
      // The first contiguous durable replay frame completes recovery.
      const {
        resyncFromSeq: _from,
        resyncAfterSeq: _after,
        ...rest
      } = channel.state;
      channel.state = {
        ...rest,
        needsResync: false,
        resyncCount: channel.state.resyncCount + 1,
      };
      channel.recoverNext = undefined;
      channel.resyncNotified = false;
    }

    if (channel.seenEventIds.has(validated.eventId)) {
      channel.state = {
        ...channel.state,
        duplicateCount: channel.state.duplicateCount + 1,
      };
      emit(channel);
      return;
    }

    // After a snapshot, durable frames in (applied cursor, snapshot cursor] are
    // authoritative replay the reducer has not seen: accept them, in any gap shape.
    const replay =
      validated.durable &&
      validated.seq <= channel.replayUntil &&
      validated.seq > channel.durableSeq;

    // A recovering snapshot at the applied cursor completes recovery.
    const duplicate =
      recovering && isSnapshot
        ? validated.seq < channel.acceptedSeq
        : validated.seq <= channel.acceptedSeq;
    if (!replay && duplicate) {
      channel.state = {
        ...channel.state,
        duplicateCount: channel.state.duplicateCount + 1,
      };
      emit(channel);
      return;
    }

    if (!isSnapshot && !replay && validated.seq !== channel.acceptedSeq + 1) {
      pauseForResync(channel);
      return;
    }

    const transient = isTransientKind(validated.kind);
    const previous = channel.pending[channel.pending.length - 1];
    let accepted = validated;
    if (transient && previous && canMerge(previous, validated)) {
      const merged = mergedEvent(previous.event, validated);
      if (payloadBytes(merged) <= TRANSPORT_LIMITS.maxInlineBytes) {
        const mergedBytes = frameBytes(merged);
        channel.transientBytes += mergedBytes - frameBytes(previous.event);
        previous.event = merged;
        previous.coalesced = true;
        accepted = merged;
      } else {
        channel.pending.push({ event: validated, coalesced: false });
        channel.transientFrames += 1;
        channel.transientBytes += bytes;
      }
    } else {
      channel.pending.push({ event: validated, coalesced: false });
      if (transient) {
        channel.transientFrames += 1;
        channel.transientBytes += bytes;
      } else {
        channel.durableFrames += 1;
        channel.durableBytes += bytes;
      }
    }

    channel.seenEventIds.add(validated.eventId);
    if (channel.seenEventIds.size > EVENT_ID_WINDOW) {
      channel.seenEventIds.delete(channel.seenEventIds.values().next().value!);
    }
    if (validated.durable && !isSnapshot) {
      channel.durableSeq = Math.max(channel.durableSeq, validated.seq);
    }
    if (isSnapshot && "payload" in accepted) {
      // Replay may carry durable seqs below the snapshot's transport seq; the
      // live cursor never moves backwards, so frame seq+1 stays contiguous.
      channel.replayUntil = accepted.seq;
      channel.acceptedSeq = Math.max(channel.acceptedSeq, accepted.seq);
      // Reduce at once so the resync gate lifts before the replay frames arrive.
      applyPending(channel);
    } else {
      channel.acceptedSeq = Math.max(channel.acceptedSeq, accepted.seq);
    }

    if (
      channel.transientFrames > TRANSPORT_LIMITS.rendererQueueFrames ||
      channel.transientBytes > TRANSPORT_LIMITS.rendererQueueBytes ||
      channel.durableFrames > TRANSPORT_LIMITS.pendingQueueFrames ||
      channel.durableBytes > TRANSPORT_LIMITS.pendingQueueBytes
    ) {
      overflow(channel, "ERR_STREAM_RENDER_OVERFLOW");
      return;
    }

    scheduleFlush();
  }

  function flush(): TurnsState {
    scheduled = false;
    for (const channel of channels.values()) applyPending(channel);
    const selected = selectedChannel();
    if (selected) emit(selected);
    return selected?.state ?? options.state ?? fallbackState;
  }

  return {
    enqueue,
    flush,
    follow(sessionId: string, scopeId: string) {
      followed.set(sessionId, scopeId);
      selectedSessionId ??= sessionId;
      emit(channelFor(scopeId, sessionId));
    },
    unfollow(sessionId: string) {
      const key = keyOf(sessionId);
      const channel = key ? channels.get(key) : undefined;
      // Keep applied transcript blocks: replay cannot restore transient replies.
      if (channel) applyPending(channel);
      followed.delete(sessionId);
      if (selectedSessionId === sessionId) {
        selectedSessionId = undefined;
        options.onState?.(createTurnsState());
      }
    },
    rejectedCount: () => rejected,
    current: (sessionId?: string) => {
      const key = sessionId ? keyOf(sessionId) : undefined;
      const channel = sessionId
        ? key
          ? channels.get(key)
          : undefined
        : selectedChannel();
      return channel?.state ?? options.state ?? fallbackState;
    },
    dispose() {
      disposed = true;
      for (const channel of channels.values()) clearQueue(channel);
      channels.clear();
      scheduled = false;
    },
  };
}
