import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalEndpointUrl,
  originView,
  CONTRACT_VERSION,
  PI_REVISION,
  TRANSPORT_LIMITS,
} from "../dist/contracts.js";
import { INITIAL_CONFIG_REVISION } from "../dist/store.js";
import { validateSetupMetadata } from "../dist/setup-metadata.js";
import { lookupPinnedModel } from "./model-catalog.mjs";

const fields = [
  "requestId",
  "workspaceId",
  "providerConnectionId",
  "profileId",
  "apiFamily",
  "endpoint",
  "locality",
  "chat",
  "accountScopeRef",
  "expectedConnectionRevision",
  "expectedProfileRevision",
  "expectedEndpointRevision",
  "credentialKind",
];
const exact = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const opaque = (value) =>
  typeof value === "string" &&
  value.isWellFormed() &&
  Buffer.byteLength(value) <= 128 &&
  value.length > 0 &&
  !/[\s\p{Cc}\p{Cf}/\\]/u.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fail(code = "SETUP_INVALID") {
  throw Object.assign(new Error("Provider setup unavailable"), { code });
}
function nextRevision(value, prefix) {
  if (value === null) return `${prefix}1`;
  if (
    typeof value !== "string" ||
    !new RegExp(`^${prefix}[1-9][0-9]*$`, "u").test(value)
  )
    fail();
  const number = Number(value.slice(1));
  if (!Number.isSafeInteger(number) || number >= Number.MAX_SAFE_INTEGER)
    fail();
  return `${prefix}${number + 1}`;
}

function setupChat(chat) {
  const keys = [
    "modelId",
    ...(Object.hasOwn(chat ?? {}, "model") ? ["model"] : []),
  ];
  if (
    !exact(chat, keys) ||
    typeof chat.modelId !== "string" ||
    !chat.modelId.isWellFormed() ||
    !chat.modelId.length ||
    chat.modelId.length > 256 ||
    /[\s\p{Cc}\p{Cf}]/u.test(chat.modelId)
  )
    fail();
  if (!Object.hasOwn(chat, "model")) return { modelId: chat.modelId };
  const model = chat.model;
  const modelKeys = [
    "contextWindow",
    "maxOutputTokens",
    ...(Object.hasOwn(model ?? {}, "reasoning") ? ["reasoning"] : []),
    ...(Object.hasOwn(model ?? {}, "input") ? ["input"] : []),
  ];
  if (
    !exact(model, modelKeys) ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow <= 0 ||
    model.contextWindow > 2 ** 21 ||
    !Number.isSafeInteger(model.maxOutputTokens) ||
    model.maxOutputTokens <= 0 ||
    model.maxOutputTokens > 2 ** 20 ||
    model.maxOutputTokens > model.contextWindow ||
    (Object.hasOwn(model, "reasoning") &&
      typeof model.reasoning !== "boolean") ||
    (Object.hasOwn(model, "input") &&
      (!Array.isArray(model.input) ||
        !model.input.length ||
        model.input.some((type) => type !== "text" && type !== "image") ||
        new Set(model.input).size !== model.input.length))
  )
    fail();
  return {
    modelId: chat.modelId,
    model: {
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: model.reasoning ?? false,
      input: model.input ? [...model.input] : ["text"],
    },
  };
}

// Only nonsecret metadata reaches this private native-parent entrypoint.
export function validateProviderSetup(input) {
  if (
    !exact(input, fields) ||
    !["requestId", "workspaceId", "providerConnectionId", "profileId"].every(
      (key) => opaque(input[key]),
    ) ||
    !["openai-completions", "openai-responses"].includes(input.apiFamily) ||
    !["new", "keep"].includes(input.credentialKind) ||
    input.accountScopeRef !== "provider-default"
  )
    fail();
  try {
    if (canonicalEndpointUrl(input.endpoint, input.locality) !== input.endpoint)
      fail();
  } catch {
    fail();
  }
  nextRevision(input.expectedConnectionRevision, "c");
  nextRevision(input.expectedProfileRevision, "p");
  nextRevision(input.expectedEndpointRevision, "r");
  if (
    input.credentialKind === "keep" &&
    input.expectedConnectionRevision === null
  )
    fail();
  return Object.fromEntries(
    fields.map((key) => [
      key,
      key === "chat" ? setupChat(input.chat) : input[key],
    ]),
  );
}

