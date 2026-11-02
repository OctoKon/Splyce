import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { originView, TRANSPORT_LIMITS } from "../dist/contracts.js";
import { NativePolicy, actionArgumentsDigest } from "../dist/policy.js";
import { NativeCredentialResolver } from "../dist/credential-resolver.js";
import { NativeProviderRequests } from "../dist/native-provider.js";
import {
  ModelsListError,
  validateModelsListRequest,
  validateModelsListResult,
} from "../dist/model-data.js";
import { resolveNativeSessionSelection } from "./native-session-factory.mjs";
import { Snapshot } from "../../../src/snapshots.ts";

const fail = (code = "MODEL_CATALOG_UNAVAILABLE") => {
  throw new ModelsListError(code);
};

export function projectLiveModels(raw, apiFamily) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.data))
    fail("MODEL_CATALOG_INVALID");
  const models = [],
    seen = new Set();
  let truncated = false;
  let resultBytes = 64;
  for (const row of raw.data) {
    if (!row || typeof row !== "object" || Array.isArray(row))
      fail("MODEL_CATALOG_INVALID");
    if (row.supported_endpoints !== undefined) {
      if (
        !Array.isArray(row.supported_endpoints) ||
        row.supported_endpoints.some(
          (v) => typeof v !== "string" || v.length > 256,
        )
      )
        fail("MODEL_CATALOG_INVALID");
      const wanted =
        apiFamily === "openai-responses" ? "responses" : "chat/completions";
      if (
        !row.supported_endpoints.some(
          (v) => v.replace(/^\/?(?:v1\/)?/u, "") === wanted,
        )
      )
        continue;
    }
    const model = { modelId: row.id };
    const title = row.title ?? row.description;
    if (title !== undefined) {
      if (typeof title !== "string" || !title.isWellFormed())
        fail("MODEL_CATALOG_INVALID");
      const label = title.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim();
      if (label.length) model.title = label.slice(0, 256).toWellFormed();
    }
    if (row.context_length !== undefined)
      model.contextWindow = row.context_length;
    if (row.tools !== undefined) model.tools = row.tools;
    if (row.paid_only !== undefined) model.paidOnly = row.paid_only;
    validateModelsListResult({ models: [model], truncated: false });
    if (seen.has(model.modelId)) fail("MODEL_CATALOG_INVALID");
    seen.add(model.modelId);
    const bytes = Buffer.byteLength(JSON.stringify(model)) + 1;
    if (
      models.length < 500 &&
      resultBytes + bytes < TRANSPORT_LIMITS.maxEncodedFrameBytes - 4096
    ) {
      models.push(model);
      resultBytes += bytes;
    } else truncated = true;
  }
  return validateModelsListResult({ models, truncated });
}

