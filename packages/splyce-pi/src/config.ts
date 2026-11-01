// TD-26 — one compare-and-set for requested/effective configuration.
//
// The effective revision of a scope is the latest `applied`
// configurationTransition (see Store.configRevision). A change is first
// recorded as `pending` (durable requested state, no effect), then `applied`
// only if the effective revision still equals the revision the caller expected
// — checked inside the same write transaction as the commit. Two competing
// writers can therefore never both apply, and a failed write leaves the
// effective revision untouched, so nothing can activate or dispatch through a
// stale selection.

import { CONTRACT_VERSION } from "./contracts.js";
import type { CallerContext } from "./store.js";
import { Store, StoreError } from "./store.js";

export class ConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export interface ConfigChange {
  scopeId: string;
  transitionId: string;
  expectedConfigRevision: string;
  acceptedConfigRevision: string;
  intentRef: string;
  changedValuesArtifactId: string;
}

export interface ConfigCommit {
  seq: number;
  effectiveRevision: string;
}

type TransitionState = "pending" | "applied" | "failed";

export class ConfigAuthority {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** The scope's current effective revision. */
  effectiveRevision(scopeId: string): string {
    return this.store.configRevision(scopeId);
  }

  /** Durably records the requested change. Never changes the effective revision. */
  request(change: ConfigChange, caller: CallerContext): ConfigCommit {
    return this.commit(change, "pending", caller, false);
  }

  /**
   * Applies the change iff the scope's effective revision still equals
   * `expectedConfigRevision`; otherwise throws CONFIG_STALE_REVISION and
   * records nothing.
   */
  apply(change: ConfigChange, caller: CallerContext): ConfigCommit {
    if (change.acceptedConfigRevision === change.expectedConfigRevision)
      throw new ConfigError(
        "CONFIG_NO_CHANGE",
        "acceptedConfigRevision must differ from expectedConfigRevision",
      );
    return this.commit(change, "applied", caller, true);
  }

  /** Marks the requested change failed. Never changes the effective revision. */
  fail(change: ConfigChange, caller: CallerContext): ConfigCommit {
    return this.commit(change, "failed", caller, false);
  }

  private commit(
    change: ConfigChange,
    state: TransitionState,
    caller: CallerContext,
    cas: boolean,
  ): ConfigCommit {
    const record = {
      schemaVersion: CONTRACT_VERSION,
      recordId: `${change.transitionId}.${state}`,
      createdAt: new Date().toISOString(),
      scopeId: change.scopeId,
      sourceIds: [],
      transitionId: change.transitionId,
      expectedConfigRevision: change.expectedConfigRevision,
      acceptedConfigRevision: change.acceptedConfigRevision,
      intentRef: change.intentRef,
      changedValuesArtifactId: change.changedValuesArtifactId,
      state,
      outcomeRef: null,
    };
    try {
      const { seqs } = this.store.appendBatch(
        [{ kind: "configurationTransition", record }],
        caller,
        undefined,
        undefined,
        cas
          ? {
              scopeId: change.scopeId,
              revision: change.expectedConfigRevision,
            }
          : undefined,
      );
      return {
        seq: seqs[0]!,
        effectiveRevision: this.store.configRevision(change.scopeId),
      };
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw new ConfigError(
        "CONFIG_COMMIT_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
