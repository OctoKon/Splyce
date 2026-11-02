import { Snapshot } from "../../../src/snapshots.ts";

export async function captureNativeSnapshot({
  store,
  workspace,
  caller,
  assertCurrent,
  control,
  signal,
}) {
  if (signal?.aborted || typeof assertCurrent !== "function")
    throw new Error("Inventory unavailable");
  assertCurrent();
  const { manifest } = await control.inventory(workspace, signal);
  if (signal?.aborted) throw new Error("Inventory unavailable");
  assertCurrent();
  const { recordId, digest } = Snapshot.fromManifest(manifest).persist(store, {
    ...caller,
    scopeId: workspace.workspaceId,
  });
  assertCurrent();
  if (signal?.aborted) throw new Error("Inventory unavailable");
  return { recordId, digest, baseRevision: digest };
}
