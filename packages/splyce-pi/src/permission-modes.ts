import { createHash } from "node:crypto";
import { CONTRACT_VERSION, type NativePermissionMode } from "./contracts.js";
import type { CallerContext, Store } from "./store.js";

const MEDIA = "application/vnd.splyce.permission-mode+json";
const digest = (body: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
const fail = (): never => {
  throw Object.assign(new Error("Native setup unavailable"), {
    code: "SETUP_UNAVAILABLE",
  });
};

function modes(store: Store, workspaceId: string) {
  if (!store.getWorkspace(workspaceId)) fail();
  const state = store.readSetupState(workspaceId);
  const deleted = new Set(state.deletedRecordIds);
  return state.records.flatMap(({ kind, record }) => {
    if (kind !== "artifact" || record.mediaType !== MEDIA) return [];
    const body = record.permissionMode as {
      workspaceId: string;
      sessionId: string;
      mode: NativePermissionMode;
    };
    if (
      !body ||
      body.workspaceId !== workspaceId ||
      typeof body.sessionId !== "string" ||
      !["manual", "auto", "bypass"].includes(body.mode) ||
      digest(body) !== record.digest
    )
      fail();
    return [{ ...body, deleted: deleted.has(record.recordId) }];
  });
}

/** Old sessions without an explicit native record retain manual behavior. */
export function readPermissionMode(
  store: Store,
  workspaceId: string,
  sessionId?: string,
): NativePermissionMode {
  const latest = modes(store, workspaceId)
    .filter((row) => sessionId === undefined || row.sessionId === sessionId)
    .at(-1);
  return latest && !latest.deleted ? latest.mode : "manual";
}

export function persistPermissionMode(
  store: Store,
  caller: CallerContext,
  input: {
    requestId: string;
    workspaceId: string;
    sessionId: string;
    mode: NativePermissionMode;
  },
): void {
  if (!["manual", "auto", "bypass"].includes(input.mode)) fail();
  const body = {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    mode: input.mode,
  };
  const recordId = `permission-${createHash("sha256").update(input.requestId).digest("hex")}`;
  modes(store, input.workspaceId);
  const previous = store
    .list(input.workspaceId)
    .records.find(({ record }) => record.recordId === recordId);
  if (previous) {
    if (
      previous.record.digest !== digest(body) ||
      readPermissionMode(store, input.workspaceId, input.sessionId) !==
        input.mode
    )
      throw Object.assign(new Error("Native setup unavailable"), {
        code: "SETUP_REQUEST_CONFLICT",
      });
    return;
  }
  store.appendBatch(
    [
      {
        kind: "artifact",
        record: {
          schemaVersion: CONTRACT_VERSION,
          recordId,
          createdAt: new Date().toISOString(),
          scopeId: input.workspaceId,
          sourceIds: [],
          artifactId: recordId,
          digest: digest(body),
          mediaType: MEDIA,
          byteLength: new TextEncoder().encode(JSON.stringify(body)).length,
          retentionClass: "workspace",
          permissionMode: body,
        },
      },
    ],
    { ...caller, sessionId: input.sessionId },
    undefined,
    undefined,
    undefined,
    undefined,
    {
      expectedScopeCursor: {
        scopeId: input.workspaceId,
        seq: store.cursor(input.workspaceId),
      },
      expectedDeletionEpoch: store.deletionEpoch(),
    },
  );
}
