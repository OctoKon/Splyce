import { Store, INITIAL_CONFIG_REVISION } from "../dist/store.js";
import { NativeControl } from "./native-control.mjs";
import { createNativeSetupReader } from "./native-setup-read.mjs";
import {
  validatePermissionSet,
  validatePermissionRead,
} from "../dist/contracts.js";
import {
  persistPermissionMode,
  readPermissionMode,
} from "../dist/permission-modes.js";

const commandFields = new Map([
  ["setup.read", ["requestId", "workspaceId"]],
  [
    "profile.select",
    [
      "requestId",
      "workspaceId",
      "profileId",
      "expectedProfileRevision",
      "expectedConfigRevision",
    ],
  ],
  [
    "session.start",
    ["requestId", "workspaceId", "profileId", "expectedConfigRevision"],
  ],
]);

function invalid() {
  throw Object.assign(new Error("Native setup unavailable"), {
    code: "SETUP_INVALID",
  });
}

function unavailable(code = "SETUP_UNAVAILABLE") {
  throw Object.assign(new Error("Native setup unavailable"), { code });
}

// These commands carry identities and CAS expectations, never grants or locators.
export function validateNativeSessionSetup(command, payload, requestId) {
  if (command === "permission.set")
    return validatePermissionSet(payload, requestId);
  if (command === "permission.read" || command === "session.resume")
    return validatePermissionRead(payload, requestId);
  const fields = commandFields.get(command);
  if (
    !fields ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(payload);
  if (
    Reflect.ownKeys(payload).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(descriptors, field))
  )
    invalid();
  const accepted = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    const value = descriptor.value;
    if (
      !Object.hasOwn(descriptor, "value") ||
      typeof value !== "string" ||
      !value.isWellFormed() ||
      value.length === 0 ||
      Buffer.byteLength(value) > 128 ||
      /[\s\p{Cc}\p{Cf}/\\]/u.test(value)
    )
      invalid();
    accepted[field] = value;
  }
  if (accepted.requestId !== requestId) invalid();
  return Object.freeze(accepted);
}

