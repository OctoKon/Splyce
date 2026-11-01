/**
 * TD-29 GUI-flow fixtures.
 *
 * These are typed presentation inputs for the named cases D1_base_setup,
 * D6_optional_install_remove, FUI-W1 and FUI-W10. They are test data for the
 * renderer snapshot seam, not an engine, planner or package manager. The real
 * manager/installed-byte evidence remains TD-28/TD-58 (currently n=0).
 */
import {
  totalBytes,
  type InstalledModule,
  type InstallPlan,
  type ModuleCatalogEntry,
  type ModuleOperation,
  type ModuleSnapshot,
  type ModuleSource,
} from "../../src/stores/modules";

const repository = "https://github.com/OctoKon/Splyce.git";

function source(packageId: string, commit: string): ModuleSource {
  return { repository, commit, path: `modules/${packageId}` };
}

const BYTES_KNOWN = (bytes: number) => ({ state: "known", bytes }) as const;

function catalogEntry(
  packageId: string,
  title: string,
  overrides: Partial<ModuleCatalogEntry> = {},
): ModuleCatalogEntry {
  return {
    packageId,
    title,
    summary: `${title} from the pinned fixture catalog.`,
    source: source(packageId, "0123456789abcdef0123456789abcdef01234567"),
    contentDigest: `sha256:${packageId.padEnd(64, "0").slice(0, 64)}`,
    license: {
      id: "Apache-2.0",
      reference: `LICENSES/Apache-2.0-${packageId}.txt`,
    },
    compatibility: { host: "win32-x64", windows: "Windows 11", reason: null },
    download: BYTES_KNOWN(4096),
    installed: BYTES_KNOWN(8192),
    dependencies: [],
    requiresSetupExecution: false,
    model: null,
    incompatibleReason: null,
    ...overrides,
  };
}

function installedModule(
  packageId: string,
  overrides: Partial<InstalledModule> = {},
): InstalledModule {
  return {
    packageId,
    installationRevision: `install-${packageId}-1`,
    source: source(packageId, "89abcdef0123456789abcdef0123456789abcdef"),
    contentDigest: `sha256:${packageId.padEnd(64, "1").slice(0, 64)}`,
    state: "installed",
    requestedEnabled: false,
    effective: "off",
    readinessReason: null,
    dependencies: [],
    requiredBy: [],
    dependencyOwners: [],
    retainedData: [],
    cleanupPending: false,
    ...overrides,
  };
}

const d1Entries: readonly ModuleCatalogEntry[] = [];

/** D1/FUI-W1: clean base, offline catalog, ambient configs that grant nothing. */
export const d1BaseSetup: ModuleSnapshot = {
  engine: "ready",
  engineReason: null,
  catalog: {
    state: "unavailable",
    reason: "Offline: no cached catalog metadata is available.",
  },
  entries: d1Entries,
  installed: [],
  plan: null,
  generation: {
    state: "unconfigured",
    reason: "No generation model is selected.",
  },
  operation: null,
  ambientConfigRefs: ["splyce-memory", "lsp", "fixture-e"],
};

/** D6: fixture roots A/B share required dependency D; E is unselected. */
export const d6Entries: readonly ModuleCatalogEntry[] = [
  catalogEntry("fixture-a", "Fixture editor A", {
    dependencies: ["fixture-d"],
    requiresSetupExecution: true,
    download: BYTES_KNOWN(120000),
    installed: BYTES_KNOWN(240000),
  }),
  catalogEntry("fixture-b", "Fixture tools B", {
    dependencies: ["fixture-d"],
    download: BYTES_KNOWN(80000),
    installed: BYTES_KNOWN(160000),
  }),
  catalogEntry("fixture-d", "Shared runtime D", {
    download: BYTES_KNOWN(40000),
    installed: {
      state: "unknown",
      reason: "the catalog does not publish installed bytes",
    },
  }),
  catalogEntry("fixture-e", "Unselected fixture E", {
    download: BYTES_KNOWN(10000),
    installed: BYTES_KNOWN(20000),
  }),
];

function planEntry(
  entry: ModuleCatalogEntry,
  root: boolean,
  sharedWith: readonly string[] = [],
): InstallPlan["entries"][number] {
  return {
    packageId: entry.packageId,
    title: entry.title,
    root,
    source: entry.source,
    contentDigest: entry.contentDigest,
    license: `${entry.license.id} (${entry.license.reference})`,
    download: entry.download,
    installed: entry.installed,
    dependencies: entry.dependencies,
    requiresSetupExecution: entry.requiresSetupExecution,
    model: entry.model,
    sharedWith,
  };
}

const entryById = new Map(d6Entries.map((entry) => [entry.packageId, entry]));

function reviewedD6Plan(
  state: InstallPlan["state"],
  reason: string | null,
): InstallPlan {
  const entries = [
    planEntry(entryById.get("fixture-a")!, true, ["fixture-b"]),
    planEntry(entryById.get("fixture-b")!, true, ["fixture-a"]),
    planEntry(entryById.get("fixture-d")!, false, ["fixture-a", "fixture-b"]),
  ];
  return {
    planId: `plan-d6-${state}`,
    state,
    reason,
    entries,
    totalDownload: totalBytes(
      entries.map((entry) => ({
        packageId: entry.packageId,
        bytes: entry.download,
      })),
    ),
    totalInstalled: totalBytes(
      entries.map((entry) => ({
        packageId: entry.packageId,
        bytes: entry.installed,
      })),
    ),
  };
}

