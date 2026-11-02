// TD-26 setup metadata validation: pure and Store-independent so the native
// owner can run the exact check commitSetup runs before it stores a credential.
import {
  ContractError,
  canonicalEndpointUrl,
  modelRef,
  validateProfileBindings,
} from "./contracts.js";

export class SetupMetadataError extends Error {
  readonly code = "SETUP_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "SetupMetadataError";
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** What the chat model can do; every limit is explicit, nothing is defaulted. */
export interface SetupModelDescriptor {
  source: "catalog" | "user";
  catalogVersion?: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
  costKnown: boolean;
}

/** A pinned catalog entry the native owner trusts for an exact (apiFamily, modelId). */
export type TrustedCatalogEntry = Omit<SetupModelDescriptor, "source"> & {
  catalogVersion: string;
};
export type TrustedCatalog = (
  apiFamily: string,
  modelId: string,
) => TrustedCatalogEntry | undefined;

const MAX_CONTEXT_WINDOW = 2 ** 21;
const MAX_OUTPUT_TOKENS = 2 ** 20;

export interface SetupInput {
  workspaceId: string;
  requestId: string;
  endpoint: {
    endpointId: string;
    canonicalUrl: string;
    apiFamily: string;
    locality: "loopback" | "hosted";
    revision: string;
  };
  connection: {
    providerConnectionId: string;
    revision: string;
    apiFamily: string;
    locality: "local" | "hosted";
    endpointRef: string;
    credentialRef: string;
  };
  profile: {
    profileId: string;
    profileRevision: string;
    bindings: {
      role: string;
      providerConnectionId: string;
      connectionRevision: string;
      modelId: string;
      /** Required on the chat binding, absent on every other binding. */
      modelDescriptor?: SetupModelDescriptor;
    }[];
  };
  /** Supplied by the native owner; commitSetup never invents these. */
  descriptors: {
    accountScopeRef: string;
    limitsArtifactId: string;
    apiVersion: string;
    adapterRevision: string;
    egressPolicyRefs: string[];
  };
  expected: {
    endpointRevision: string | null;
    connectionRevision: string | null;
    profileRevision: string | null;
  };
}

/** Metadata-only view: the credential slot may still be pending (null). */
export type SetupMetadata = Omit<SetupInput, "connection"> & {
  connection: Omit<SetupInput["connection"], "credentialRef"> & {
    credentialRef: string | null;
  };
};

const SETUP_API_FAMILIES: readonly string[] = [
  "openai-completions",
  "openai-responses",
];

// Same shapes the desktop error scrubber treats as secrets (apps/desktop/src/tool-view.ts).
const SETUP_SECRET =
  /(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/u;

function setupInvalid(field: string): never {
  throw new SetupMetadataError(`invalid setup input: ${field}`);
}
function setupObject(
  value: unknown,
  field: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    setupInvalid(field);
  return value as Record<string, unknown>;
}
function setupId(value: unknown, field: string, max = 128): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\s\\/\u0000-\u001f\u007f]/u.test(value)
  )
    setupInvalid(field);
  return value;
}
function setupModelRef(value: unknown, field: string): string {
  try {
    modelRef(value, field);
  } catch {
    return setupInvalid(field);
  }
  return value as string;
}
/** Opaque id that must not look like a secret (requestId). */
function setupRequestId(value: unknown): string {
  const id = setupId(value, "requestId");
  if (SETUP_SECRET.test(id)) setupInvalid("requestId");
  return id;
}
/** Short plain label (apiVersion, adapterRevision): never a place for a secret. */
function setupToken(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:-]{1,64}$/u.test(value) ||
    SETUP_SECRET.test(value)
  )
    setupInvalid(field);
  return value;
}
function setupPositiveInt(value: unknown, field: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > max
  )
    setupInvalid(field);
  return value;
}
function setupBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") setupInvalid(field);
  return value;
}
function setupModelDescriptor(
  value: unknown,
  field: string,
): SetupModelDescriptor {
  if (!isPlainObject(value)) return setupInvalid(field);
  const source = value.source;
  if (source !== "catalog" && source !== "user")
    return setupInvalid(`${field}.source`);
  const keys = [
    "source",
    "contextWindow",
    "maxOutputTokens",
    "reasoning",
    "input",
    "costKnown",
    ...(Object.hasOwn(value, "catalogVersion") ? ["catalogVersion"] : []),
  ];
  setupObject(value, field, keys);
  // Provenance: a catalog descriptor names its catalog version, a user one never does.
  if (Object.hasOwn(value, "catalogVersion") !== (source === "catalog"))
    setupInvalid(`${field}.catalogVersion`);
  // Only a trusted catalog can vouch for pricing; a user model's cost stays unknown.
  if (source === "user" && value.costKnown !== false)
    setupInvalid(`${field}.costKnown`);
  const input = value.input;
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    !input.every((item) => item === "text" || item === "image") ||
    new Set(input).size !== input.length
  )
    setupInvalid(`${field}.input`);
  const contextWindow = setupPositiveInt(
    value.contextWindow,
    `${field}.contextWindow`,
    MAX_CONTEXT_WINDOW,
  );
  const maxOutputTokens = setupPositiveInt(
    value.maxOutputTokens,
    `${field}.maxOutputTokens`,
    MAX_OUTPUT_TOKENS,
  );
  if (maxOutputTokens > contextWindow) setupInvalid(`${field}.maxOutputTokens`);
  return {
    source,
    ...(Object.hasOwn(value, "catalogVersion")
      ? {
          catalogVersion: setupId(
            value.catalogVersion,
            `${field}.catalogVersion`,
          ),
        }
      : {}),
    contextWindow,
    maxOutputTokens,
    reasoning: setupBoolean(value.reasoning, `${field}.reasoning`),
    input: [...input] as ("text" | "image")[],
    costKnown: setupBoolean(value.costKnown, `${field}.costKnown`),
  };
}
/** A catalog claim is only believed when the native catalog has exactly this entry. */
function setupCheckCatalog(
  descriptor: SetupModelDescriptor,
  apiFamily: string,
  modelId: string,
  field: string,
  trusted: TrustedCatalog | undefined,
): void {
  if (descriptor.source !== "catalog") return;
  if (trusted === undefined) setupInvalid(`${field}.source`);
  let entry: TrustedCatalogEntry | undefined;
  try {
    entry = trusted(apiFamily, modelId);
  } catch {
    entry = undefined;
  }
  const canonical = (d: TrustedCatalogEntry | SetupModelDescriptor) =>
    JSON.stringify([
      d.catalogVersion,
      d.contextWindow,
      d.maxOutputTokens,
      d.reasoning,
      d.input,
      d.costKnown,
    ]);
  if (entry === undefined || canonical(entry) !== canonical(descriptor))
    setupInvalid(field);
}
function setupRevision(value: unknown, field: string): string | null {
  return value === null ? null : setupId(value, field);
}

