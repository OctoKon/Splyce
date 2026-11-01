import { describe, expect, it } from "vitest";
import {
  addModuleState,
  bytesLabel,
  confirmInstallState,
  effectiveStateLabel,
  enableBlockers,
  initialSelection,
  moduleActionState,
  modulesView,
  operationView,
  packageStateLabel,
  planClosureGap,
  planMatchesSelection,
  planView,
  selectionState,
  setupView,
  totalBytes,
  unavailableModuleSnapshot,
  type InstallPlan,
  type ModuleSnapshot,
} from "./modules";
import {
  d1BaseSetup,
  d6Catalog,
  d6CurrentPlan,
  d6Operation,
  d6OperationSnapshot,
  d6Reviewing,
  d6ReviewingStale,
  engineUnavailable,
  w10Modules,
  w10ReadyForEnable,
} from "../../tests/td29/fixtures";

const installed = (snapshot: ModuleSnapshot, packageId: string) => {
  const item = snapshot.installed.find((row) => row.packageId === packageId);
  if (!item) throw new Error(`missing fixture module ${packageId}`);
  return item;
};

describe("byte labels", () => {
  it("formats known sizes and never turns an unknown size into zero", () => {
    expect(bytesLabel({ state: "known", bytes: 0 })).toBe("0 B");
    expect(bytesLabel({ state: "known", bytes: 999 })).toBe("999 B");
    expect(bytesLabel({ state: "known", bytes: 1000 })).toBe("1.0 kB");
    expect(bytesLabel({ state: "known", bytes: 1_500_000 })).toBe("1.5 MB");
    expect(bytesLabel({ state: "unknown", reason: "not published" })).toBe(
      "Unknown (not published)",
    );
    expect(bytesLabel({ state: "known", bytes: Number.NaN })).toContain(
      "Unknown",
    );
    expect(bytesLabel({ state: "known", bytes: -1 })).toContain("Unknown");
  });

  it("picks the unit after rounding, so a rounded 1000 never keeps the smaller unit", () => {
    expect(bytesLabel({ state: "known", bytes: 999_499 })).toBe("999 kB");
    expect(bytesLabel({ state: "known", bytes: 999_500 })).toBe("1.0 MB");
    expect(bytesLabel({ state: "known", bytes: 999_999 })).toBe("1.0 MB");
    expect(bytesLabel({ state: "known", bytes: 999_950_000 })).toBe("1.0 GB");
    // The bytes boundary itself still stays in bytes.
    expect(bytesLabel({ state: "known", bytes: 999 })).toBe("999 B");
    expect(bytesLabel({ state: "known", bytes: 1000 })).toBe("1.0 kB");
  });

  it("totals known members and stays unknown when any member is unknown", () => {
    expect(totalBytes([])).toEqual({ state: "known", bytes: 0 });
    expect(
      totalBytes([
        { packageId: "a", bytes: { state: "known", bytes: 10 } },
        { packageId: "b", bytes: { state: "known", bytes: 20 } },
      ]),
    ).toEqual({ state: "known", bytes: 30 });
    const unknown = totalBytes([
      { packageId: "a", bytes: { state: "known", bytes: 10 } },
      {
        packageId: "d",
        bytes: { state: "unknown", reason: "not published" },
      },
    ]);
    expect(unknown.state).toBe("unknown");
    expect(bytesLabel(unknown)).toContain("d");
    expect(bytesLabel(unknown)).not.toContain("0 B");
  });
});

describe("D1_base_setup", () => {
  it("starts with no selection, no installed modules and an honest unconfigured model", () => {
    expect(initialSelection()).toEqual([]);
    const view = setupView(d1BaseSetup);
    expect(view.generationLabel).toBe("Generation unconfigured");
    expect(view.generationReason).toBe("No generation model is selected.");
    expect(view.catalogLabel).toBe("Catalog unavailable");
    expect(view.catalogUnavailableReason).toContain("Offline");
    expect(view.entries).toEqual([]);
    // Ambient config is shown as evidence, never as a selection or install.
    expect(view.ambientNotice).toContain("splyce-memory");
    expect(view.ambientNotice).toContain("not permission");
    expect(d1BaseSetup.installed).toEqual([]);
    expect(d1BaseSetup.plan).toBeNull();

    const modules = modulesView(d1BaseSetup);
    expect(modules.rows).toEqual([]);
    expect(modules.add.enabled).toBe(false);
    expect(modules.add.reason).toContain("catalog");
    expect(modules.generationLabel).toBe("Generation unconfigured");
    expect(modules.emptyLabel).toContain("base is complete");
  });

  it("rejects an implicit selection and invalid or incompatible roots", () => {
    expect(selectionState(d1BaseSetup, [])).toMatchObject({
      enabled: false,
    });
    expect(selectionState(d1BaseSetup, ["fixture-a"]).enabled).toBe(false);
    expect(selectionState(d6Catalog, []).reason).toContain("at least one");
    expect(selectionState(d6Catalog, ["fixture-a"]).enabled).toBe(true);
    expect(selectionState(d6Catalog, ["fixture-unknown"]).reason).toContain(
      "Unknown module",
    );
    const incompatible: ModuleSnapshot = {
      ...d6Catalog,
      entries: d6Catalog.entries.map((entry) =>
        entry.packageId === "fixture-e"
          ? { ...entry, incompatibleReason: "Windows ARM64 is not supported" }
          : entry,
      ),
    };
    expect(selectionState(incompatible, ["fixture-e"]).reason).toContain(
      "incompatible",
    );
  });
});

