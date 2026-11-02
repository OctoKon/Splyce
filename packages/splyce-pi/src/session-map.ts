// TD-10 (issue #78): C1 ancestry/events — the authoritative map between Pi
// session ids and native Splyce (scopeId, sessionId), plus the host point
// that owns one subscribed DesktopBridge+Receipts per Splyce session.
//
// Invariants:
// 1. One Pi session id maps to exactly one native (scopeId, sessionId) and
//    back. Rebinding the same pair is idempotent; any other pair is
//    SESSION_FOREIGN. Unbound ids are SESSION_UNKNOWN.
// 2. Ancestry is Pi-derived, never invented. It follows Pi's active branch
//    (`getLeafId`/`getBranch`): a session's base anchor starts at its fork
//    point (the last entry copied from the bound parent, whose file is this
//    header's `parentSession`); inside a session, an entry that is not the
//    first child of its parent opens a new anchor, so every leaf resolves to
//    a stable, distinct anchor chain and switching back restores it.
//    `firstChildEntryId` stays null until Pi has one. An unbound parent is
//    reported unresolved (`complete: false`), never guessed.
// 3. Anchors are durable `branchAnchor` records under the owning session; a
//    changed anchor (e.g. first child resolved) is appended next to its
//    predecessor, never rewritten, and an unchanged one is never duplicated.
// 4. scopeId/sessionId/seq on every published event come from the native
//    side (binding and Store ledger). An engine event carrying any is rejected.
// 5. At most one channel (DesktopBridge+Receipts) per (scopeId, sessionId).
//    `unfollow` releases only the channel (renderer left); `dispose` ends the
//    session (binding and channel). A later follow starts a fresh bridge
//    whose replay continues strictly after the caller's afterSeq.
// 6. Publishing never depends on a follower: every event commits through
//    Store.commitEvents (durable envelope atomic with its receipts; transient
//    events reserve their seq, payload not retained) before any delivery.
//    Follow replays Store.replayEvents after afterSeq; when that range
//    crosses a lost transient seq, a real committed `run.reconnect_snapshot`
//    leads the replay instead of claiming gapless history.
// 7. Run anchors are durable `run` records under the bound session, bound to
//    the active branch anchor; repeating a runId returns the existing anchor.
// Event seq, cursor and replay semantics belong to TD-15 (Store ledger and
// DesktopBridge); this module only binds, commits and routes.

import {
  CONTRACT_VERSION,
  type ContractContext,
  ContractError,
  PROTOCOL_VERSION,
  type RecordBodies,
  type RecordMetadata,
  type SplyceEvent,
  type SplyceEventDraft,
  TRANSPORT_LIMITS,
  validateEvent,
} from "./contracts.js";
import { DesktopBridge, type ResyncFrame } from "./desktop-bridge.js";
import { Receipts } from "./receipts.js";
import {
  type Appended,
  type AppendInput,
  type CallerContext,
  type Store,
  StoreError,
} from "./store.js";

export class SessionMapError extends Error {
  readonly code: "SESSION_UNKNOWN" | "SESSION_FOREIGN" | "SNAPSHOT_UNANCHORED";

  constructor(code: SessionMapError["code"], message: string) {
    super(message);
    this.name = "SessionMapError";
    this.code = code;
  }
}

/** Native-owned Splyce identity of a session. */
export interface SessionKey {
  readonly scopeId: string;
  readonly sessionId: string;
}

/** A Pi session entry as far as ancestry needs it. */
export interface PiEntryView {
  readonly id: string;
  readonly parentId: string | null;
}

/** The read surface of a live Pi `SessionManager` the map derives from. */
export interface PiSessionView {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getHeader(): { readonly parentSession?: string } | null;
  getEntries(): readonly PiEntryView[];
  getLeafId(): string | null;
  getBranch(fromId?: string): readonly PiEntryView[];
}

/** Splyce branch anchor: the frozen `branchAnchor` record body. */
export type BranchAnchor = Readonly<RecordBodies["branchAnchor"]>;

export interface AncestryNode extends SessionKey {
  readonly piSessionId: string;
  readonly anchor: BranchAnchor;
}

/** Leaf-to-root chain; `complete` is false when a parent is not bound. */
export interface Ancestry {
  readonly chain: readonly AncestryNode[];
  readonly complete: boolean;
}

