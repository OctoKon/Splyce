/**
 * Typed presentation model for TD-29 setup/module UI.
 *
 * This module owns no authority: it copies an authoritative engine snapshot
 * into fixed labels and guards, and never resolves packages, fetches bytes,
 * grants permissions or invents installed/effective state. The frozen v1
 * contract has no setup/module events or operations yet, so callers supply
 * the snapshot from the future TD-28/TD-26 projection; tests use typed
 * fixtures. Ambient configuration is data, never permission.
 */

export type EngineState = "ready" | "unavailable" | "stale";

export type PackageState =
  "not-installed" | "staging" | "installed" | "failed" | "removing" | "removed";

export type EffectiveState =
  "off" | "unconfigured" | "starting" | "ready" | "draining" | "failed";

export type Bytes =
  | { readonly state: "known"; readonly bytes: number }
  | { readonly state: "unknown"; readonly reason: string };

export interface ModuleSource {
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
}

export interface ModuleCatalogEntry {
  readonly packageId: string;
  readonly title: string;
  readonly summary: string;
  readonly source: ModuleSource;
  readonly contentDigest: string;
  readonly license: { readonly id: string; readonly reference: string };
  readonly compatibility: {
    readonly host: string;
    readonly windows: string;
    readonly reason: string | null;
  };
  readonly download: Bytes;
  readonly installed: Bytes;
  readonly dependencies: readonly string[];
  readonly requiresSetupExecution: boolean;
  /** A separately provisioned model; never downloaded by install/enable. */
  readonly model: string | null;
  /** Incompatible entries stay visible with an honest reason. */
  readonly incompatibleReason: string | null;
}

export interface InstalledModule {
  readonly packageId: string;
  readonly installationRevision: string;
  readonly source: ModuleSource;
  readonly contentDigest: string;
  readonly state: PackageState;
  readonly requestedEnabled: boolean;
  readonly effective: EffectiveState;
  readonly readinessReason: string | null;
  readonly dependencies: readonly string[];
  /** Other installed modules that require this one. */
  readonly requiredBy: readonly string[];
  /** Shared dependency owners; an uninstall never removes these. */
  readonly dependencyOwners: readonly string[];
  /** Human-readable retained data inventory; deletion is separate. */
  readonly retainedData: readonly string[];
  readonly cleanupPending: boolean;
}

export interface InstallPlanEntry {
  readonly packageId: string;
  readonly title: string;
  readonly root: boolean;
  readonly source: ModuleSource;
  readonly contentDigest: string;
  readonly license: string;
  readonly download: Bytes;
  readonly installed: Bytes;
  readonly dependencies: readonly string[];
  readonly requiresSetupExecution: boolean;
  readonly model: string | null;
  readonly sharedWith: readonly string[];
}

export interface InstallPlan {
  readonly planId: string;
  readonly state: "current" | "stale" | "invalid";
  readonly reason: string | null;
  readonly entries: readonly InstallPlanEntry[];
  readonly totalDownload: Bytes;
  readonly totalInstalled: Bytes;
}

export type CatalogState =
  | {
      readonly state: "cached";
      readonly source: string;
      readonly fetchedAt: string;
      readonly stale: boolean;
    }
  | { readonly state: "unavailable"; readonly reason: string };

export type OperationKind =
  "install" | "enable" | "disable" | "uninstall" | "delete-data";

export interface ModuleOperation {
  readonly operationId: string;
  /**
   * The renderer-generated request identity this operation answers.
   *
   * The renderer mints one `requestId` per submitted request (install or retry)
   * and sends it with that request. Every operation update for that request must
   * echo the same `requestId`; that echo is the only evidence that an operation
   * belongs to this request. `operationId` alone cannot correlate anything: two
   * unrelated operations of the same kind can be indistinguishable.
   *
   * Seam: the frozen v1 contract has no setup/module request envelope yet, so a
   * future engine adapter must carry the request's `requestId` through to the
   * presentation snapshot. Until it echoes one, no operation can be admitted and
   * the screen keeps waiting for the engine. The renderer never fabricates the
   * echo or a success.
   */
  readonly requestId: string;
  readonly kind: OperationKind;
  readonly packageId: string | null;
  readonly stage: "accepted" | "started" | "progress" | "outcome";
  readonly message: string;
  readonly progress:
    | {
        readonly state: "known";
        readonly transferredBytes: number;
        readonly totalBytes: number;
      }
    | { readonly state: "unknown"; readonly transferredBytes: number }
    | null;
  readonly outcome:
    | "installed"
    | "enabled"
    | "disabled"
    | "uninstalled"
    | "deleted"
    | "failed"
    | "canceled"
    | "uncertain"
    | null;
  readonly cleanupPending: boolean;
  /** Only the engine may allow a retry; the renderer never invents one. */
  readonly retryAllowed: boolean;
}