describe("D6_optional_install_remove review guard", () => {
  it("keeps roots and required dependency distinct and excludes unselected E", () => {
    const view = planView(d6CurrentPlan, ["fixture-b", "fixture-a"]);
    expect(view.current).toBe(true);
    expect(view.roots.map((entry) => entry.packageId).sort()).toEqual([
      "fixture-a",
      "fixture-b",
    ]);
    expect(view.dependencies.map((entry) => entry.packageId)).toEqual([
      "fixture-d",
    ]);
    expect(JSON.stringify(view)).not.toContain("fixture-e");
    expect(view.downloadLabel).not.toContain("0 B");
    // D's installed size is unknown, so the total stays honest.
    expect(view.installedLabel).toContain("Unknown");
    expect(view.installedLabel).toContain("fixture-d");
    expect(view.requiresSetupExecution).toBe(true);
  });

  it("requires the separate execution grant and a selection-matching current plan", () => {
    expect(
      confirmInstallState({
        engine: "ready",
        plan: d6CurrentPlan,
        selected: ["fixture-a", "fixture-b"],
        executionGranted: false,
      }),
    ).toMatchObject({
      enabled: false,
      reason: expect.stringContaining("executable setup step"),
    });
    expect(
      confirmInstallState({
        engine: "ready",
        plan: d6CurrentPlan,
        selected: ["fixture-a", "fixture-b"],
        executionGranted: true,
      }).enabled,
    ).toBe(true);

    expect(
      confirmInstallState({
        engine: "ready",
        plan: d6CurrentPlan,
        selected: ["fixture-a"],
        executionGranted: true,
      }).reason,
    ).toContain("does not match");
    expect(
      confirmInstallState({
        engine: "ready",
        plan: d6ReviewingStale.plan,
        selected: ["fixture-a", "fixture-b"],
        executionGranted: true,
      }).reason,
    ).toContain("pinned commit");
    expect(
      confirmInstallState({
        engine: "unavailable",
        engineReason: "Engine process exited.",
        plan: d6CurrentPlan,
        selected: ["fixture-a", "fixture-b"],
        executionGranted: true,
      }).reason,
    ).toContain("Engine process exited");
    expect(
      confirmInstallState({
        engine: "ready",
        plan: null,
        selected: ["fixture-a"],
        executionGranted: true,
      }).reason,
    ).toContain("No current install plan");
  });

  it("refuses a plan whose required closure was removed", () => {
    const gap: InstallPlan = {
      ...d6CurrentPlan,
      entries: d6CurrentPlan.entries.filter(
        (entry) => entry.packageId !== "fixture-d",
      ),
    };
    expect(planClosureGap(gap)).toBe("fixture-d");
    expect(
      confirmInstallState({
        engine: "ready",
        plan: gap,
        selected: ["fixture-a", "fixture-b"],
        executionGranted: true,
      }).reason,
    ).toContain("fixture-d");
    expect(
      planMatchesSelection(d6CurrentPlan, ["fixture-a", "fixture-b"]),
    ).toBe(true);
    expect(planMatchesSelection(d6CurrentPlan, ["fixture-a"])).toBe(false);
  });

  it("does not mutate the plan or selection while reviewing", () => {
    const before = JSON.stringify(d6Reviewing);
    const selection = ["fixture-a", "fixture-b"] as const;
    confirmInstallState({
      engine: "ready",
      plan: d6CurrentPlan,
      selected: selection,
      executionGranted: true,
    });
    planView(d6CurrentPlan, selection);
    expect(JSON.stringify(d6Reviewing)).toBe(before);
    expect(selection).toEqual(["fixture-a", "fixture-b"]);
  });
});