/** Private native-parent service; only its result projections reach the renderer. */
export function createNativeSessionSetup({
  store,
  control,
  factory,
  currentPolicyRevision,
}) {
  if (!(store instanceof Store)) unavailable();
  const caller = Object.freeze({
    sessionId: "native-session-setup",
    configRevision: INITIAL_CONFIG_REVISION,
    profileRevision: INITIAL_CONFIG_REVISION,
    policyRevision: INITIAL_CONFIG_REVISION,
  });
  const bound = new Map();
  const readSetup = createNativeSetupReader({ store, control });
  let operations = Promise.resolve();
  let closed = false;
  const check = (signal) => {
    if (closed || signal?.aborted) unavailable();
  };
  const credentials = async (preparation, signal) => {
    if (!(control instanceof NativeControl))
      unavailable("CREDENTIAL_UNAVAILABLE");
    const refs = new Set(
      preparation.bindings.map(({ connection }) => connection.credentialRef),
    );
    if (refs.size === 0) unavailable("CREDENTIAL_UNAVAILABLE");
    for (const target of refs) {
      check(signal);
      let present;
      try {
        ({ present } = await control.credentialStatus({ target }, signal));
      } catch {
        unavailable("CREDENTIAL_UNAVAILABLE");
      }
      check(signal);
      if (present !== true) unavailable("CREDENTIAL_UNAVAILABLE");
    }
  };
  const dispose = async (prepared, reason) => {
    try {
      await factory.dispose(prepared, reason);
    } catch {
      unavailable("SETUP_OUTCOME_UNKNOWN");
    }
  };
  async function select(input, signal) {
    const preparation = store.prepareNativeSessionSetup(
      "profile.select",
      input,
    );
    if (!preparation.replay) await credentials(preparation, signal);
    check(signal);
    const committed = store.commitNativeProfileSelection(preparation, caller);
    // Grants are already revoked in the selection transaction before cleanup runs.
    for (const [sessionId, session] of committed.replayed ? [] : bound) {
      if (
        session.workspaceId !== input.workspaceId ||
        (session.profileId === committed.result.selectedProfileId &&
          session.profileRevision === committed.result.profileRevision)
      )
        continue;
      await dispose(session.prepared, "PROFILE_CHANGED");
      bound.delete(sessionId);
    }
    return {
      selectedProfileId: committed.result.selectedProfileId,
      profileRevision: committed.result.profileRevision,
      configRevision: committed.result.configRevision,
    };
  }
  async function start(input, signal) {
    if (
      !factory ||
      ["prepare", "restore", "bind", "dispose"].some(
        (key) => typeof factory[key] !== "function",
      )
    )
      unavailable();
    const preparation = store.prepareNativeSessionSetup("session.start", input);
    let prepared;
    let committed;
    if (preparation.replay) {
      committed = store.commitNativeSessionStart(
        preparation,
        undefined,
        caller,
        currentPolicyRevision,
      );
      if (committed.result.readiness.code === "SESSION_BIND_FAILED") {
        return {
          sessionId: committed.result.sessionId,
          sessionRevision: committed.result.sessionRevision,
          policyRevision: committed.result.policyRevision,
          readiness: { state: "unavailable", code: "SESSION_BIND_FAILED" },
        };
      }
    }
    try {
      await credentials(preparation, signal);
      check(signal);
      if (committed) {
        store.assertNativeSessionStartCurrent({
          workspaceId: input.workspaceId,
          sessionId: committed.result.sessionId,
          sessionRevision: committed.result.sessionRevision,
        });
        if (bound.has(committed.result.sessionId))
          return {
            sessionId: committed.result.sessionId,
            sessionRevision: committed.result.sessionRevision,
            policyRevision: committed.result.policyRevision,
            readiness: { state: "ready" },
            permissionMode: readPermissionMode(
              store,
              input.workspaceId,
              committed.result.sessionId,
            ),
          };
      }
      prepared = committed
        ? await factory.restore({
            workspaceId: input.workspaceId,
            piSessionId: committed.result.sessionId,
            branchAnchor: structuredClone(committed.branchAnchor),
          })
        : await factory.prepare({
            workspaceId: input.workspaceId,
            profileId: preparation.profile.profileId,
            profileRevision: preparation.profile.profileRevision,
            requestId: input.requestId,
          });
      check(signal);
      // Native preparation may await; credential absence must still stop the Store write.
      await credentials(preparation, signal);
      check(signal);
      if (!committed)
        committed = store.commitNativeSessionStart(
          preparation,
          {
            piSessionId: prepared.piSessionId,
            branchAnchor: prepared.branchAnchor,
          },
          caller,
          currentPolicyRevision,
        );
    } catch (error) {
      if (committed) {
        try {
          committed = store.failNativeSessionStart(
            {
              workspaceId: input.workspaceId,
              sessionId: committed.result.sessionId,
              sessionRevision: committed.result.sessionRevision,
            },
            caller,
            currentPolicyRevision,
          );
        } catch {
          unavailable("SETUP_OUTCOME_UNKNOWN");
        } finally {
          const cleanup =
            prepared ?? bound.get(committed.result.sessionId)?.prepared;
          if (cleanup) await dispose(cleanup, "SESSION_BIND_FAILED");
          bound.delete(committed.result.sessionId);
        }
        return {
          sessionId: committed.result.sessionId,
          sessionRevision: committed.result.sessionRevision,
          policyRevision: committed.result.policyRevision,
          readiness: { state: "unavailable", code: "SESSION_BIND_FAILED" },
        };
      }
      if (prepared) await dispose(prepared, "SETUP_COMMIT_FAILED");
      throw error;
    }
    try {
      await factory.bind(prepared);
      check(signal);
      await credentials(preparation, signal);
      store.assertNativeSessionStartCurrent({
        workspaceId: input.workspaceId,
        sessionId: committed.result.sessionId,
        sessionRevision: committed.result.sessionRevision,
      });
      bound.set(committed.result.sessionId, {
        workspaceId: input.workspaceId,
        profileId: committed.profileId,
        profileRevision: committed.profileRevision,
        configRevision: committed.configRevision,
        sessionRevision: committed.result.sessionRevision,
        prepared,
      });
      if (!preparation.replay)
        persistPermissionMode(store, caller, {
          requestId: `initial-${input.requestId}`,
          workspaceId: input.workspaceId,
          sessionId: committed.result.sessionId,
          mode: readPermissionMode(store, input.workspaceId),
        });
      return {
        sessionId: committed.result.sessionId,
        sessionRevision: committed.result.sessionRevision,
        policyRevision: committed.result.policyRevision,
        readiness: { state: "ready" },
        permissionMode: readPermissionMode(
          store,
          input.workspaceId,
          committed.result.sessionId,
        ),
      };
    } catch {
      try {
        committed = store.failNativeSessionStart(
          {
            workspaceId: input.workspaceId,
            sessionId: committed.result.sessionId,
            sessionRevision: committed.result.sessionRevision,
          },
          caller,
          currentPolicyRevision,
        );
      } catch {
        unavailable("SETUP_OUTCOME_UNKNOWN");
      } finally {
        await dispose(prepared, "SESSION_BIND_FAILED");
        bound.delete(committed.result.sessionId);
      }
      return {
        sessionId: committed.result.sessionId,
        sessionRevision: committed.result.sessionRevision,
        policyRevision: committed.result.policyRevision,
        readiness: { state: "unavailable", code: "SESSION_BIND_FAILED" },
      };
    }
  }
  return Object.freeze({
    handle(command, payload, requestId, signal) {
      const input = validateNativeSessionSetup(command, payload, requestId);
      const operation = operations
        .then(async () => {
          check(signal);
          if (command === "setup.read") {
            const result = await readSetup(input, signal);
            check(signal);
            return result;
          }
          if (command === "session.resume") {
            if (!store.getWorkspace(input.workspaceId)) unavailable();
            const snapshot = store.readSetupState(input.workspaceId);
            const deleted = new Set(snapshot.deletedRecordIds);
            const receipts = snapshot.records.filter(
              ({ kind, record }) =>
                kind === "artifact" &&
                record.nativeSetup?.command === "session.start" &&
                record.nativeSetup.sessionId === input.sessionId &&
                !deleted.has(record.recordId),
            );
            if (
              receipts.length !== 1 ||
              receipts[0].record.nativeSetup.request.workspaceId !==
                input.workspaceId
            )
              unavailable();
            return start(receipts[0].record.nativeSetup.request, signal);
          }
          if (command === "permission.set" || command === "permission.read") {
            if (!store.getWorkspace(input.workspaceId)) unavailable();
            if (command === "permission.set") {
              if (bound.get(input.sessionId)?.workspaceId !== input.workspaceId)
                unavailable();
              store.assertNativeSessionStartCurrent({
                workspaceId: input.workspaceId,
                sessionId: input.sessionId,
                sessionRevision: bound.get(input.sessionId).sessionRevision,
              });
              persistPermissionMode(store, caller, input);
            } else {
              const snapshot = store.audit();
              const deleted = new Set(snapshot.deletedRecordIds);
              const anchors = new Map();
              for (const { kind, record } of snapshot.records) {
                if (
                  kind === "branchAnchor" &&
                  record.scopeId === input.workspaceId &&
                  record.piSessionId === input.sessionId
                )
                  anchors.set(record.branchAnchorId, record);
              }
              if (
                deleted.has(input.sessionId) ||
                ![...anchors.values()].some(
                  (anchor) => !deleted.has(anchor.recordId),
                )
              )
                unavailable();
            }
            return {
              workspaceId: input.workspaceId,
              sessionId: input.sessionId,
              mode: readPermissionMode(
                store,
                input.workspaceId,
                input.sessionId,
              ),
            };
          }
          return command === "profile.select"
            ? select(input, signal)
            : start(input, signal);
        })
        .catch((error) => {
          const codes = [
            "SETUP_INVALID",
            "SETUP_UNAVAILABLE",
            "SETUP_REQUEST_CONFLICT",
            "STALE_REVISION",
            "WORKSPACE_SUPERSEDED",
            "CREDENTIAL_UNAVAILABLE",
            "SETUP_OUTCOME_UNKNOWN",
          ];
          unavailable(
            codes.includes(error?.code) ? error.code : "SETUP_UNAVAILABLE",
          );
        });
      operations = operation.catch(() => {});
      return operation;
    },
    async close() {
      closed = true;
      await operations;
      for (const [sessionId, session] of bound) {
        await dispose(session.prepared, "HOST_CLOSED");
        bound.delete(sessionId);
      }
    },
  });
}
