import { describe, expect, it } from "vitest";
import {
  modulesView,
  type ModuleCatalogEntry,
  type ModuleOperation,
  type ModuleSnapshot,
} from "../stores/modules";
import { moduleOptionalState } from "./module-optional-state";
import { w10Modules, w10ReadyForEnable } from "../../tests/td29/fixtures";

/**
 * TD-68 host mapping. The route may only claim a state it can prove from the
 * snapshot: an installed-but-off module, a package with no code on disk, a
 * catalog entry the host cannot run, and a cancelled operation that added
 * nothing. Everything else stays silent rather than guessing.
 */

const rowsOf = (snapshot: ModuleSnapshot) => modulesView(snapshot).rows;

const withEntry = (
  base: ModuleSnapshot,
  packageId: string,
  overrides: Partial<ModuleCatalogEntry>,
): ModuleSnapshot => ({
  ...base,
  entries: base.entries.map((entry) =>
    entry.packageId === packageId ? { ...entry, ...overrides } : entry,
  ),
});

const canceledOperation = (
  packageId: string,
  overrides: Partial<ModuleOperation> = {},
): ModuleOperation => ({
  operationId: `op-cancel-${packageId}`,
  requestId: `req-cancel-${packageId}`,
  kind: "install",
  packageId,
  stage: "outcome",
  message: "Cancelled before any file was written.",
  progress: null,
  outcome: "canceled",
  cleanupPending: false,
  retryAllowed: true,
  ...overrides,
});

describe("moduleOptionalState", () => {
  it("explains an installed module that is switched off", () => {
    const rows = rowsOf(w10Modules);
    const a = rows.find((row) => row.packageId === "fixture-a")!;
    expect(a.effective).toBe("off");
    expect(moduleOptionalState(a, w10Modules)).toBe("off");
  });

  it("stays silent for a module that is installed and ready", () => {
    const rows = rowsOf(w10ReadyForEnable);
    const ready = rows.find((row) => row.packageId === "fixture-d")!;
    expect(ready.effective).toBe("ready");
    expect(moduleOptionalState(ready, w10ReadyForEnable)).toBeNull();
  });

  it("explains a package with no code on disk as missing", () => {
    const snapshot: ModuleSnapshot = {
      ...w10Modules,
      installed: w10Modules.installed.map((item) =>
        item.packageId === "fixture-a" ? { ...item, state: "removed" } : item,
      ),
      operation: null,
    };
    const removed = rowsOf(snapshot).find(
      (row) => row.packageId === "fixture-a",
    )!;
    expect(moduleOptionalState(removed, snapshot)).toBe("missing");
  });

  it("explains a catalog entry this host cannot run as unsupported", () => {
    const snapshot = withEntry(w10Modules, "fixture-a", {
      incompatibleReason: "requires Windows 11 24H2",
    });
    const row = rowsOf(snapshot).find(
      (item) => item.packageId === "fixture-a",
    )!;
    expect(moduleOptionalState(row, snapshot)).toBe("unsupported");
  });

  it("prefers unsupported over missing: no code is not the whole story", () => {
    const base = withEntry(w10Modules, "fixture-a", {
      incompatibleReason: "requires Windows 11 24H2",
    });
    const snapshot: ModuleSnapshot = {
      ...base,
      installed: base.installed.map((item) =>
        item.packageId === "fixture-a" ? { ...item, state: "removed" } : item,
      ),
      operation: null,
    };
    const removed = rowsOf(snapshot).find(
      (row) => row.packageId === "fixture-a",
    )!;
    expect(moduleOptionalState(removed, snapshot)).toBe("unsupported");
  });

  it("explains a cancelled setup that added nothing as cancelled", () => {
    const snapshot: ModuleSnapshot = {
      ...w10Modules,
      installed: w10Modules.installed.map((item) =>
        item.packageId === "fixture-a" ? { ...item, state: "removed" } : item,
      ),
      operation: canceledOperation("fixture-a"),
    };
    const row = rowsOf(snapshot).find(
      (item) => item.packageId === "fixture-a",
    )!;
    expect(moduleOptionalState(row, snapshot)).toBe("cancelled");
  });

  it("never calls an installed module cancelled: the copy would be a lie", () => {
    const snapshot: ModuleSnapshot = {
      ...w10Modules,
      operation: canceledOperation("fixture-a"),
    };
    const row = rowsOf(snapshot).find(
      (item) => item.packageId === "fixture-a",
    )!;
    expect(row.packageState).toBe("installed");
    expect(moduleOptionalState(row, snapshot)).toBe("off");
  });

  it("ignores a cancelled operation that belongs to a different package", () => {
    const snapshot: ModuleSnapshot = {
      ...w10Modules,
      installed: w10Modules.installed.map((item) =>
        item.packageId === "fixture-a" ? { ...item, state: "removed" } : item,
      ),
      operation: canceledOperation("fixture-d"),
    };
    const row = rowsOf(snapshot).find(
      (item) => item.packageId === "fixture-a",
    )!;
    expect(moduleOptionalState(row, snapshot)).toBe("missing");
  });

  it("ignores an operation that has not reached a terminal outcome", () => {
    const snapshot: ModuleSnapshot = {
      ...w10Modules,
      installed: w10Modules.installed.map((item) =>
        item.packageId === "fixture-a" ? { ...item, state: "removed" } : item,
      ),
      operation: canceledOperation("fixture-a", { stage: "progress" }),
    };
    const row = rowsOf(snapshot).find(
      (item) => item.packageId === "fixture-a",
    )!;
    expect(moduleOptionalState(row, snapshot)).toBe("missing");
  });
});
