// TD-15 (issue #37): desktop bridge — the renderer-facing transport surface.
// Submits validated SplyceEvents with bounded frames, a bounded pending queue,
// transient coalescing and the exactly-one-resync overflow rule. Numeric
// constructor options hold the v2 transport limits until the coordinated
// TRANSPORT_LIMITS additive patch lands in contracts (then bound here).
//
// Frozen contract types only; no unfrozen schema or local shim.

import {
  type ContractContext,
  type ResyncControlFrame,
  type SplyceEvent,
  TRANSPORT_LIMITS,
  validateControlFrame,
  validateEvent,
} from "./contracts.js";
import type { Receipts } from "./receipts.js";

/** Renderer transport limits, bound to the frozen shared constants. */
export const TRANSPORT_LIMIT_OPTIONS = TRANSPORT_LIMITS;

export type TransportLimitOptions = Partial<typeof TRANSPORT_LIMIT_OPTIONS>;

export class BridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

/** A renderer-ready frame: 4-byte big-endian length header + JSON body. */
export interface Frame<T = SplyceEvent> {
  readonly bytes: number;
  readonly encoded: Uint8Array;
  readonly event: T;
}

/** The unsequenced resync control frame returned by an overflowing submit. */
export type ResyncFrame = Frame<ResyncControlFrame>;

export interface DrainResult {
  frames: Frame[];
  /** True when the queue still holds frames beyond the renderer budget. */
  morePending: boolean;
}

export interface BridgeStatus {
  paused: boolean;
  pendingFrames: number;
  pendingBytes: number;
  lastResyncFromSeq: number | undefined;
}

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const eventSeq = (event: SplyceEvent): number => event.seq;

export class DesktopBridge {
  private readonly limits: typeof TRANSPORT_LIMIT_OPTIONS;
  private readonly baseContext: ContractContext;
  private readonly receipts: Receipts;
  /** Client's last applied/acknowledged event seq for this subscription. */
  private _clientAppliedSeq = 0;
  /** Pending frames in delivery order (durable and coalesced transient). */
  private queue: Frame[] = [];
  private queueBytes = 0;
  /** Durable saturation: delivery pauses until the renderer resyncs. */
  private paused = false;
  private lastResyncFromSeq: number | undefined;
  /** Per transient kind+runId: {frame, at} for window-based coalescing. */
  private readonly transient = new Map<string, { frame: Frame; at: number }>();
  /** Reverse index so drained frames can release their transient entry. */
  private readonly transientByFrame = new Map<Frame, string>();

  /**
   * Records a transient frame's coalescing entry. The map is bounded: the
   * oldest entry is evicted at the queue frame cap, and entries are released
   * when their frame drains — so 100 finished runs retain no state.
   */
  private trackTransient(key: string, frame: Frame): void {
    if (
      !this.transient.has(key) &&
      this.transient.size >= this.limits.pendingQueueMaxFrames
    ) {
      for (const oldest of this.transient.keys()) {
        const evicted = this.transient.get(oldest);
        this.transient.delete(oldest);
        if (evicted !== undefined) this.transientByFrame.delete(evicted.frame);
        break;
      }
    }
    const previous = this.transient.get(key);
    if (previous !== undefined) this.transientByFrame.delete(previous.frame);
    this.transient.set(key, { frame, at: Date.now() });
    this.transientByFrame.set(frame, key);
  }

  private releaseTransient(frame: Frame): void {
    const key = this.transientByFrame.get(frame);
    if (key === undefined) return;
    this.transientByFrame.delete(frame);
    if (this.transient.get(key)?.frame === frame) this.transient.delete(key);
  }

  constructor(
    baseContext: ContractContext,
    receipts: Receipts,
    options: TransportLimitOptions = {},
  ) {
    this.baseContext = baseContext;
    this.receipts = receipts;
    this.limits = { ...TRANSPORT_LIMIT_OPTIONS, ...options };
  }