export function createNativeProviderSetup(store, directory) {
  const caller = {
    sessionId: "native-provider-setup",
    configRevision: INITIAL_CONFIG_REVISION,
    profileRevision: INITIAL_CONFIG_REVISION,
    policyRevision: INITIAL_CONFIG_REVISION,
  };
  const descriptorDirectory = join(directory, "setup-descriptors");
  function selectedModel(metadata) {
    if (metadata.chat.model)
      return { source: "user", ...metadata.chat.model, costKnown: false };
    const known = lookupPinnedModel({
      apiFamily: metadata.apiFamily,
      endpoint: metadata.endpoint,
      modelId: metadata.chat.modelId,
    });
    if (!known) fail("SETUP_MODEL_METADATA_REQUIRED");
    const { contextWindow, maxOutputTokens, reasoning, input } =
      known.descriptor;
    setupChat({
      modelId: metadata.chat.modelId,
      model: { contextWindow, maxOutputTokens, reasoning, input },
    });
    return known.descriptor;
  }
  function trustedCatalog(metadata) {
    const endpoint = canonicalEndpointUrl(metadata.endpoint, metadata.locality);
    const selectedApi = metadata.apiFamily;
    const selectedId = metadata.chat.modelId;
    return (apiFamily, modelId) => {
      if (apiFamily !== selectedApi || modelId !== selectedId) return undefined;
      const known = lookupPinnedModel({ apiFamily, endpoint, modelId });
      if (!known) return undefined;
      const { source: _source, ...entry } = known.descriptor;
      return entry;
    };
  }
  function descriptors(metadata) {
    const scopeId = metadata.workspaceId;
    const definitions = [
      [
        "provider-default",
        { kind: "provider-account", accountScope: "provider-default" },
      ],
      [
        null,
        {
          kind: "provider-transport-limits",
          transport: "sse",
          maxRetries: 0,
          redirects: "denied",
          maxEncodedFrameBytes: TRANSPORT_LIMITS.maxEncodedFrameBytes,
          maxRequestBytes: 4_194_304,
          headersTimeoutMs: 10_000,
          maxSseEventBytes: 1_048_576,
        },
      ],
      [
        null,
        {
          kind: "provider-egress",
          origin: originView({ canonicalUrl: metadata.endpoint }),
          requiresNativeGrant: true,
          grants: [],
        },
      ],
      [
        "request:" + hash(metadata.requestId),
        {
          kind: "provider-setup-request",
          metadata,
          modelDescriptor: selectedModel(metadata),
        },
      ],
    ];
    return definitions.map(([alias, definition]) => {
      const bytes = JSON.stringify({
        schemaVersion: 1,
        scopeId,
        ...definition,
      });
      const digest = hash(bytes);
      const artifactId =
        alias === "provider-default"
          ? alias
          : `native-setup:${alias ?? digest}`;
      const recordId = "native-descriptor:" + hash(`${scopeId}\0${artifactId}`);
      return {
        bytes,
        digest,
        artifactId,
        recordId,
        path: join(descriptorDirectory, hash(recordId) + ".json"),
      };
    });
  }
  function observe(metadata) {
    if (
      typeof store.readSetupState !== "function" ||
      typeof store.commitSetup !== "function"
    )
      fail("SETUP_UNAVAILABLE");
    const observation = store.readSetupState(metadata.workspaceId);
    const deleted = new Set(observation.deletedRecordIds);
    const rows = observation.records.filter(
      ({ record }) => !deleted.has(record.recordId),
    );
    if (observation.workspace?.workspaceId !== metadata.workspaceId)
      fail("SETUP_WORKSPACE_UNAVAILABLE");
    return { rows, observation };
  }
  function latest(observation, kind, idKey, entityId) {
    const current = observation.records.findLast(
      ({ kind: rowKind, record }) =>
        rowKind === kind && record[idKey] === entityId,
    )?.record;
    if (current && observation.deletedRecordIds.includes(current.recordId))
      fail("SETUP_STALE_REVISION");
    return current;
  }
  function verifyDescriptor(descriptor, metadata, rows) {
    const records = rows.filter(
      ({ kind, record }) =>
        kind === "artifact" && record.recordId === descriptor.recordId,
    );
    if (records.length !== 1) fail("SETUP_DESCRIPTOR_UNAVAILABLE");
    const record = records[0].record;
    if (
      record.scopeId !== metadata.workspaceId ||
      record.artifactId !== descriptor.artifactId ||
      record.digest !== descriptor.digest ||
      record.byteLength !== Buffer.byteLength(descriptor.bytes) ||
      record.mediaType !== "application/json" ||
      record.retentionClass !== "workspace"
    )
      fail("SETUP_REQUEST_CONFLICT");
    let actual;
    try {
      actual = readFileSync(descriptor.path, "utf8");
    } catch {
      fail("SETUP_DESCRIPTOR_UNAVAILABLE");
    }
    if (actual !== descriptor.bytes) fail("SETUP_REQUEST_CONFLICT");
    return true;
  }
  function reserveDescriptor(descriptor, metadata, rows, append = true) {
    const existing = rows.find(
      ({ record }) => record.recordId === descriptor.recordId,
    );
    if (existing) {
      verifyDescriptor(descriptor, metadata, rows);
      return existing.record;
    }
    mkdirSync(descriptorDirectory, { recursive: true });
    try {
      writeFileSync(descriptor.path, descriptor.bytes, { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") fail("SETUP_DESCRIPTOR_UNAVAILABLE");
      if (readFileSync(descriptor.path, "utf8") !== descriptor.bytes)
        fail("SETUP_REQUEST_CONFLICT");
    }
    const record = {
      schemaVersion: CONTRACT_VERSION,
      recordId: descriptor.recordId,
      scopeId: metadata.workspaceId,
      sourceIds: [],
      createdAt: new Date().toISOString(),
      artifactId: descriptor.artifactId,
      digest: descriptor.digest,
      mediaType: "application/json",
      byteLength: Buffer.byteLength(descriptor.bytes),
      retentionClass: "workspace",
    };
    if (!append) return record;
    try {
      store.append({ kind: "artifact", record }, caller);
    } catch (error) {
      const fresh = observe(metadata);
      const row = fresh.rows.find(
        ({ record }) => record.recordId === descriptor.recordId,
      );
      if (!row) throw error;
      verifyDescriptor(descriptor, metadata, fresh.rows);
    }
    return record;
  }
  function setupInput(metadata, credentialRef) {
    const [account, limits, egress] = descriptors(metadata);
    const endpointId =
      "setup-endpoint:" +
      hash(`${metadata.workspaceId}\0${metadata.providerConnectionId}`);
    const endpointRevision = nextRevision(
      metadata.expectedEndpointRevision,
      "r",
    );
    const connectionRevision = nextRevision(
      metadata.expectedConnectionRevision,
      "c",
    );
    return {
      workspaceId: metadata.workspaceId,
      requestId: metadata.requestId,
      endpoint: {
        endpointId,
        canonicalUrl: metadata.endpoint,
        apiFamily: metadata.apiFamily,
        locality: metadata.locality,
        revision: endpointRevision,
      },
      connection: {
        providerConnectionId: metadata.providerConnectionId,
        revision: connectionRevision,
        apiFamily: metadata.apiFamily,
        locality: metadata.locality === "loopback" ? "local" : "hosted",
        endpointRef: `${endpointId}@${endpointRevision}`,
        credentialRef,
      },
      profile: {
        profileId: metadata.profileId,
        profileRevision: nextRevision(metadata.expectedProfileRevision, "p"),
        bindings: [
          {
            role: "chat",
            providerConnectionId: metadata.providerConnectionId,
            connectionRevision,
            modelId: metadata.chat.modelId,
            modelDescriptor: selectedModel(metadata),
          },
        ],
      },
      descriptors: {
        accountScopeRef: account.artifactId,
        limitsArtifactId: limits.artifactId,
        apiVersion: "v1",
        adapterRevision: PI_REVISION,
        egressPolicyRefs: [egress.artifactId],
      },
      expected: {
        endpointRevision: metadata.expectedEndpointRevision,
        connectionRevision: metadata.expectedConnectionRevision,
        profileRevision: metadata.expectedProfileRevision,
      },
    };
  }
  function prior(metadata, rows, observation) {
    const ids = ["endpoint", "connection", "profile"].map(
      (kind) => `setup:${hash(metadata.requestId).slice(0, 32)}:${kind}`,
    );
    const found = ids.map((id) =>
      observation.records.find(({ record }) => record.recordId === id),
    );
    if (found.every((row) => !row)) return;
    if (found.some((row) => !row || !rows.includes(row)))
      fail("SETUP_REQUEST_CONFLICT");
    for (const descriptor of descriptors(metadata))
      verifyDescriptor(descriptor, metadata, rows);
    const [endpoint, connection, profile] = found.map(({ record }) => record);
    const wanted = setupInput(metadata, connection.credentialRef);
    const binding = wanted.profile.bindings[0];
    const { modelDescriptor, ...pinnedBinding } = binding;
    const descriptorId = `setup:${hash(metadata.requestId).slice(0, 32)}:modeldesc:chat`;
    const modelArtifact = rows.find(
      ({ kind, record }) =>
        kind === "artifact" && record.recordId === descriptorId,
    )?.record;
    const descriptorJson = JSON.stringify(modelDescriptor);
    if (
      !modelArtifact ||
      modelArtifact.artifactId !== descriptorId ||
      modelArtifact.role !== "chat" ||
      modelArtifact.modelId !== metadata.chat.modelId ||
      modelArtifact.mediaType !==
        "application/vnd.splyce.model-descriptor+json" ||
      modelArtifact.retentionClass !== "workspace" ||
      modelArtifact.digest !== `sha256:${hash(descriptorJson)}` ||
      modelArtifact.byteLength !== Buffer.byteLength(descriptorJson) ||
      JSON.stringify(modelArtifact.descriptor) !== descriptorJson ||
      !profile.sourceIds.includes(descriptorId)
    )
      fail("SETUP_DESCRIPTOR_UNAVAILABLE");
    if (
      endpoint.scopeId !== metadata.workspaceId ||
      endpoint.endpointId !== wanted.endpoint.endpointId ||
      endpoint.canonicalUrl !== metadata.endpoint ||
      endpoint.apiFamily !== metadata.apiFamily ||
      endpoint.locality !== metadata.locality ||
      endpoint.revision !== wanted.endpoint.revision ||
      connection.providerConnectionId !== metadata.providerConnectionId ||
      connection.revision !== wanted.connection.revision ||
      connection.endpointRef !== wanted.connection.endpointRef ||
      connection.apiFamily !== metadata.apiFamily ||
      connection.locality !== wanted.connection.locality ||
      connection.accountScopeRef !== wanted.descriptors.accountScopeRef ||
      connection.apiVersion !== wanted.descriptors.apiVersion ||
      connection.adapterRevision !== wanted.descriptors.adapterRevision ||
      profile.profileId !== metadata.profileId ||
      profile.profileRevision !== wanted.profile.profileRevision ||
      JSON.stringify(profile.bindings) !== JSON.stringify([pinnedBinding]) ||
      profile.limitsArtifactId !== wanted.descriptors.limitsArtifactId ||
      JSON.stringify(profile.egressPolicyRefs) !==
        JSON.stringify(wanted.descriptors.egressPolicyRefs)
    )
      fail("SETUP_REQUEST_CONFLICT");
    for (const [kind, idKey, entity, revisionKey] of [
      ["providerEndpoint", "endpointId", endpoint, "revision"],
      ["providerConnection", "providerConnectionId", connection, "revision"],
      ["profileSnapshot", "profileId", profile, "profileRevision"],
    ]) {
      const current = latest(observation, kind, idKey, entity[idKey]);
      if (current?.[revisionKey] !== entity[revisionKey])
        fail("SETUP_STALE_REVISION");
    }
    return { endpoint, connection, profile };
  }
  function view(metadata, result, observation) {
    if (!opaque(observation.configRevision)) fail("SETUP_UNAVAILABLE");
    const { contextWindow, maxOutputTokens, reasoning, input } =
      selectedModel(metadata);
    return {
      requestId: metadata.requestId,
      workspaceId: metadata.workspaceId,
      providerConnectionId: metadata.providerConnectionId,
      profileId: metadata.profileId,
      apiFamily: metadata.apiFamily,
      locality: metadata.locality,
      endpointOrigin: originView(result.endpoint),
      chat: {
        modelId: metadata.chat.modelId,
        model: { contextWindow, maxOutputTokens, reasoning, input: [...input] },
      },
      connectionRevision: result.connection.revision,
      profileRevision: result.profile.profileRevision,
      configRevision: observation.configRevision,
      endpointRevision: result.endpoint.revision,
      credentialState: "stored",
      generationReady: false,
    };
  }
  function prepare(raw) {
    const metadata = validateProviderSetup(raw);
    selectedModel(metadata);
    validateSetupMetadata(setupInput(metadata, null), {
      credentialPending: true,
      trustedCatalog: trustedCatalog(metadata),
    });
    const { rows, observation } = observe(metadata);
    const replay = prior(metadata, rows, observation);
    if (replay)
      return {
        state: "replayed",
        credentialRef: replay.connection.credentialRef,
        view: view(metadata, replay, observation),
      };
    const owned = descriptors(metadata);
    const intentId = owned[3].recordId;
    const reservationId = `setup:${hash(metadata.requestId).slice(0, 32)}:credres`;
    const hasIntent = observation.records.some(
      ({ record }) => record.recordId === intentId,
    );
    const hasReservation = observation.records.some(
      ({ record }) => record.recordId === reservationId,
    );
    if (hasIntent && !hasReservation) fail("SETUP_REQUEST_CONFLICT");
    for (const descriptor of owned) {
      if (
        observation.records.some(
          ({ record }) => record.recordId === descriptor.recordId,
        )
      )
        verifyDescriptor(descriptor, metadata, rows);
      try {
        if (readFileSync(descriptor.path, "utf8") !== descriptor.bytes)
          fail("SETUP_REQUEST_CONFLICT");
      } catch (error) {
        if (error?.code !== "ENOENT") {
          if (error?.code === "SETUP_REQUEST_CONFLICT") throw error;
          fail("SETUP_DESCRIPTOR_UNAVAILABLE");
        }
      }
    }
    const wanted = setupInput(metadata, "pending");
    for (const [kind, idKey, entityId, revisionKey, expected] of [
      [
        "providerEndpoint",
        "endpointId",
        wanted.endpoint.endpointId,
        "revision",
        metadata.expectedEndpointRevision,
      ],
      [
        "providerConnection",
        "providerConnectionId",
        metadata.providerConnectionId,
        "revision",
        metadata.expectedConnectionRevision,
      ],
      [
        "profileSnapshot",
        "profileId",
        metadata.profileId,
        "profileRevision",
        metadata.expectedProfileRevision,
      ],
    ]) {
      const current = latest(observation, kind, idKey, entityId);
      if ((current?.[revisionKey] ?? null) !== expected)
        fail("SETUP_STALE_REVISION");
    }
    const existing = latest(
      observation,
      "providerConnection",
      "providerConnectionId",
      metadata.providerConnectionId,
    );
    const credentialRef =
      metadata.credentialKind === "keep" ? existing?.credentialRef : null;
    if (metadata.credentialKind === "keep" && typeof credentialRef !== "string")
      fail("SETUP_CREDENTIAL_UNAVAILABLE");
    // The intent file can precede the atomic intent and reservation rows.
    const intent = owned[3];
    const intentRecord = reserveDescriptor(intent, metadata, rows, false);
    for (const descriptor of owned.slice(0, 3))
      reserveDescriptor(descriptor, metadata, rows);
    const fresh = observe(metadata);
    const reserved = store.reserveSetupCredential(
      setupInput(metadata, credentialRef ?? "pending"),
      {
        metadataHash: hash(
          JSON.stringify({
            metadata,
            modelDescriptor: selectedModel(metadata),
          }),
        ),
        intentId: intent.recordId,
        modelDescriptorHash: hash(JSON.stringify(selectedModel(metadata))),
        kind: metadata.credentialKind,
        credentialRef,
      },
      caller,
      fresh.observation.deletionEpoch,
      () =>
        owned
          .slice(0, 3)
          .every((descriptor) =>
            verifyDescriptor(descriptor, metadata, fresh.rows),
          ) && readFileSync(intent.path, "utf8") === intent.bytes,
      owned.slice(0, 3),
      intentRecord,
    );
    return { state: "prepared", ...reserved };
  }
  function read(raw) {
    if (
      !exact(raw, ["metadata", "credentialRef"]) ||
      typeof raw.credentialRef !== "string" ||
      !/^splyce-credential:v1:[a-f0-9]{64}$/u.test(raw.credentialRef)
    )
      fail();
    const metadata = validateProviderSetup(raw.metadata);
    const { rows, observation } = observe(metadata);
    const result = prior(metadata, rows, observation);
    if (!result || result.connection.credentialRef !== raw.credentialRef)
      fail("SETUP_OUTCOME_UNKNOWN");
    return {
      state: "committed",
      credentialRef: raw.credentialRef,
      view: view(metadata, result, observation),
    };
  }
  function commit(raw) {
    if (
      !exact(raw, ["metadata", "credentialRef"]) ||
      typeof raw.credentialRef !== "string" ||
      !/^splyce-credential:v1:[a-f0-9]{64}$/u.test(raw.credentialRef)
    )
      fail();
    const metadata = validateProviderSetup(raw.metadata);
    const prepared = prepare(metadata);
    if (prepared.credentialRef !== raw.credentialRef)
      fail("SETUP_REQUEST_CONFLICT");
    if (
      prepared.state === "replayed" &&
      prepared.credentialRef !== raw.credentialRef
    )
      fail("SETUP_REQUEST_CONFLICT");
    const checkedDescriptors = descriptors(metadata);
    const { rows, observation } = observe(metadata);
    const reservationId = `setup:${hash(metadata.requestId).slice(0, 32)}:credres`;
    const connectionId = `setup:${hash(metadata.requestId).slice(0, 32)}:connection`;
    const connection = rows.find(
      ({ record }) => record.recordId === connectionId,
    )?.record;
    const linkedReservation = connection?.sourceIds.includes(reservationId);
    const reservation =
      prepared.state === "prepared"
        ? prepared.reservation
        : linkedReservation
          ? rows.find(({ record }) => record.recordId === reservationId)?.record
          : undefined;
    if (linkedReservation && !reservation) fail("SETUP_REQUEST_CONFLICT");
    store.commitSetup(
      setupInput(metadata, raw.credentialRef),
      {
        ...caller,
        trustedCatalog: trustedCatalog(metadata),
        resolveReference: (ref, scopeId) =>
          scopeId === metadata.workspaceId &&
          (ref === raw.credentialRef ||
            checkedDescriptors.some(
              (descriptor) =>
                descriptor.artifactId === ref &&
                verifyDescriptor(descriptor, metadata, rows),
            )),
      },
      observation.deletionEpoch,
      reservation
        ? {
            recordId: reservationId,
            digest: reservation.digest,
            credentialRef: raw.credentialRef,
            metadataHash: hash(
              JSON.stringify({
                metadata,
                modelDescriptor: selectedModel(metadata),
              }),
            ),
            intentId: checkedDescriptors[3].recordId,
            modelDescriptorHash: hash(JSON.stringify(selectedModel(metadata))),
            kind: metadata.credentialKind,
          }
        : undefined,
    );
    try {
      return read(raw);
    } catch {
      fail("SETUP_OUTCOME_UNKNOWN");
    }
  }
  return Object.freeze({ prepare, commit, read });
}
