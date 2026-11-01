// TD-14 — revision fence for native dispatch.
//
// The single host-side authority that supplies NativePolicy's `current()`
// callback. It holds what the host may change at runtime (profile/policy
// revisions, the live grant set, plan mode) and reads the configuration
// revision from the durable store, so a committed config transition is visible
// to the very next policy check. NativePolicy fences twice around the effect
// handoff; this module makes the value those checks compare against current,
// immutable and serialized:
//
//  - grant withdrawal and revision changes are applied synchronously (no await
//    between the change and the next check), so a withdrawal that happens
//    before dispatch blocks the new effect;
//  - every snapshot is frozen, so a caller cannot mutate authority in place;
//  - queued / resumed / delegated work must present the revisions it was queued
//    under and is rejected when any differs (`assertCurrent`).

import type { CurrentPolicy } from "./policy.js";
import { AdmissionError } from "./policy.js";

/** Source of the durable, committed effective configuration revision. */
export interface ConfigRevisionSource {
  effectiveRevision(scopeId: string): string;
}

export interface QueuedRevisions {
  readonly configRevision: string;
  readonly profileRevision: string;
  readonly policyRevision: string;
}

export interface FenceInit {
  readonly scopeId: string;
  readonly profileRevision: string;
  readonly policyRevision: string;
  readonly grantIds: readonly string[];
  readonly planMode?: boolean;
}

export class RevisionFence {
  private readonly scopeId: string;
  private readonly config: ConfigRevisionSource;
  private profileRevision: string;
  private policyRevision: string;
  private readonly grants: Set<string>;
  private planMode: boolean;

  constructor(config: ConfigRevisionSource, init: FenceInit) {
    this.config = config;
    this.scopeId = init.scopeId;
    this.profileRevision = init.profileRevision;
    this.policyRevision = init.policyRevision;
    this.grants = new Set(init.grantIds);
    this.planMode = init.planMode ?? false;
  }

  /** The `current` callback for NativePolicy: a fresh, frozen snapshot per call. */
  readonly current = (): CurrentPolicy =>
    Object.freeze({
      configRevision: this.config.effectiveRevision(this.scopeId),
      profileRevision: this.profileRevision,
      policyRevision: this.policyRevision,
      grantIds: Object.freeze([...this.grants]),
      planMode: this.planMode,
    });

  /** Withdraws one grant; its permits are denied from the next check on. */
  revokeGrant(grantId: string): void {
    this.grants.delete(grantId);
  }

  grantAdded(grantId: string): void {
    this.grants.add(grantId);
  }

  /** A new profile revision makes every caller built on the old one stale. */
  setProfileRevision(revision: string): void {
    this.profileRevision = revision;
  }

  /** A new policy revision makes every caller built on the old one stale. */
  setPolicyRevision(revision: string): void {
    this.policyRevision = revision;
  }

  setPlanMode(planMode: boolean): void {
    this.planMode = planMode;
  }

  /** The revisions work must carry to be dispatchable right now. */
  revisions(): QueuedRevisions {
    const now = this.current();
    return {
      configRevision: now.configRevision,
      profileRevision: now.profileRevision,
      policyRevision: now.policyRevision,
    };
  }

  /**
   * Queued/resumed/delegated work re-checks the revisions it was queued under;
   * any difference (or plan mode) rejects it before it can dispatch.
   */
  assertCurrent(queued: QueuedRevisions): void {
    const now = this.current();
    if (
      now.planMode ||
      queued.configRevision !== now.configRevision ||
      queued.profileRevision !== now.profileRevision ||
      queued.policyRevision !== now.policyRevision
    )
      throw new AdmissionError("STALE_REVISION");
  }
}