/** Revisions/reference resolver shared by every session the map serves. */
export type MapContext = Omit<CallerContext, "sessionId">;

/** A run record minus the Pi fields the map stamps from the binding. */
export type RunAnchorInput = Omit<
  RecordBodies["run"],
  "piSessionId" | "branchAnchorId"
> &
  Pick<
    RecordMetadata,
    "schemaVersion" | "recordId" | "createdAt" | "scopeId" | "sourceIds"
  >;

/** An engine event without scope/session: the map stamps both. */
export type EngineEvent = Readonly<Record<string, unknown>>;

/** The per-session subscription the renderer's follow() and #61 bind to. */
export interface SessionChannel extends SessionKey {
  readonly receipts: Receipts;
  readonly bridge: DesktopBridge;
}

export interface FollowResult {
  readonly channel: SessionChannel;
  /**
   * This session's retained envelopes with seq > afterSeq, led by a committed
   * `run.reconnect_snapshot` when the range crosses a lost transient seq.
   */
  readonly replay: readonly SplyceEvent[];
}

export interface Published {
  /** The committed envelope with its ledger seq. */
  readonly event: SplyceEvent;
  /** A follower's control frame (overflow resync) the caller must deliver. */
  readonly frame: ResyncFrame | undefined;
}

const SNAPSHOT_STATE = {
  pending: "ready",
  running: "busy",
  uncertain: "busy",
  completed: "stopped",
  failed: "stopped",
  canceled: "stopped",
} as const;

interface Bound {
  readonly key: SessionKey;
  readonly piSessionId: string;
  readonly pi: PiSessionView;
}

const keyOf = (key: SessionKey): string =>
  JSON.stringify([key.scopeId, key.sessionId]);

const ANCHOR_FIELDS = [
  "piSessionId",
  "parentAnchorId",
  "forkPointEntryId",
  "firstChildEntryId",
  "activeLeafEntryId",
] as const;

export class SessionMap {
  private readonly byPi = new Map<string, Bound>();
  private readonly byKey = new Map<string, Bound>();
  private readonly channels = new Map<string, SessionChannel>();

  constructor(
    private readonly store: Store,
    private readonly context: MapContext,
  ) {}