export type GenerationState =
  | { readonly state: "configured"; readonly model: string }
  | { readonly state: "unconfigured"; readonly reason: string };

export interface ModuleSnapshot {
  readonly engine: EngineState;
  readonly engineReason: string | null;
  readonly catalog: CatalogState;
  readonly entries: readonly ModuleCatalogEntry[];
  readonly installed: readonly InstalledModule[];
  readonly plan: InstallPlan | null;
  readonly generation: GenerationState;
  readonly operation: ModuleOperation | null;
  /** Ambient config references are display-only evidence, never selections. */
  readonly ambientConfigRefs: readonly string[];
}

/**
 * Honest placeholder for a shell with no setup/module service connected.
 *
 * It claims no catalog, plan, installation or operation, and it keeps
 * generation unconfigured: an absent service is an unavailable state, not a
 * successful empty result and not an implicit install.
 */
export function unavailableModuleSnapshot(reason: string): ModuleSnapshot {
  return {
    engine: "unavailable",
    engineReason: reason,
    catalog: { state: "unavailable", reason },
    entries: [],
    installed: [],
    plan: null,
    generation: {
      state: "unconfigured",
      reason: "No generation model is selected.",
    },
    operation: null,
    ambientConfigRefs: [],
  };
}

export interface ActionState {
  readonly enabled: boolean;
  readonly reason: string | null;
}

const READY: ActionState = Object.freeze({ enabled: true, reason: null });
const blocked = (reason: string): ActionState => ({ enabled: false, reason });

export function action(enabled: boolean, reason: string | null): ActionState {
  return enabled ? READY : blocked(reason ?? "Unavailable.");
}