describe("FUI-W10 module lifecycle separation", () => {
  it("keeps requested, effective, installed and retained data distinct", () => {
    const view = modulesView(w10Modules);
    const a = view.rows.find((row) => row.packageId === "fixture-a")!;
    expect(a.packageStateLabel).toBe("Installed");
    expect(a.requestedLabel).toBe("Off requested");
    expect(a.effectiveLabel).toBe("Off");
    expect(a.retainedLabel).toContain("fixture-a notes");
    expect(a.sharedLabel).toContain("fixture-d");
    expect(a.enable.reason).toContain("fixture-d");
    expect(a.uninstall.enabled).toBe(true);
    expect(a.deleteData.enabled).toBe(true);

    const d = view.rows.find((row) => row.packageId === "fixture-d")!;
    expect(d.requestedLabel).toBe("Off requested");
    expect(d.effectiveLabel).toBe("Off");
    expect(d.uninstall.enabled).toBe(false);
    expect(d.uninstall.reason).toContain("Required by fixture-a");

    const ready = modulesView(w10ReadyForEnable);
    const readyD = ready.rows.find((row) => row.packageId === "fixture-d")!;
    expect(readyD.requestedLabel).toBe("Enabled requested");
    expect(readyD.effectiveLabel).toBe("Ready");

    const cleanup = view.rows.find(
      (row) => row.packageId === "fixture-cleanup",
    )!;
    expect(cleanup.deleteData.enabled).toBe(false);
    expect(cleanup.deleteData.reason).toContain("cleanup is incomplete");
  });

  it("blocks enabling until dependencies are enabled and ready", () => {
    const a = installed(w10Modules, "fixture-a");
    expect(enableBlockers(w10Modules, a)).toEqual([
      "fixture-d is not enabled and ready.",
    ]);
    expect(moduleActionState(w10Modules, a, "enable")).toMatchObject({
      enabled: false,
    });
    expect(
      moduleActionState(
        w10ReadyForEnable,
        installed(w10ReadyForEnable, "fixture-a"),
        "enable",
      ).enabled,
    ).toBe(true);
    expect(
      moduleActionState(
        w10ReadyForEnable,
        installed(w10ReadyForEnable, "fixture-d"),
        "enable",
      ).reason,
    ).toBe("Already enabled.");
    expect(
      moduleActionState(
        w10Modules,
        installed(w10Modules, "fixture-a"),
        "disable",
      ).reason,
    ).toBe("Already off.");
    expect(
      moduleActionState(
        w10ReadyForEnable,
        installed(w10ReadyForEnable, "fixture-d"),
        "disable",
      ).enabled,
    ).toBe(true);
  });

  it("requires disable/off before uninstall and keeps deletion separate", () => {
    const a = installed(w10Modules, "fixture-a");
    expect(moduleActionState(w10Modules, a, "uninstall").enabled).toBe(true);
    const onModule: ModuleSnapshot = {
      ...w10Modules,
      installed: w10Modules.installed.map((item) =>
        item.packageId === "fixture-a"
          ? { ...item, requestedEnabled: true, effective: "ready" }
          : item.packageId === "fixture-d"
            ? { ...item, requiredBy: [] }
            : item,
      ),
    };
    expect(
      moduleActionState(onModule, installed(onModule, "fixture-a"), "uninstall")
        .reason,
    ).toContain("Disable this module");
    expect(
      moduleActionState(
        onModule,
        installed(onModule, "fixture-a"),
        "delete-data",
      ).enabled,
    ).toBe(true);
  });

  it("disables every effect when the engine is unavailable", () => {
    for (const item of engineUnavailable.installed) {
      for (const action of [
        "enable",
        "disable",
        "uninstall",
        "delete-data",
      ] as const) {
        expect(
          moduleActionState(engineUnavailable, item, action).enabled,
          `${item.packageId} ${action}`,
        ).toBe(false);
      }
    }
    expect(addModuleState(engineUnavailable).reason).toContain(
      "Engine process exited",
    );
    expect(addModuleState(engineUnavailable).enabled).toBe(false);
  });

  it("maps outcome facts and never offers an unreconciled retry", () => {
    const view = operationView(w10Modules, w10Modules.operation);
    expect(view?.kindLabel).toBe("Uninstall");
    expect(view?.outcomeLabel).toBe("Uninstalled");
    expect(view?.outcomeTone).toBe("positive");
    expect(view?.canCancel.enabled).toBe(false);
    expect(view?.canRetry.enabled).toBe(false);
    expect(view?.canRetry.reason).toContain("never replay");

    const unknownProgress = operationView(w10Modules, {
      ...w10Modules.operation!,
      stage: "progress",
      outcome: null,
      progress: { state: "unknown", transferredBytes: 512 },
    });
    expect(unknownProgress?.progressLabel).toContain("Unknown total");
    expect(unknownProgress?.progressValue).toBeNull();
    expect(unknownProgress?.terminal).toBe(false);
    expect(unknownProgress?.canCancel.enabled).toBe(true);

    const offline = operationView(engineUnavailable, {
      ...w10Modules.operation!,
      stage: "started",
      outcome: null,
    });
    expect(offline?.canCancel.enabled).toBe(false);
  });
});

