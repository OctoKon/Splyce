import { isDeepStrictEqual } from "node:util";
import { ConfigAuthority } from "../dist/config.js";
import { createProviderProfiles } from "../dist/provider-profiles.js";
import { Store } from "../dist/store.js";
import { NativeControl } from "./native-control.mjs";

function unavailable() {
  throw Object.assign(new Error("Native setup unavailable"), {
    code: "SETUP_UNAVAILABLE",
  });
}

/** Read-only native-parent projection; credential values never enter this lane. */
export function createNativeSetupReader({ store, control }) {
  if (!(store instanceof Store)) unavailable();
  const profiles = createProviderProfiles({
    store,
    config: new ConfigAuthority(store),
  });
  return async (input, signal) => {
    try {
      const workspaceId = input.workspaceId;
      const check = () => {
        if (signal?.aborted) unavailable();
      };
      const observe = () => {
        check();
        const state = store.readSetupState(workspaceId);
        if (state.workspace?.workspaceId !== workspaceId) unavailable();
        return state;
      };
      const snapshot = observe();
      const effective = profiles.effective(workspaceId, snapshot);
      if (effective && effective.configRevision !== snapshot.configRevision)
        unavailable();
      const deleted = new Set(snapshot.deletedRecordIds);
      const rows = (kind, key, id) =>
        snapshot.records.filter(
          ({ kind: actual, record }) => actual === kind && record[key] === id,
        );
      const pinned = (kind, key, id, revision) => {
        const candidates = rows(kind, key, id);
        const latest = candidates.at(-1)?.record;
        if (
          !latest ||
          latest.revision !== revision ||
          deleted.has(latest.recordId) ||
          candidates.filter(({ record }) => record.revision === revision)
            .length !== 1
        )
          unavailable();
        return latest;
      };
      // Fold before filtering tombstones: deletion of the latest never revives history.
      const latest = new Map();
      for (const { kind, record } of snapshot.records)
        if (kind === "profileSnapshot") latest.set(record.profileId, record);
      const listed = [];
      const refs = new Set();
      for (const profile of latest.values()) {
        if (deleted.has(profile.recordId)) continue;
        if (
          rows("profileSnapshot", "profileId", profile.profileId).filter(
            ({ record }) => record.profileRevision === profile.profileRevision,
          ).length !== 1 ||
          !profile.bindings?.length
        )
          unavailable();
        const credentials = new Set();
        let chat;
        for (const binding of profile.bindings) {
          // Legacy unbound snapshots stay at rest but cannot invent a display model.
          if (typeof binding.modelId !== "string") unavailable();
          const connection = pinned(
            "providerConnection",
            "providerConnectionId",
            binding.providerConnectionId,
            binding.connectionRevision,
          );
          const separator = connection.endpointRef.lastIndexOf("@");
          if (separator < 1) unavailable();
          const endpoint = pinned(
            "providerEndpoint",
            "endpointId",
            connection.endpointRef.slice(0, separator),
            connection.endpointRef.slice(separator + 1),
          );
          if (
            endpoint.apiFamily !== connection.apiFamily ||
            (endpoint.locality === "loopback"
              ? connection.locality !== "local"
              : connection.locality !== "hosted")
          )
            unavailable();
          credentials.add(connection.credentialRef);
          refs.add(connection.credentialRef);
          if (binding.role === "chat") {
            if (chat) unavailable();
            const artifact = snapshot.records.findLast(
              ({ kind, record }) =>
                kind === "artifact" &&
                !deleted.has(record.recordId) &&
                profile.sourceIds.includes(record.recordId) &&
                record.role === "chat" &&
                record.modelId === binding.modelId &&
                record.mediaType ===
                  "application/vnd.splyce.model-descriptor+json",
            );
            const descriptor = artifact?.record.descriptor;
            const model = descriptor && {
              contextWindow: descriptor.contextWindow,
              maxOutputTokens: descriptor.maxOutputTokens,
              reasoning: descriptor.reasoning,
              input: descriptor.input,
            };
            chat = {
              profileId: profile.profileId,
              profileRevision: profile.profileRevision,
              apiFamily: connection.apiFamily,
              modelId: binding.modelId,
              endpointOrigin: new URL(endpoint.canonicalUrl).origin,
              providerConnectionId: connection.providerConnectionId,
              connectionRevision: connection.revision,
              endpointRevision: endpoint.revision,
              endpoint: endpoint.canonicalUrl,
              locality: endpoint.locality,
              ...(model ? { model } : {}),
            };
          }
        }
        if (!chat) unavailable();
        listed.push({ chat, credentials });
      }
      if (
        effective &&
        !listed.some(({ chat }) => chat.profileId === effective.profileId)
      )
        unavailable();
      const statuses = new Map();
      for (const target of refs) {
        if (!(control instanceof NativeControl)) unavailable();
        check();
        const { present } = await control.credentialStatus({ target }, signal);
        check();
        if (!isDeepStrictEqual(snapshot, observe())) unavailable();
        statuses.set(target, present);
      }
      return {
        configRevision: snapshot.configRevision,
        selectedProfileId: effective?.profileId ?? null,
        profiles: listed.map(({ chat, credentials }) => ({
          ...chat,
          credential: [...credentials].every(
            (ref) => statuses.get(ref) === true,
          )
            ? "configured"
            : "missing",
        })),
      };
    } catch {
      unavailable();
    }
  };
}