/**
 * Pure, side-effect-free validation of everything about a setup request that
 * does not need the Store: shape (unknown keys rejected), opaque ids, secret
 * shapes, canonical endpoint URL, api family, locality, model references and
 * binding consistency. It does NOT resolve credentialRef/descriptor refs and
 * does not touch revisions (that is Store CAS). With `credentialPending` the
 * credential slot may be absent or null, so the native owner can validate
 * before a key is stored; commitSetup uses the default (credentialRef required).
 */
export function validateSetupMetadata(
  raw: unknown,
  options?: { trustedCatalog?: TrustedCatalog },
): SetupInput;
export function validateSetupMetadata(
  raw: unknown,
  options: { credentialPending: true; trustedCatalog?: TrustedCatalog },
): SetupMetadata;
export function validateSetupMetadata(
  raw: unknown,
  options: {
    credentialPending?: boolean;
    trustedCatalog?: TrustedCatalog;
  } = {},
): SetupMetadata {
  const pending = options.credentialPending === true;
  const top = setupObject(raw, "input", [
    "workspaceId",
    "requestId",
    "endpoint",
    "connection",
    "profile",
    "descriptors",
    "expected",
  ]);
  const d = setupObject(top.descriptors, "descriptors", [
    "accountScopeRef",
    "limitsArtifactId",
    "apiVersion",
    "adapterRevision",
    "egressPolicyRefs",
  ]);
  if (!Array.isArray(d.egressPolicyRefs))
    setupInvalid("descriptors.egressPolicyRefs");
  const e = setupObject(top.endpoint, "endpoint", [
    "endpointId",
    "canonicalUrl",
    "apiFamily",
    "locality",
    "revision",
  ]);
  const connectionKeys = [
    "providerConnectionId",
    "revision",
    "apiFamily",
    "locality",
    "endpointRef",
  ];
  const slotPresent =
    isPlainObject(top.connection) &&
    Object.hasOwn(top.connection, "credentialRef");
  const c = setupObject(
    top.connection,
    "connection",
    pending && !slotPresent
      ? connectionKeys
      : [...connectionKeys, "credentialRef"],
  );
  const p = setupObject(top.profile, "profile", [
    "profileId",
    "profileRevision",
    "bindings",
  ]);
  const x = setupObject(top.expected, "expected", [
    "endpointRevision",
    "connectionRevision",
    "profileRevision",
  ]);
  const endpointId = setupId(e.endpointId, "endpoint.endpointId");
  const endpointRevision = setupId(e.revision, "endpoint.revision");
  const locality = e.locality;
  if (locality !== "loopback" && locality !== "hosted")
    setupInvalid("endpoint.locality");
  const canonicalUrl = e.canonicalUrl;
  let canonical: string;
  try {
    canonical = canonicalEndpointUrl(canonicalUrl, locality);
  } catch {
    return setupInvalid("endpoint.canonicalUrl");
  }
  if (canonical !== canonicalUrl) setupInvalid("endpoint.canonicalUrl");
  const apiFamily = setupId(e.apiFamily, "endpoint.apiFamily");
  if (!SETUP_API_FAMILIES.includes(apiFamily))
    setupInvalid("endpoint.apiFamily");
  const connectionId = setupId(
    c.providerConnectionId,
    "connection.providerConnectionId",
  );
  const connectionRevision = setupId(c.revision, "connection.revision");
  if (c.apiFamily !== apiFamily) setupInvalid("connection.apiFamily");
  if (c.locality !== (locality === "loopback" ? "local" : "hosted"))
    setupInvalid("connection.locality");
  if (c.endpointRef !== `${endpointId}@${endpointRevision}`)
    setupInvalid("connection.endpointRef");
  const credentialRef =
    pending && (c.credentialRef === undefined || c.credentialRef === null)
      ? null
      : setupId(c.credentialRef, "connection.credentialRef");
  if (!Array.isArray(p.bindings) || p.bindings.length === 0)
    setupInvalid("profile.bindings");
  const bindings = p.bindings.map((value: unknown, index: number) => {
    const isChat = isPlainObject(value) && value.role === "chat";
    if (isChat && !Object.hasOwn(value, "modelDescriptor"))
      setupInvalid("profile.bindings.modelDescriptor");
    const b = setupObject(value, `profile.bindings[${index}]`, [
      "role",
      "providerConnectionId",
      "connectionRevision",
      "modelId",
      ...(isChat ? ["modelDescriptor"] : []),
    ]);
    if (
      b.providerConnectionId !== connectionId ||
      b.connectionRevision !== connectionRevision
    )
      setupInvalid(`profile.bindings[${index}] connection`);
    const modelId = setupModelRef(
      b.modelId,
      `profile.bindings[${index}].modelId`,
    );
    const modelDescriptor = isChat
      ? setupModelDescriptor(
          b.modelDescriptor,
          `profile.bindings[${index}].modelDescriptor`,
        )
      : undefined;
    if (modelDescriptor !== undefined)
      setupCheckCatalog(
        modelDescriptor,
        apiFamily,
        modelId,
        `profile.bindings[${index}].modelDescriptor`,
        options.trustedCatalog,
      );
    return {
      role: setupId(b.role, `profile.bindings[${index}].role`),
      providerConnectionId: connectionId,
      connectionRevision,
      modelId,
      ...(modelDescriptor === undefined ? {} : { modelDescriptor }),
    };
  });
  // The profileSnapshot contract's own binding-set check (unique roles, a chat binding).
  try {
    validateProfileBindings(
      bindings.map(({ modelDescriptor: _descriptor, ...pinned }) => pinned),
    );
  } catch (error) {
    if (error instanceof ContractError) setupInvalid("profile.bindings");
    throw error;
  }
  return {
    workspaceId: setupId(top.workspaceId, "workspaceId"),
    requestId: setupRequestId(top.requestId),
    endpoint: {
      endpointId,
      canonicalUrl: canonical,
      apiFamily,
      locality,
      revision: endpointRevision,
    },
    connection: {
      providerConnectionId: connectionId,
      revision: connectionRevision,
      apiFamily,
      locality: c.locality as "local" | "hosted",
      endpointRef: c.endpointRef as string,
      credentialRef,
    },
    profile: {
      profileId: setupId(p.profileId, "profile.profileId"),
      profileRevision: setupId(p.profileRevision, "profile.profileRevision"),
      bindings,
    },
    descriptors: {
      accountScopeRef: setupId(
        d.accountScopeRef,
        "descriptors.accountScopeRef",
      ),
      limitsArtifactId: setupId(
        d.limitsArtifactId,
        "descriptors.limitsArtifactId",
      ),
      apiVersion: setupToken(d.apiVersion, "descriptors.apiVersion"),
      adapterRevision: setupToken(
        d.adapterRevision,
        "descriptors.adapterRevision",
      ),
      egressPolicyRefs: d.egressPolicyRefs.map((ref: unknown, i: number) =>
        setupId(ref, `descriptors.egressPolicyRefs[${i}]`),
      ),
    },
    expected: {
      endpointRevision: setupRevision(
        x.endpointRevision,
        "expected.endpointRevision",
      ),
      connectionRevision: setupRevision(
        x.connectionRevision,
        "expected.connectionRevision",
      ),
      profileRevision: setupRevision(
        x.profileRevision,
        "expected.profileRevision",
      ),
    },
  };
}