export function bytesLabel(bytes: Bytes): string {
  if (bytes.state === "unknown") return `Unknown (${bytes.reason})`;
  if (!Number.isFinite(bytes.bytes) || bytes.bytes < 0)
    return "Unknown (invalid byte count)";
  const n = bytes.bytes;
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"] as const;
  let value = n / 1000;
  let unit = 0;
  // Choose the unit AFTER rounding: 999_500 B rounds to 1000 kB, which must be
  // shown as 1.0 MB rather than "1000 kB".
  const format = () => value.toFixed(value < 10 ? 1 : 0);
  while (Number(format()) >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${format()} ${units[unit]}`;
}

/** A total is unknown when any member is unknown; it never becomes zero. */
export function totalBytes(
  items: readonly { readonly packageId: string; readonly bytes: Bytes }[],
): Bytes {
  if (items.length === 0) return { state: "known", bytes: 0 };
  const unknown = items.filter((item) => item.bytes.state === "unknown");
  if (unknown.length > 0) {
    return {
      state: "unknown",
      reason: `size unavailable for ${unknown.map((item) => item.packageId).join(", ")}`,
    };
  }
  return {
    state: "known",
    bytes: items.reduce(
      (sum, item) =>
        sum + (item.bytes.state === "known" ? item.bytes.bytes : 0),
      0,
    ),
  };
}

export function sourceLabel(source: ModuleSource): string {
  return `${source.repository}@${source.commit} · ${source.path}`;
}

/**
 * Selections always start empty. Existing user/project/ancestor config is not
 * permission to fetch, import, load or activate anything.
 */
export function initialSelection(): readonly string[] {
  return Object.freeze([]);
}

export function selectionState(
  snapshot: ModuleSnapshot,
  selected: readonly string[],
): ActionState {
  if (snapshot.engine !== "ready")
    return blocked(
      snapshot.engineReason ??
        "Engine unavailable; no install plan can be requested.",
    );
  if (snapshot.catalog.state !== "cached")
    return blocked("No catalog is available; refresh the catalog first.");
  const unique = [...new Set(selected)];
  if (unique.length === 0) return blocked("Select at least one module.");
  const byId = new Map(
    snapshot.entries.map((entry) => [entry.packageId, entry]),
  );
  for (const id of unique) {
    const entry = byId.get(id);
    if (!entry) return blocked(`Unknown module ${id}.`);
    if (entry.incompatibleReason)
      return blocked(
        `${entry.title} is incompatible: ${entry.incompatibleReason}`,
      );
  }
  return READY;
}

/** Client safety guard; the engine still owns plan freshness and admission. */
export function confirmInstallState(input: {
  readonly engine: EngineState;
  readonly engineReason?: string | null;
  readonly plan: InstallPlan | null;
  readonly selected: readonly string[];
  readonly executionGranted: boolean;
}): ActionState {
  const { engine, plan, selected, executionGranted } = input;
  if (engine !== "ready")
    return blocked(
      input.engineReason ??
        "Engine unavailable; the install plan cannot be submitted.",
    );
  if (selected.length === 0) return blocked("Select at least one module.");
  if (!plan)
    return blocked("No current install plan; review the selection again.");
  if (plan.state !== "current")
    return blocked(
      plan.reason ?? "The install plan is no longer current; review it again.",
    );
  if (plan.entries.length === 0) return blocked("The install plan is empty.");
  const roots = plan.entries
    .filter((entry) => entry.root)
    .map((entry) => entry.packageId)
    .sort();
  const picked = [...new Set(selected)].sort();
  if (
    roots.length !== picked.length ||
    !roots.every((id, index) => id === picked[index])
  )
    return blocked(
      "The reviewed plan does not match this selection; review again.",
    );
  const closure = planClosureGap(plan);
  if (closure !== null)
    return blocked(
      `The reviewed plan is missing required dependency ${closure}.`,
    );
  if (
    plan.entries.some((entry) => entry.requiresSetupExecution) &&
    !executionGranted
  )
    return blocked(
      "This plan includes an executable setup step; grant it separately.",
    );
  return READY;
}

/** Returns the first required dependency absent from the reviewed closure. */
export function planClosureGap(plan: InstallPlan): string | null {
  const present = new Set(plan.entries.map((entry) => entry.packageId));
  for (const entry of plan.entries)
    for (const dependency of entry.dependencies)
      if (!present.has(dependency)) return dependency;
  return null;
}

export function planMatchesSelection(
  plan: InstallPlan,
  selected: readonly string[],
): boolean {
  const roots = plan.entries
    .filter((entry) => entry.root)
    .map((entry) => entry.packageId)
    .sort();
  const picked = [...new Set(selected)].sort();
  return (
    roots.length === picked.length &&
    roots.every((id, index) => id === picked[index])
  );
}

export interface CatalogEntryView {
  readonly packageId: string;
  readonly title: string;
  readonly summary: string;
  readonly sourceLabel: string;
  readonly digestLabel: string;
  readonly licenseLabel: string;
  readonly compatibilityLabel: string;
  readonly downloadLabel: string;
  readonly installedLabel: string;
  readonly dependencyLabel: string;
  readonly setupExecutionLabel: string | null;
  readonly modelLabel: string | null;
  readonly selectable: boolean;
  readonly selectBlockedReason: string | null;
}

export function catalogEntryView(entry: ModuleCatalogEntry): CatalogEntryView {
  const compatible = entry.incompatibleReason === null;
  return {
    packageId: entry.packageId,
    title: entry.title,
    summary: entry.summary,
    sourceLabel: sourceLabel(entry.source),
    digestLabel: entry.contentDigest,
    licenseLabel: `${entry.license.id} (${entry.license.reference})`,
    compatibilityLabel: compatible
      ? `${entry.compatibility.host} / ${entry.compatibility.windows}`
      : `Incompatible: ${entry.incompatibleReason}`,
    downloadLabel: bytesLabel(entry.download),
    installedLabel: bytesLabel(entry.installed),
    dependencyLabel:
      entry.dependencies.length === 0
        ? "No required dependencies"
        : `Requires ${entry.dependencies.join(", ")} (never enabled automatically)`,
    setupExecutionLabel: entry.requiresSetupExecution
      ? "Includes an executable setup step; a separate grant is required"
      : null,
    modelLabel: entry.model
      ? `Separate model: ${entry.model} (never downloaded by install or enable)`
      : null,
    selectable: compatible,
    selectBlockedReason: compatible ? null : entry.incompatibleReason,
  };
}

export interface PlanEntryView {
  readonly packageId: string;
  readonly title: string;
  readonly roleLabel: "Selected" | "Required dependency";
  readonly sourceLabel: string;
  readonly digestLabel: string;
  readonly licenseLabel: string;
  readonly downloadLabel: string;
  readonly installedLabel: string;
  readonly setupExecution: boolean;
  readonly modelLabel: string | null;
  readonly sharedLabel: string | null;
}

function planEntryView(entry: InstallPlanEntry): PlanEntryView {
  return {
    packageId: entry.packageId,
    title: entry.title,
    roleLabel: entry.root ? "Selected" : "Required dependency",
    sourceLabel: sourceLabel(entry.source),
    digestLabel: entry.contentDigest,
    licenseLabel: entry.license,
    downloadLabel: bytesLabel(entry.download),
    installedLabel: bytesLabel(entry.installed),
    setupExecution: entry.requiresSetupExecution,
    modelLabel: entry.model
      ? `Separate model: ${entry.model} (not included in this plan)`
      : null,
    sharedLabel:
      entry.sharedWith.length === 0
        ? null
        : `Shares dependencies with ${entry.sharedWith.join(", ")}`,
  };
}

export interface PlanView {
  readonly planId: string;
  readonly current: boolean;
  readonly stateLabel: string;
  readonly reason: string | null;
  readonly roots: readonly PlanEntryView[];
  readonly dependencies: readonly PlanEntryView[];
  readonly downloadLabel: string;
  readonly installedLabel: string;
  readonly requiresSetupExecution: boolean;
  readonly modelLabels: readonly string[];
}

export function planView(
  plan: InstallPlan,
  selected: readonly string[],
): PlanView {
  const roots = plan.entries.filter((entry) => entry.root).map(planEntryView);
  const dependencies = plan.entries
    .filter((entry) => !entry.root)
    .map(planEntryView);
  const current =
    plan.state === "current" && planMatchesSelection(plan, selected);
  return {
    planId: plan.planId,
    current,
    stateLabel:
      plan.state === "current"
        ? current
          ? "Current plan"
          : "Selection changed"
        : plan.state === "stale"
          ? "Stale plan"
          : "Invalid plan",
    reason:
      plan.state === "current"
        ? current
          ? null
          : "The selection changed after review. Review it again before installing."
        : (plan.reason ?? "This plan is no longer current; review it again."),
    roots,
    dependencies,
    downloadLabel: bytesLabel(plan.totalDownload),
    installedLabel: bytesLabel(plan.totalInstalled),
    requiresSetupExecution: plan.entries.some(
      (entry) => entry.requiresSetupExecution,
    ),
    modelLabels: [
      ...new Set(
        plan.entries.flatMap((entry) => (entry.model ? [entry.model] : [])),
      ),
    ],
  };
}

export interface SetupView {
  readonly baseTitle: string;
  readonly baseBody: string;
  readonly baseIncludes: readonly string[];
  readonly baseExcludes: readonly string[];
  readonly generationLabel: string;
  readonly generationReason: string | null;
  readonly catalogLabel: string;
  readonly catalogDetail: string;
  readonly catalogUnavailableReason: string | null;
  readonly catalogStale: boolean;
  readonly entries: readonly CatalogEntryView[];
  readonly ambientNotice: string | null;
}

/** Presentation only; `snapshot` is already authoritative. */
export function setupView(snapshot: ModuleSnapshot): SetupView {
  const entries = snapshot.entries.map(catalogEntryView);
  const generation =
    snapshot.generation.state === "configured"
      ? {
          label: `Generation configured: ${snapshot.generation.model}`,
          reason: null,
        }
      : {
          label: "Generation unconfigured",
          reason: snapshot.generation.reason,
        };
  const catalog =
    snapshot.catalog.state === "cached"
      ? {
          label: snapshot.catalog.stale
            ? "Cached catalog (stale)"
            : "Cached catalog",
          detail: `Source: ${snapshot.catalog.source} · fetched ${snapshot.catalog.fetchedAt}`,
          reason: null,
          stale: snapshot.catalog.stale,
        }
      : {
          label: "Catalog unavailable",
          detail:
            "No catalog metadata is available. This is not an empty successful catalog.",
          reason: snapshot.catalog.reason,
          stale: true,
        };
  return {
    baseTitle: "Continue with base only",
    baseBody:
      "The base includes the Pi host, policy, receipts and verification. It installs no optional modules, model weights, servers or indexes.",
    baseIncludes: [
      "Pi coding host and required runtime",
      "Minimum policy, operational receipts and verification",
      "Plain file, search, edit and terminal tools",
    ],
    baseExcludes: [
      "Cross-session memory, RAG or embedding models",
      "LSP, external MCP servers, browser or device drivers",
      "Optional editor workers or downloadable model weights",
    ],
    generationLabel: generation.label,
    generationReason: generation.reason,
    catalogLabel: catalog.label,
    catalogDetail: catalog.detail,
    catalogUnavailableReason: catalog.reason,
    catalogStale: catalog.stale,
    entries,
    ambientNotice:
      snapshot.ambientConfigRefs.length === 0
        ? null
        : `Existing configuration references ${snapshot.ambientConfigRefs.join(", ")}. That is not permission to install, load or enable anything.`,
  };
}

export interface ModuleRowView {
  readonly packageId: string;
  readonly title: string;
  readonly packageState: PackageState;
  readonly packageStateLabel: string;
  readonly requestedLabel: string;
  readonly effective: EffectiveState;
  readonly effectiveLabel: string;
  readonly readinessReason: string | null;
  readonly revisionLabel: string;
  readonly sourceLabel: string;
  readonly digestLabel: string;
  readonly licenseLabel: string;
  readonly dependenciesLabel: string;
  readonly requiredByLabel: string;
  readonly sharedLabel: string;
  readonly retainedLabel: string;
  readonly cleanupLabel: string | null;
  readonly enable: ActionState;
  readonly disable: ActionState;
  readonly uninstall: ActionState;
  readonly deleteData: ActionState;
}

const PACKAGE_LABELS: Readonly<Record<PackageState, string>> = Object.freeze({
  "not-installed": "Not installed",
  staging: "Staging",
  installed: "Installed",
  failed: "Failed",
  removing: "Removing",
  removed: "Removed",
});

const EFFECTIVE_LABELS: Readonly<Record<EffectiveState, string>> =
  Object.freeze({
    off: "Off",
    unconfigured: "Unconfigured",
    starting: "Starting",
    ready: "Ready",
    draining: "Draining",
    failed: "Failed",
  });

export function packageStateLabel(state: PackageState): string {
  return PACKAGE_LABELS[state];
}

export function effectiveStateLabel(state: EffectiveState): string {
  return EFFECTIVE_LABELS[state];
}

export function moduleActionState(
  snapshot: ModuleSnapshot,
  installed: InstalledModule,
  action: "enable" | "disable" | "uninstall" | "delete-data",
): ActionState {
  if (snapshot.engine !== "ready")
    return blocked(
      snapshot.engineReason ??
        "Engine unavailable; no module change can be submitted.",
    );
  if (action === "enable") {
    if (installed.state !== "installed")
      return blocked("The package is not installed.");
    if (installed.requestedEnabled && installed.effective === "ready")
      return blocked("Already enabled.");
    if (installed.requestedEnabled && installed.effective !== "failed")
      return blocked(
        "Enable already requested; waiting for the effective state.",
      );
    const blockers = enableBlockers(snapshot, installed);
    return blockers.length === 0
      ? READY
      : blocked(`Enable dependencies separately first: ${blockers.join(" ")}`);
  }
  if (action === "disable") {
    if (!installed.requestedEnabled && installed.effective === "off")
      return blocked("Already off.");
    if (installed.effective === "draining")
      return blocked("Disable already requested; waiting for effective off.");
    return READY;
  }
  if (action === "uninstall") {
    if (installed.state === "removing")
      return blocked("Removal already in progress.");
    if (installed.state !== "installed")
      return blocked("Only an installed package can be uninstalled.");
    if (installed.requiredBy.length > 0)
      return blocked(
        `Required by ${installed.requiredBy.join(", ")}. Remove or update the dependants first; dependencies are never removed automatically.`,
      );
    if (installed.requestedEnabled || installed.effective !== "off")
      return blocked(
        "Disable this module and wait for effective off before uninstalling.",
      );
    return READY;
  }
  if (installed.retainedData.length === 0)
    return blocked("No retained data for this module.");
  if (installed.cleanupPending)
    return blocked(
      "Previous cleanup is incomplete; reconcile it before another deletion.",
    );
  return READY;
}

/**
 * Enabling never installs or silently enables a dependency. Missing or
 * non-ready dependencies block the action and stay visible.
 */
export function enableBlockers(
  snapshot: ModuleSnapshot,
  installed: InstalledModule,
): readonly string[] {
  const byId = new Map(
    snapshot.installed.map((item) => [item.packageId, item]),
  );
  const blockers: string[] = [];
  for (const dependencyId of installed.dependencies) {
    const dependency = byId.get(dependencyId);
    if (!dependency) {
      blockers.push(`${dependencyId} is not installed.`);
    } else if (
      !dependency.requestedEnabled ||
      dependency.effective !== "ready"
    ) {
      blockers.push(`${dependencyId} is not enabled and ready.`);
    }
  }
  return blockers;
}

export function addModuleState(snapshot: ModuleSnapshot): ActionState {
  if (snapshot.engine !== "ready")
    return blocked(
      snapshot.engineReason ?? "Engine unavailable; modules cannot be added.",
    );
  if (snapshot.catalog.state !== "cached")
    return blocked("No catalog is available; refresh the catalog first.");
  if (snapshot.entries.every((entry) => entry.incompatibleReason !== null))
    return blocked("No compatible modules are listed in the cached catalog.");
  return READY;
}

export interface ModulesView {
  readonly rows: readonly ModuleRowView[];
  readonly add: ActionState;
  readonly catalogLabel: string;
  readonly catalogDetail: string;
  readonly catalogUnavailableReason: string | null;
  readonly catalogStale: boolean;
  readonly generationLabel: string;
  readonly generationReason: string | null;
  readonly emptyLabel: string;
}

export function modulesView(snapshot: ModuleSnapshot): ModulesView {
  const entries = new Map(
    snapshot.entries.map((entry) => [entry.packageId, entry]),
  );
  const rows = snapshot.installed.map((installed): ModuleRowView => {
    const entry = entries.get(installed.packageId);
    return {
      packageId: installed.packageId,
      title: entry?.title ?? installed.packageId,
      packageState: installed.state,
      packageStateLabel: PACKAGE_LABELS[installed.state],
      requestedLabel: installed.requestedEnabled
        ? "Enabled requested"
        : "Off requested",
      effective: installed.effective,
      effectiveLabel: EFFECTIVE_LABELS[installed.effective],
      readinessReason: installed.readinessReason,
      revisionLabel: installed.installationRevision,
      sourceLabel: sourceLabel(installed.source),
      digestLabel: installed.contentDigest,
      licenseLabel: entry?.license.id ?? "License unavailable",
      dependenciesLabel:
        installed.dependencies.length === 0
          ? "No required dependencies"
          : `Requires ${installed.dependencies.join(", ")}`,
      requiredByLabel:
        installed.requiredBy.length === 0
          ? "No module requires this package"
          : `Required by ${installed.requiredBy.join(", ")}`,
      sharedLabel:
        installed.dependencyOwners.length === 0
          ? "No shared dependency owners"
          : `Shared dependencies kept: ${installed.dependencyOwners.join(", ")}`,
      retainedLabel:
        installed.retainedData.length === 0
          ? "No retained data"
          : `Retained data: ${installed.retainedData.join(", ")}`,
      cleanupLabel: installed.cleanupPending
        ? "Cleanup incomplete; survivors remain visible."
        : null,
      enable: moduleActionState(snapshot, installed, "enable"),
      disable: moduleActionState(snapshot, installed, "disable"),
      uninstall: moduleActionState(snapshot, installed, "uninstall"),
      deleteData: moduleActionState(snapshot, installed, "delete-data"),
    };
  });
  const catalog =
    snapshot.catalog.state === "cached"
      ? {
          label: snapshot.catalog.stale
            ? "Cached catalog (stale)"
            : "Cached catalog",
          detail: `Source: ${snapshot.catalog.source} · fetched ${snapshot.catalog.fetchedAt}`,
          reason: null,
          stale: snapshot.catalog.stale,
        }
      : {
          label: "Catalog unavailable",
          detail:
            "Installed modules stay manageable; adding modules needs a refreshed catalog.",
          reason: snapshot.catalog.reason,
          stale: true,
        };
  const generation =
    snapshot.generation.state === "configured"
      ? {
          label: `Generation configured: ${snapshot.generation.model}`,
          reason: null,
        }
      : {
          label: "Generation unconfigured",
          reason: snapshot.generation.reason,
        };
  return {
    rows,
    add: addModuleState(snapshot),
    catalogLabel: catalog.label,
    catalogDetail: catalog.detail,
    catalogUnavailableReason: catalog.reason,
    catalogStale: catalog.stale,
    generationLabel: generation.label,
    generationReason: generation.reason,
    emptyLabel:
      "No optional modules are installed. The base is complete without them.",
  };
}

export interface OperationView {
  readonly operationId: string;
  readonly kindLabel: string;
  readonly stageLabel: string;
  readonly message: string;
  readonly progressLabel: string | null;
  readonly progressValue: number | null;
  readonly outcomeLabel: string | null;
  readonly outcomeTone: "positive" | "negative" | "warning" | "neutral" | null;
  readonly cleanupLabel: string | null;
  readonly canCancel: ActionState;
  readonly canRetry: ActionState;
  readonly terminal: boolean;
}

const OPERATION_LABELS: Readonly<Record<OperationKind, string>> = Object.freeze(
  {
    install: "Install",
    enable: "Enable",
    disable: "Disable",
    uninstall: "Uninstall",
    "delete-data": "Delete retained data",
  },
);

const OPERATION_STAGE_LABELS: Readonly<
  Record<ModuleOperation["stage"], string>
> = Object.freeze({
  accepted: "Accepted",
  started: "Started",
  progress: "In progress",
  outcome: "Outcome",
});

const OUTCOME_LABELS: Readonly<
  Record<NonNullable<ModuleOperation["outcome"]>, string>
> = Object.freeze({
  installed: "Installed",
  enabled: "Enabled",
  disabled: "Disabled",
  uninstalled: "Uninstalled",
  deleted: "Retained data deleted",
  failed: "Failed",
  canceled: "Canceled",
  uncertain: "Uncertain",
});

export function operationView(
  snapshot: ModuleSnapshot,
  operation: ModuleOperation | null,
): OperationView | null {
  if (!operation) return null;
  const terminal = operation.stage === "outcome";
  const progress =
    operation.progress === null
      ? null
      : operation.progress.state === "known"
        ? {
            label: `${operation.progress.transferredBytes} of ${operation.progress.totalBytes} bytes`,
            value:
              operation.progress.totalBytes === 0
                ? null
                : operation.progress.transferredBytes /
                  operation.progress.totalBytes,
          }
        : {
            label: `Unknown total · ${operation.progress.transferredBytes} bytes observed`,
            value: null,
          };
  const outcomeTone =
    operation.outcome === null
      ? null
      : operation.outcome === "failed"
        ? "negative"
        : operation.outcome === "uncertain"
          ? "warning"
          : operation.outcome === "canceled"
            ? "neutral"
            : "positive";
  return {
    operationId: operation.operationId,
    kindLabel: OPERATION_LABELS[operation.kind],
    stageLabel: OPERATION_STAGE_LABELS[operation.stage],
    message: operation.message,
    progressLabel: progress?.label ?? null,
    progressValue: progress?.value ?? null,
    outcomeLabel:
      operation.outcome === null ? null : OUTCOME_LABELS[operation.outcome],
    outcomeTone,
    cleanupLabel: operation.cleanupPending
      ? "Cleanup incomplete; unresolved owned items remain visible."
      : null,
    canCancel:
      !terminal && snapshot.engine === "ready"
        ? READY
        : blocked(
            terminal
              ? "The operation already has an outcome."
              : (snapshot.engineReason ??
                  "Engine unavailable; cancellation cannot be submitted."),
          ),
    canRetry:
      terminal && operation.retryAllowed && snapshot.engine === "ready"
        ? READY
        : blocked(
            terminal
              ? operation.retryAllowed
                ? (snapshot.engineReason ??
                  "Engine unavailable; retry cannot be submitted.")
                : "No engine-reconciled retry is available; never replay an effect."
              : "Wait for a terminal outcome.",
          ),
    terminal,
  };
}