  /** Derives the active anchor before the native Store commit, without publishing a binding. */
  preview(key: SessionKey, pi: PiSessionView): AncestryNode {
    function invalid(): never {
      throw new SessionMapError(
        "SESSION_FOREIGN",
        "session identity is invalid or already bound elsewhere",
      );
    }
    if (!key || typeof key !== "object" || Reflect.ownKeys(key).length !== 2)
      invalid();
    const captured: Record<string, string> = {};
    const validId = (id: unknown): id is string =>
      typeof id === "string" &&
      id.isWellFormed() &&
      id.length > 0 &&
      new TextEncoder().encode(id).length <= 128 &&
      !/[\s\p{Cc}\p{Cf}/\\]/u.test(id);
    for (const field of ["scopeId", "sessionId"]) {
      const descriptor = Object.getOwnPropertyDescriptor(key, field);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !validId(descriptor.value)
      )
        invalid();
      captured[field] = descriptor.value;
    }
    if (
      !pi ||
      [
        "getSessionId",
        "getSessionFile",
        "getHeader",
        "getEntries",
        "getLeafId",
        "getBranch",
      ].some(
        (method) =>
          typeof (pi as unknown as Record<string, unknown>)[method] !==
          "function",
      )
    )
      invalid();
    const piSessionId = pi.getSessionId();
    if (!validId(piSessionId)) invalid();
    const nativeKey = {
      scopeId: captured.scopeId!,
      sessionId: captured.sessionId!,
    };
    const existing = this.byPi.get(piSessionId),
      occupant = this.byKey.get(keyOf(nativeKey));
    if (
      (existing !== undefined || occupant !== undefined) &&
      (existing === undefined || existing !== occupant)
    )
      invalid();
    const bound: Bound = existing ?? { key: nativeKey, piSessionId, pi };
    const active = this.chain(bound, bound.pi.getLeafId(), new Set()).chain[0];
    if (active === undefined) throw new Error("ancestry chain is never empty");
    return Object.freeze({
      ...active,
      anchor: Object.freeze({ ...active.anchor }),
    });
  }

  /** Binds a live Pi session to a native Splyce session (invariant 1). */
  bind(key: SessionKey, pi: PiSessionView): AncestryNode {
    const piSessionId = pi.getSessionId();
    const existing = this.byPi.get(piSessionId);
    const occupant = this.byKey.get(keyOf(key));
    if (existing !== undefined || occupant !== undefined) {
      if (existing === undefined || existing !== occupant)
        throw new SessionMapError(
          "SESSION_FOREIGN",
          "Pi session or native session is already bound elsewhere",
        );
      return this.persist(existing);
    }
    const bound: Bound = {
      key: Object.freeze({ scopeId: key.scopeId, sessionId: key.sessionId }),
      piSessionId,
      pi,
    };
    this.byPi.set(piSessionId, bound);
    this.byKey.set(keyOf(bound.key), bound);
    try {
      return this.persist(bound);
    } catch (error) {
      if (this.byPi.get(piSessionId) === bound) this.byPi.delete(piSessionId);
      if (this.byKey.get(keyOf(bound.key)) === bound) {
        this.byKey.delete(keyOf(bound.key));
        this.channels.delete(keyOf(bound.key));
      }
      throw error;
    }
  }

  /** The native key bound to a Pi session id. */
  resolve(piSessionId: string): SessionKey {
    return this.bound(piSessionId).key;
  }

  /** Pi-derived active ancestry, leaf first (invariant 2). */
  ancestry(piSessionId: string): Ancestry {
    const bound = this.bound(piSessionId);
    return this.chain(bound, bound.pi.getLeafId(), new Set());
  }

  /** Durable, idempotent run anchor on the active branch (invariant 7). */
  anchorRun(piSessionId: string, run: RunAnchorInput): Appended {
    const bound = this.bound(piSessionId);
    const { scopeId, sessionId } = bound.key;
    if (run.scopeId !== scopeId)
      throw new SessionMapError(
        "SESSION_FOREIGN",
        "run scope differs from the bound native scope",
      );
    const active = this.persist(bound);
    // ponytail: linear scan of the session's records; add a store index on
    // runId if sessions grow large.
    const existing = this.store
      .list(scopeId, 0, sessionId)
      .records.find(
        (stored) =>
          stored.kind === "run" &&
          (stored.record as RecordBodies["run"]).runId === run.runId,
      );
    if (existing !== undefined)
      return { seq: existing.seq, recordId: existing.record.recordId };
    return this.store.append(
      {
        kind: "run",
        record: {
          ...run,
          piSessionId,
          branchAnchorId: active.anchor.branchAnchorId,
        },
      },
      { ...this.context, sessionId },
    );
  }

  /** The single channel for a bound session plus replay after afterSeq. */
  follow(key: SessionKey, afterSeq: number): FollowResult {
    const bound = this.byKey.get(keyOf(key));
    if (bound === undefined)
      throw new SessionMapError("SESSION_UNKNOWN", "native session not bound");
    const { scopeId, sessionId } = bound.key;
    const events = this.granted(
      bound,
      this.store.replayEvents(scopeId, sessionId, afterSeq),
    );
    // The persisted highwater includes transient reservations, so a lost
    // trailing transient is visible even to a fresh map after reopen.
    const highest = this.store.eventHighwater(scopeId, sessionId);
    const replay =
      events.length === highest - afterSeq
        ? events
        : this.granted(bound, [this.reconnectSnapshot(bound), ...events]);
    let channel = this.channels.get(keyOf(key));
    if (channel === undefined) {
      const receipts = new Receipts(this.store);
      const bridge = new DesktopBridge(this.contractContext(bound), receipts);
      channel = Object.freeze({ ...bound.key, receipts, bridge });
      this.channels.set(keyOf(key), channel);
    }
    // The follower has applied through afterSeq: later overflows resync from it.
    channel.bridge.resubscribe(afterSeq);
    return { channel, replay };
  }

  /** The renderer left: release its channel; the session stays bound. */
  unfollow(key: SessionKey): void {
    this.channels.delete(keyOf(key));
  }

  /**
   * Stamps native scope/session, commits through the Store ledger with its
   * receipts (atomic), then delivers to the follower if any (invariant 6).
   */
  publish(
    piSessionId: string,
    event: EngineEvent,
    receipts: readonly AppendInput[] = [],
  ): Published {
    const bound = this.bound(piSessionId);
    if (["scopeId", "sessionId", "seq"].some((f) => Object.hasOwn(event, f)))
      throw new SessionMapError(
        "SESSION_FOREIGN",
        "engine events must not carry scope, session or seq",
      );
    const committed = this.commit(
      bound,
      { ...event, ...bound.key } as unknown as SplyceEventDraft,
      receipts,
    );
    const channel = this.channels.get(keyOf(bound.key));
    return { event: committed, frame: channel?.bridge.submit(committed) };
  }

  /** Ends a session: binding and channel are dropped together. Idempotent. */
  dispose(key: SessionKey): void {
    const bound = this.byKey.get(keyOf(key));
    if (bound === undefined) return;
    this.byKey.delete(keyOf(key));
    this.byPi.delete(bound.piSessionId);
    this.channels.delete(keyOf(key));
  }

  private commit(
    bound: Bound,
    draft: SplyceEventDraft,
    receipts: readonly AppendInput[],
  ): SplyceEvent {
    const [event] = this.store.commitEvents(receipts, [draft], {
      ...this.context,
      sessionId: bound.key.sessionId,
    }).events;
    if (event === undefined) throw new Error("ledger committed no event");
    return event;
  }

  /** A real, committed snapshot for a replay range with lost transients. */
  private reconnectSnapshot(bound: Bound): SplyceEvent {
    const { scopeId, sessionId } = bound.key;
    const run = this.store
      .list(scopeId, 0, sessionId)
      .records.findLast((stored) => stored.kind === "run")?.record as
      (RecordMetadata & RecordBodies["run"]) | undefined;
    if (run === undefined)
      throw new SessionMapError(
        "SNAPSHOT_UNANCHORED",
        "replay crosses lost transient seqs but the session has no run anchor",
      );
    return this.commit(
      bound,
      {
        schemaVersion: CONTRACT_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        recordId: run.recordId,
        eventId: `snapshot-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        sourceIds: [],
        scopeId,
        sessionId,
        durable: true,
        kind: "run.reconnect_snapshot",
        payload: {
          runId: run.runId,
          lastDurableSeq: this.store.eventCursor(scopeId, sessionId),
          activeActionIds: [],
          state: SNAPSHOT_STATE[run.state],
        },
      },
      [],
    );
  }

  /**
   * Re-resolves every reference against the caller's current grants at replay
   * time: the source recordId, plus every ref-typed envelope and payload field
   * via the frozen event schema (validateEvent). One denial fails the whole
   * replay closed (no history).
   */
  private granted(bound: Bound, events: SplyceEvent[]): SplyceEvent[] {
    const resolve = this.context.resolveReference;
    if (resolve === undefined) return events;
    const { scopeId, sessionId } = bound.key;
    const context: ContractContext = {
      ...this.contractContext(bound),
      lastDurableSeq: this.store.eventHighwater(scopeId, sessionId),
      resolveReference: resolve,
    };
    const denied = () =>
      new StoreError(
        "EVENT_SOURCE",
        "event source record is unresolved or denied",
      );
    for (const event of events) {
      if (!resolve(event.recordId, event.scopeId)) throw denied();
      try {
        validateEvent(event, context);
      } catch (error) {
        if (
          error instanceof ContractError &&
          error.code === "UNRESOLVED_REFERENCE"
        )
          throw denied();
        throw error;
      }
    }
    return events;
  }

  private bound(piSessionId: string): Bound {
    const bound = this.byPi.get(piSessionId);
    if (bound === undefined)
      throw new SessionMapError("SESSION_UNKNOWN", "Pi session not bound");
    return bound;
  }

  private contractContext(bound: Bound): ContractContext {
    return {
      ...bound.key,
      configRevision: this.context.configRevision,
      profileRevision: this.context.profileRevision,
      policyRevision: this.context.policyRevision,
      lastDurableSeq: this.store.cursor(),
      maxInlineBytes: TRANSPORT_LIMITS.maxInlineBytes,
      resolveReference: this.context.resolveReference ?? (() => false),
    };
  }

  private parentOf(bound: Bound): Bound | undefined {
    const file = bound.pi.getHeader()?.parentSession;
    if (file === undefined) return undefined;
    for (const candidate of this.byPi.values())
      if (candidate.pi.getSessionFile() === file) return candidate;
    return undefined;
  }

  /** Anchor chain of `bound` with its active leaf at `leafId` (invariant 2). */
  private chain(
    bound: Bound,
    leafId: string | null,
    seen: Set<string>,
  ): Ancestry {
    seen.add(bound.piSessionId);
    const node = (anchor: BranchAnchor): AncestryNode => ({
      ...bound.key,
      piSessionId: bound.piSessionId,
      anchor,
    });
    const baseId = `anchor-${bound.piSessionId}`;
    const hasParent = bound.pi.getHeader()?.parentSession !== undefined;
    const parent = this.parentOf(bound);
    if (hasParent && (parent === undefined || seen.has(parent.piSessionId)))
      return {
        chain: [
          node({
            branchAnchorId: baseId,
            piSessionId: bound.piSessionId,
            parentAnchorId: null,
            forkPointEntryId: null,
            firstChildEntryId: null,
            activeLeafEntryId: leafId,
          }),
        ],
        complete: false,
      };

    const inherited = new Set(parent?.pi.getEntries().map((e) => e.id) ?? []);
    const entries = bound.pi.getEntries();
    const firstChild = (parentId: string | null): string | null =>
      entries.find((e) => e.parentId === parentId && !inherited.has(e.id))
        ?.id ?? null;
    const path = leafId === null ? [] : bound.pi.getBranch(leafId);
    let forkPoint: string | null = null;
    const segments: { fork: string | null; first: string | null }[] = [];
    for (const entry of path) {
      if (inherited.has(entry.id)) {
        forkPoint = entry.id;
        continue;
      }
      if (segments.length === 0)
        segments.push({ fork: forkPoint, first: firstChild(forkPoint) });
      if (entry.id !== firstChild(entry.parentId))
        segments.push({ fork: entry.parentId, first: entry.id });
    }
    if (segments.length === 0)
      segments.push({ fork: forkPoint, first: firstChild(forkPoint) });

    const upstream =
      parent === undefined ? undefined : this.chain(parent, forkPoint, seen);
    const anchors: BranchAnchor[] = [];
    segments.forEach((segment, i) => {
      anchors.push({
        branchAnchorId:
          i === 0 ? baseId : `${baseId}-${segment.first ?? "pending"}`,
        piSessionId: bound.piSessionId,
        parentAnchorId:
          i === 0
            ? (upstream?.chain[0]?.anchor.branchAnchorId ?? null)
            : (anchors[i - 1]?.branchAnchorId ?? null),
        forkPointEntryId: segment.fork,
        firstChildEntryId: segment.first,
        activeLeafEntryId: segments[i + 1]?.fork ?? leafId,
      });
    });
    return {
      chain: [...anchors.reverse().map(node), ...(upstream?.chain ?? [])],
      complete: upstream?.complete ?? true,
    };
  }

  /**
   * Appends the session's own active anchors that differ from their latest
   * stored record (invariant 3) and returns the active node.
   */
  private persist(bound: Bound): AncestryNode {
    const { chain } = this.ancestry(bound.piSessionId);
    const { scopeId, sessionId } = bound.key;
    // ponytail: rescans the session's records per call; index by anchor id
    // if sessions grow large.
    const stored = new Map<string, RecordBodies["branchAnchor"][]>();
    for (const { kind, record } of this.store.list(scopeId, 0, sessionId)
      .records)
      if (kind === "branchAnchor") {
        const anchor = record as RecordMetadata & RecordBodies["branchAnchor"];
        stored.set(anchor.branchAnchorId, [
          ...(stored.get(anchor.branchAnchorId) ?? []),
          anchor,
        ]);
      }
    for (const { piSessionId, anchor } of chain) {
      if (piSessionId !== bound.piSessionId) continue;
      const history = stored.get(anchor.branchAnchorId) ?? [];
      const latest = history.at(-1);
      if (
        latest !== undefined &&
        ANCHOR_FIELDS.every((field) => latest[field] === anchor[field])
      )
        continue;
      this.store.append(
        {
          kind: "branchAnchor",
          record: {
            schemaVersion: 1,
            recordId: `${anchor.branchAnchorId}.${String(history.length + 1)}`,
            createdAt: new Date().toISOString(),
            scopeId,
            sourceIds: [],
            ...anchor,
          },
        },
        { ...this.context, sessionId },
      );
    }
    const active = chain[0];
    if (active === undefined) throw new Error("ancestry chain is never empty");
    return active;
  }
}