  /** This session's event highwater: the cursor domain of every envelope seq. */
  private sessionEventCursor(): number {
    return this.receipts.sessionEventCursor(
      this.baseContext.scopeId,
      this.baseContext.sessionId,
    );
  }

  private context(): ContractContext {
    return {
      ...this.baseContext,
      lastDurableSeq: this.sessionEventCursor(),
      // The tightest of the caller's budget, the option budget and the frozen
      // shared ceiling applies: smaller is honored, larger never widens it.
      maxInlineBytes: Math.min(
        this.baseContext.maxInlineBytes,
        this.limits.maxInlineBytes,
        TRANSPORT_LIMIT_OPTIONS.maxInlineBytes,
      ),
    };
  }

  private encode<T>(event: T): Frame<T> {
    const body = new TextEncoder().encode(JSON.stringify(event));
    // 4-byte big-endian header included in the encoded budget.
    const encoded = new Uint8Array(4 + body.byteLength);
    new DataView(encoded.buffer).setUint32(0, body.byteLength, false);
    encoded.set(body, 4);
    return {
      bytes: encoded.byteLength,
      encoded,
      event,
    };
  }

  /**
   * Submits one event for renderer delivery. Validation uses the frozen
   * contract (payload XOR payloadArtifactId, durable flag per kind, inline
   * budget). On any queue overflow the queue is reset and exactly one
   * unsequenced `stream.resync` control frame is returned.
   */
  submit(value: unknown): ResyncFrame | undefined {
    if (this.paused)
      throw new BridgeError(
        "BRIDGE_PAUSED",
        "delivery is paused after overflow; drain the resync first",
      );
    let event: SplyceEvent;
    try {
      event = validateEvent(value, this.context());
    } catch (error) {
      const code = (error as { code?: string }).code ?? "INVALID_SHAPE";
      throw new BridgeError(
        `CONTRACT_${code}`,
        error instanceof Error ? error.message : String(error),
      );
    }
    const frame = this.encode(event);
    // Encoded-frame cap from the frozen shared constants — never overridable
    // by constructor options or caller context.
    if (frame.bytes > TRANSPORT_LIMITS.maxEncodedFrameBytes)
      throw new BridgeError(
        "CONTRACT_FRAME_TOO_LARGE",
        `encoded frame is ${String(frame.bytes)} bytes; the shared limit is ${String(TRANSPORT_LIMITS.maxEncodedFrameBytes)}`,
      );

    if (event.durable) {
      // Durable saturation: refuse further delivery, force a scoped resync.
      // The resync itself is control delivery and is never dropped.
      if (
        this.queue.length + 1 > this.limits.pendingQueueMaxFrames ||
        this.queueBytes + frame.bytes > this.limits.pendingQueueMaxBytes
      ) {
        this.overflow();
        return this.resyncFrame();
      }
      this.queue.push(frame);
      this.queueBytes += frame.bytes;
      return undefined;
    }

    // Transient (stream deltas): the ONLY skip is a true retransmission —
    // the same seq arriving again within the window while its frame is still
    // pending. Distinct seqs with identical bytes (e.g. a repeated "ha"
    // chunk) are real data and must both drain; nothing else is ever dropped
    // or replaced, so delivery stays lossless and the byte budget stays true.
    const payload = event.payload as Record<string, unknown> | undefined;
    const runId = typeof payload?.runId === "string" ? payload.runId : "";
    const key = `${event.kind}:${runId}`;
    const now = Date.now();
    const previous = this.transient.get(key);
    if (
      previous !== undefined &&
      now - previous.at <= this.limits.transientCoalesceWindowMs &&
      previous.frame.event.seq === event.seq &&
      this.queue.includes(previous.frame)
    ) {
      return undefined; // retransmission of the pending seq, lossless skip
    }
    this.trackTransient(key, frame);

    if (
      this.queue.length + 1 > this.limits.pendingQueueMaxFrames ||
      this.queueBytes + frame.bytes > this.limits.pendingQueueMaxBytes
    ) {
      // Transient overflow: drop the whole transient backlog (allowed — they
      // are not durable) and emit exactly one resync for the durable cursor.
      this.overflow();
      return this.resyncFrame();
    }
    this.queue.push(frame);
    this.queueBytes += frame.bytes;
    return undefined;
  }