export function createLiveModelCatalog({
  store,
  profiles,
  control,
  directory,
  providerCapability,
  currentPolicyRevision,
}) {
  return async (raw, signal) => {
    const input = validateModelsListRequest(raw);
    let ownership,
      caller,
      run,
      release = false,
      resolver;
    let succeeded = false,
      runCommitted = false;
    try {
      const effective = profiles.effective(input.workspaceId);
      if (effective?.profileId !== input.profileId)
        fail("MODEL_CATALOG_DENIED");
      const selectionInput = {
        store,
        profiles,
        workspaceId: input.workspaceId,
        profileId: input.profileId,
        profileRevision: effective.profileRevision,
        directory,
      };
      const selected = resolveNativeSessionSelection(selectionInput);
      const origin = originView(selected.endpoint);
      const audit = store.audit();
      if (store.deletionEpoch() !== selected.state.deletionEpoch)
        fail("MODEL_CATALOG_DENIED");
      const deleted = new Set(audit.deletedRecordIds);
      const records = audit.records.filter(
        ({ record }) => record.scopeId === input.workspaceId,
      );
      const grants = records
        .filter(
          ({ kind, record }) =>
            kind === "grant" &&
            record.recordId === record.grantId &&
            !deleted.has(record.recordId) &&
            record.capability === "net.provider" &&
            record.origin === origin,
        )
        .map(({ record }) => record);
      // Catalog reads reuse the selected session's origin grant; they never mint one.
      const anchors = records.filter(
        ({ kind, record }) =>
          kind === "branchAnchor" && !deleted.has(record.recordId),
      );
      let session;
      for (const anchor of anchors.toReversed()) {
        const grant = grants.find(
          (g) => g.sessionId === anchor.record.piSessionId,
        );
        if (!grant) continue;
        try {
          store.assertNativeSessionStartCurrent({
            workspaceId: input.workspaceId,
            sessionId: grant.sessionId,
            sessionRevision: String(anchor.seq),
          });
          session = {
            grant,
            anchor: anchor.record,
            revision: String(anchor.seq),
          };
          break;
        } catch {
          /* Stale sessions confer no catalog authority. */
        }
      }
      if (!session) fail("MODEL_CATALOG_DENIED");
      const policyRevision = currentPolicyRevision(input.workspaceId);
      const epoch = selected.state.deletionEpoch;
      const assertCurrent = () => {
        if (
          signal?.aborted ||
          store.deletionEpoch() !== epoch ||
          currentPolicyRevision(input.workspaceId) !== policyRevision
        )
          fail("MODEL_CATALOG_DENIED");
        const fresh = resolveNativeSessionSelection(selectionInput);
        for (const key of [
          "effective",
          "profile",
          "connection",
          "endpoint",
          "descriptor",
          "limits",
        ])
          if (!isDeepStrictEqual(fresh[key], selected[key]))
            fail("MODEL_CATALOG_DENIED");
        store.assertNativeSessionStartCurrent({
          workspaceId: input.workspaceId,
          sessionId: session.grant.sessionId,
          sessionRevision: session.revision,
        });
      };
      assertCurrent();
      const refs = new Set();
      caller = {
        sessionId: session.grant.sessionId,
        configRevision: effective.configRevision,
        profileRevision: effective.profileRevision,
        policyRevision,
        resolveReference: (ref, scopeId) => {
          if (scopeId !== input.workspaceId) return false;
          if (ref === scopeId) return true;
          if (refs.has(ref)) return true;
          if (store.deletionEpoch() !== epoch) return false;
          return store
            .list(scopeId)
            .records.some(
              ({ record }) =>
                !deleted.has(record.recordId) &&
                [
                  record.recordId,
                  record.artifactId,
                  record.actionId,
                  record.profileId,
                  record.piSessionId,
                  record.branchAnchorId,
                ].includes(ref),
            );
        },
      };
      release = !store.workspaceOwner(input.workspaceId);
      ownership = store.acquireWorkspace(input.workspaceId, caller.sessionId);
      const capability = providerCapability(selected);
      const semantic = {
        schema: "splyce-models-request-v1",
        providerConnectionId: selected.connection.providerConnectionId,
        endpointRef: selected.connection.endpointRef,
      };
      const argsId = randomUUID();
      const bytes = JSON.stringify(semantic);
      refs.add(argsId);
      store.append(
        {
          kind: "artifact",
          record: {
            schemaVersion: 1,
            recordId: argsId,
            artifactId: argsId,
            scopeId: input.workspaceId,
            sourceIds: [],
            createdAt: new Date().toISOString(),
            digest: actionArgumentsDigest(semantic),
            byteLength: Buffer.byteLength(bytes),
            mediaType: "application/vnd.splyce.model-catalog-request+json",
            retentionClass: "workspace",
          },
        },
        caller,
      );
      // This metadata operation excludes all workspace files from its snapshot.
      const snapshot = Snapshot.fromManifest({
        tracked: [],
        untracked: [],
        excluded: ["**"],
      }).persist(store, { ...caller, scopeId: input.workspaceId });
      refs.add(snapshot.recordId);
      run = {
        schemaVersion: 1,
        recordId: randomUUID(),
        scopeId: input.workspaceId,
        sourceIds: [],
        createdAt: new Date().toISOString(),
        runId: randomUUID(),
        piSessionId: caller.sessionId,
        branchAnchorId: session.anchor.branchAnchorId,
        workspaceId: input.workspaceId,
        baseRevision: snapshot.digest,
        baseSnapshotId: snapshot.recordId,
        taskArtifactId: argsId,
        grantIds: [session.grant.grantId],
        profileId: input.profileId,
        profileRevision: effective.profileRevision,
        roleBindingRefs: [...selected.profile.roleBindingRefs],
        state: "running",
      };
      refs.add(run.recordId);
      refs.add(run.runId);
      store.append({ kind: "run", record: run }, caller);
      runCommitted = true;
      const identity = {
        observe: () => {
          assertCurrent();
          const stat = statSync(selected.state.workspace.canonicalPath, {
            bigint: true,
          });
          if (!stat.isDirectory()) fail("MODEL_CATALOG_DENIED");
          return { volumeSerial: String(stat.dev), fileId: String(stat.ino) };
        },
      };
      const policy = new NativePolicy(
        store,
        caller,
        () => {
          assertCurrent();
          return { ...caller, grantIds: run.grantIds, planMode: false };
        },
        identity,
      );
      let requests;
      resolver = new NativeCredentialResolver({
        env: {},
        readCredentialStore: (target, request) =>
          requests.readCredentialStore(target, request),
      });
      resolver.register({
        providerConnectionId: selected.connection.providerConnectionId,
        connectionRevision: selected.connection.revision,
        endpointRef: selected.connection.endpointRef,
        egressPolicyRef: selected.profile.egressPolicyRefs[0],
        source: {
          kind: "credentialStore",
          target: selected.connection.credentialRef,
        },
      });
      requests = new NativeProviderRequests(policy, resolver, control);
      const actionId = randomUUID();
      const permit = {
        toolCallId: randomUUID(),
        toolName: "models_list",
        actionId,
        runRecordId: run.recordId,
        grantId: session.grant.grantId,
        parentActionId: null,
        ...capability,
        argumentsArtifactId: argsId,
        argumentsDigest: actionArgumentsDigest(semantic),
        targetScopeId: input.workspaceId,
        idempotencyKey: randomUUID(),
        ownership,
        capability: "net.provider",
        origin,
      };
      policy.authorize(permit);
      const scope = requests.createScope({
        requestKind: "models",
        permit,
        args: semantic,
        request: {
          providerConnectionId: selected.connection.providerConnectionId,
          connectionRevision: selected.connection.revision,
          endpointRef: selected.connection.endpointRef,
          egressPolicyRef: selected.profile.egressPolicyRefs[0],
          actionId,
          signal,
        },
        connection: selected.connection,
        currentConnection: () => {
          assertCurrent();
          return selected.connection;
        },
        admittedUrl: `${selected.endpoint.canonicalUrl.replace(/\/$/u, "")}/models`,
        modelId: selected.model.id,
        api: selected.endpoint.apiFamily,
        maxRequestBytes: selected.limits.maxRequestBytes,
        headersTimeoutMs: Math.min(10000, selected.limits.headersTimeoutMs),
        profileRevision: effective.profileRevision,
        credentialTarget: selected.connection.credentialRef,
        allowLocalLoopback: selected.endpoint.locality === "loopback",
      });
      const result = projectLiveModels(
        await requests.withCatalog(scope),
        selected.endpoint.apiFamily,
      );
      assertCurrent();
      succeeded = true;
      return result;
    } catch (error) {
      if (error instanceof ModelsListError) throw error;
      if (error?.code === "MODEL_CATALOG_TIMEOUT")
        fail("MODEL_CATALOG_TIMEOUT");
      if (
        [
          "POLICY_DENIED",
          "GRANT_REVOKED",
          "PROVIDER_REQUEST_DENIED",
          "STALE_OWNERSHIP",
        ].includes(error?.code)
      )
        fail("MODEL_CATALOG_DENIED");
      fail();
    } finally {
      try {
        try {
          if (runCommitted)
            store.append(
              {
                kind: "run",
                record: {
                  ...run,
                  recordId: randomUUID(),
                  createdAt: new Date().toISOString(),
                  state: succeeded ? "completed" : "failed",
                },
              },
              caller,
            );
        } finally {
          if (release && ownership)
            store.releaseWorkspace(
              input.workspaceId,
              caller.sessionId,
              ownership.epoch,
            );
        }
      } catch {
        fail();
      }
    }
  };
}