describe("operation updates drive the Setup progression", () => {
  it("reports accepted -> started -> progress -> terminal outcome through one identity", () => {
    const sequence = [
      d6Operation(),
      d6Operation({ stage: "started", message: "Staging started." }),
      d6Operation({
        stage: "progress",
        message: "Fetching the reviewed closure.",
        progress: { state: "known", transferredBytes: 50, totalBytes: 100 },
      }),
      d6Operation({
        stage: "outcome",
        outcome: "installed",
        message: "Committed the installed record.",
      }),
    ];
    const views = sequence.map((operation) => {
      const view = operationView(d6OperationSnapshot(operation), operation);
      expect(view).not.toBeNull();
      return view!;
    });

    expect(views.map((view) => view.stageLabel)).toEqual([
      "Accepted",
      "Started",
      "In progress",
      "Outcome",
    ]);
    expect(views.map((view) => view.terminal)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(views.every((view) => view.operationId === "op-d6-install")).toBe(
      true,
    );
    // Progress comes from the engine, determinate only when the total is known.
    expect(views[2].progressValue).toBe(0.5);
    expect(views[2].progressLabel).toContain("50 of 100 bytes");
    // Cancel is available while the operation is live and not once it ends.
    expect(views[1].canCancel.enabled).toBe(true);
    expect(views[3].canCancel.enabled).toBe(false);
    expect(views[3].outcomeLabel).toBe("Installed");
    expect(views[3].outcomeTone).toBe("positive");
  });

  it("keeps an uncertain outcome and pending cleanup in recovery tone", () => {
    const operation = d6Operation({
      stage: "outcome",
      outcome: "uncertain",
      message: "Commit was lost; reconciliation required.",
      cleanupPending: true,
    });
    const view = operationView(d6OperationSnapshot(operation), operation)!;
    expect(view.terminal).toBe(true);
    expect(view.outcomeLabel).toBe("Uncertain");
    expect(view.outcomeTone).toBe("warning");
    expect(view.cleanupLabel).toContain("Cleanup incomplete");
    expect(view.canCancel.enabled).toBe(false);
  });

  it("blocks cancellation and retry when the engine is gone", () => {
    const operation = d6Operation({
      stage: "outcome",
      outcome: "failed",
      retryAllowed: true,
    });
    const view = operationView(
      {
        ...d6OperationSnapshot(operation),
        engine: "unavailable",
        engineReason: "Engine process exited.",
      },
      operation,
    )!;
    expect(view.canCancel.enabled).toBe(false);
    expect(view.canRetry.enabled).toBe(false);
    expect(view.canRetry.reason).toContain("Engine process exited.");
  });
});

describe("shell placeholder snapshot", () => {
  it("claims nothing when no setup or module service is connected", () => {
    const snapshot = unavailableModuleSnapshot(
      "No setup or module service is connected.",
    );
    expect(snapshot.engine).toBe("unavailable");
    expect(snapshot.catalog.state).toBe("unavailable");
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.installed).toEqual([]);
    expect(snapshot.plan).toBeNull();
    expect(snapshot.operation).toBeNull();
    expect(snapshot.ambientConfigRefs).toEqual([]);
    expect(snapshot.generation.state).toBe("unconfigured");

    const setup = setupView(snapshot);
    expect(setup.catalogLabel).toBe("Catalog unavailable");
    expect(setup.catalogUnavailableReason).toContain(
      "No setup or module service is connected.",
    );
    expect(setup.generationLabel).toBe("Generation unconfigured");
    expect(
      confirmInstallState({
        engine: snapshot.engine,
        engineReason: snapshot.engineReason,
        plan: snapshot.plan,
        selected: [],
        executionGranted: false,
      }).enabled,
    ).toBe(false);

    const modules = modulesView(snapshot);
    expect(modules.rows).toEqual([]);
    expect(modules.add.enabled).toBe(false);
    expect(modules.emptyLabel).toContain("base is complete");
  });
});

describe("fixed status labels", () => {
  it("exposes one label per package and effective state", () => {
    expect(packageStateLabel("not-installed")).toBe("Not installed");
    expect(packageStateLabel("installed")).toBe("Installed");
    expect(packageStateLabel("removing")).toBe("Removing");
    expect(effectiveStateLabel("off")).toBe("Off");
    expect(effectiveStateLabel("unconfigured")).toBe("Unconfigured");
    expect(effectiveStateLabel("draining")).toBe("Draining");
  });
});