  /** Reset the queue and arm the exactly-one resync (control path reserved). */
  private overflow(): void {
    this.queue = [];
    this.queueBytes = 0;
    this.transient.clear();
    this.transientByFrame.clear();
    this.paused = true;
  }

  private resyncFrame(): ResyncFrame {
    // Every overflow emits its own resync control frame; the exactly-one
    // rule is per overflow, not per cursor advance. The base cursor is
    // session-exact: other sessions'/scopes' records never move it.
    const highwater = this.sessionEventCursor();
    const fromSeq = this._clientAppliedSeq;
    if (fromSeq > highwater)
      throw new BridgeError(
        "INVALID_CURSOR",
        `client-applied seq ${String(fromSeq)} exceeds event highwater ${String(highwater)}`,
      );
    this.lastResyncFromSeq = fromSeq;
    // Unsequenced control: no seq, never persisted, never a cursor advance.
    // It must itself validate or the bridge is broken — never emit unvalidated.
    try {
      return this.encode(
        validateControlFrame({
          frame: "control",
          kind: "stream.resync",
          sessionId: this.baseContext.sessionId,
          fromSeq,
        }),
      );
    } catch (error) {
      throw new BridgeError(
        `CONTRACT_${(error as { code?: string }).code ?? "INVALID_SHAPE"}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Drains frames up to the renderer budget (256 frames / 4 MiB). Frames are
   * removed from the queue; a paused bridge resumes when the queue empties.
   */
  drain(): DrainResult {
    const frames: Frame[] = [];
    let bytes = 0;
    while (this.queue.length > 0) {
      const frame = this.queue[0];
      if (frame === undefined) break;
      if (
        frames.length >= this.limits.rendererMaxFrames ||
        bytes + frame.bytes > this.limits.rendererMaxBytes
      )
        break;
      this.queue.shift();
      this.queueBytes -= frame.bytes;
      bytes += frame.bytes;
      this.releaseTransient(frame);
      frames.push(frame);
    }
    if (this.queue.length === 0) this.paused = false;
    return { frames, morePending: this.queue.length > 0 };
  }

  /**
   * This session's retained event envelopes with seq > afterSeq (exclusive),
   * in the session event-seq domain: identical to `subscribe afterSeq`.
   */
  replay(afterSeq: number): SplyceEvent[] {
    return this.receipts.replayEvents(
      this.baseContext.scopeId,
      this.baseContext.sessionId,
      afterSeq,
    );
  }

  status(): BridgeStatus {
    return {
      paused: this.paused,
      pendingFrames: this.queue.length,
      pendingBytes: this.queueBytes,
      lastResyncFromSeq: this.lastResyncFromSeq,
    };
  }

  /**
   * (Re)subscribe at the client's last applied event seq: the base of every
   * later overflow resync on this subscription.
   */
  resubscribe(afterSeq: number): void {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0)
      throw new BridgeError(
        "INVALID_CURSOR",
        "client-applied seq must be a non-negative safe integer",
      );
    this._clientAppliedSeq = afterSeq;
  }

  /** Highest queued durable seq — the renderer's next afterSeq base. */
  highestQueuedSeq(): number {
    let highest = 0;
    for (const frame of this.queue) {
      // Transient deltas carry seqs but are never durable progress.
      if (!frame.event.durable) continue;
      const seq = eventSeq(frame.event);
      if (seq > highest) highest = seq;
    }
    return highest;
  }
}
