// TD-68 host mapping for Modules.svelte.
//
// The screen may only claim an optional-state it can prove from the snapshot.
// Everything else stays silent: a module that is starting, draining or failed
// already has its own readiness line, and inventing "off" or "missing" there
// would be the same inference TD-76 closed elsewhere.

import type { OptionalState } from "../components/OptionalStateHelp.svelte";
import type { ModuleRowView, ModuleSnapshot } from "../stores/modules";

/**
 * Precedence, strongest evidence first:
 *  1. a cancelled operation that left no installed code (nothing was added);
 *  2. a catalog entry this host cannot run (unsupported, even if also absent);
 *  3. a package with no code on disk (missing);
 *  4. an installed module that is switched off (off);
 *  5. otherwise no claim.
 */
export function moduleOptionalState(
  row: ModuleRowView,
  snapshot: ModuleSnapshot,
): OptionalState | null {
  const installed = row.packageState === "installed";

  const operation = snapshot.operation;
  const canceled =
    operation !== null &&
    operation.stage === "outcome" &&
    operation.outcome === "canceled" &&
    operation.packageId === row.packageId;
  if (canceled && !installed) return "cancelled";

  const entry = snapshot.entries.find(
    (candidate) => candidate.packageId === row.packageId,
  );
  if (entry && entry.incompatibleReason !== null) return "unsupported";

  if (row.packageState === "removed" || row.packageState === "not-installed")
    return "missing";

  if (installed && row.effective === "off") return "off";

  return null;
}