export const d6CurrentPlan = reviewedD6Plan("current", null);
export const d6StalePlan = reviewedD6Plan(
  "stale",
  "The pinned commit changed after review; review the selection again.",
);

/** D6 selection snapshot before review; the plan arrives from the engine seam. */
export const d6Catalog: ModuleSnapshot = {
  engine: "ready",
  engineReason: null,
  catalog: {
    state: "cached",
    source: repository,
    fetchedAt: "2026-10-27T00:00:00.000Z",
    stale: false,
  },
  entries: d6Entries,
  installed: [],
  plan: null,
  generation: {
    state: "unconfigured",
    reason: "No generation model is selected.",
  },
  operation: null,
  ambientConfigRefs: ["fixture-e"],
};

/** D6 review snapshot with a current engine plan. */
export const d6Reviewing: ModuleSnapshot = {
  ...d6Catalog,
  plan: d6CurrentPlan,
};

/** D6 tampered/stale plan after review; confirmation must stay disabled. */
export const d6ReviewingStale: ModuleSnapshot = {
  ...d6Catalog,
  plan: d6StalePlan,
};

/** One authoritative engine operation for the reviewed D6 plan. */
export function d6Operation(
  overrides: Partial<ModuleOperation> = {},
): ModuleOperation {
  return {
    operationId: "op-d6-install",
    // A fixture request identity. Correlation tests override this with the
    // requestId the component actually submitted; the engine must echo that.
    requestId: "req-d6-install",
    kind: "install",
    packageId: "fixture-a",
    stage: "accepted",
    message: "Accepted the reviewed plan.",
    progress: null,
    outcome: null,
    cleanupPending: false,
    retryAllowed: false,
    ...overrides,
  };
}

/**
 * D6 snapshot carrying an engine operation update. Applying successive values
 * to a mounted Setup screen is how the review covers the real progression.
 */
export function d6OperationSnapshot(
  overrides: Partial<ModuleOperation> = {},
): ModuleSnapshot {
  return { ...d6Reviewing, operation: d6Operation(overrides) };
}

const w10Catalog: readonly ModuleCatalogEntry[] = [
  catalogEntry("fixture-a", "Fixture editor A", {
    dependencies: ["fixture-d"],
    model: "fixture-embedding-model",
  }),
  catalogEntry("fixture-d", "Shared runtime D"),
  catalogEntry("fixture-cleanup", "Fixture cache cleanup", {
    installed: {
      state: "unknown",
      reason: "fixture cache size is not published",
    },
  }),
];

/** FUI-W10: installed/off separation, shared dependency, retained data, cleanup. */
export const w10Modules: ModuleSnapshot = {
  engine: "ready",
  engineReason: null,
  catalog: {
    state: "cached",
    source: repository,
    fetchedAt: "2026-10-27T00:00:00.000Z",
    stale: false,
  },
  entries: w10Catalog,
  installed: [
    installedModule("fixture-a", {
      dependencies: ["fixture-d"],
      dependencyOwners: ["fixture-d"],
      retainedData: ["fixture-a notes", "export bundle"],
    }),
    installedModule("fixture-d", {
      requiredBy: ["fixture-a"],
    }),
    installedModule("fixture-cleanup", {
      retainedData: ["cache entries"],
      cleanupPending: true,
    }),
  ],
  plan: null,
  generation: {
    state: "unconfigured",
    reason: "No generation model is selected.",
  },
  operation: {
    operationId: "op-w10-uninstall-a",
    requestId: "req-w10-uninstall-a",
    kind: "uninstall",
    packageId: "fixture-a",
    stage: "outcome",
    message: "Removed owned package code; retained references reported.",
    progress: null,
    outcome: "uninstalled",
    cleanupPending: false,
    retryAllowed: false,
  },
  ambientConfigRefs: [],
};

/** FUI-W10 with D ready, so enabling A is allowed once explicitly confirmed. */
export const w10ReadyForEnable: ModuleSnapshot = {
  ...w10Modules,
  installed: w10Modules.installed.map((item) =>
    item.packageId === "fixture-d"
      ? { ...item, requestedEnabled: true, effective: "ready" }
      : item,
  ),
  operation: null,
};

/** Engine loss: cached state stays visible, all effects are disabled. */
export const engineUnavailable: ModuleSnapshot = {
  ...w10Modules,
  engine: "unavailable",
  engineReason: "Engine process exited.",
  operation: null,
};

/** Catalog offline while installed modules remain manageable. */
export const catalogOfflineInstalled: ModuleSnapshot = {
  ...w10Modules,
  catalog: {
    state: "unavailable",
    reason: "Offline: no cached catalog metadata is available.",
  },
  entries: [],
  operation: null,
};
