import type { ProviderConnectionRecord } from "@splyce/pi/contracts";

export interface ConfiguredProfile {
  readonly profileId: string;
  readonly profileRevision: string;
  readonly configRevision: string;
}

export interface ProfileSelectionResult {
  readonly selectedProfileId: string;
  readonly profileRevision: string;
  readonly configRevision: string;
}

export interface SessionStartResult {
  readonly sessionId: string;
  readonly sessionRevision: string;
  readonly readiness: {
    readonly state: "ready" | "unavailable";
    readonly code?: string;
  };
}

function setupRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid setup response");
  return value as Record<string, unknown>;
}

function setupFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" || ![...required, ...optional].includes(key),
    )
  )
    throw new Error("Invalid setup response");
}

function setupOpaque(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    /[\s\\/\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new Error("Invalid setup response");
  return value;
}

export function configuredProfileResult(raw: unknown): ConfiguredProfile {
  const value = setupRecord(raw);
  if (
    !["profileId", "profileRevision", "configRevision"].every((key) =>
      Object.hasOwn(value, key),
    )
  )
    throw new Error("Invalid setup response");
  return {
    profileId: setupOpaque(value.profileId),
    profileRevision: setupOpaque(value.profileRevision),
    configRevision: setupOpaque(value.configRevision),
  };
}

export function validateProfileSelectionResult(
  raw: unknown,
): ProfileSelectionResult {
  const value = setupRecord(raw);
  setupFields(value, [
    "selectedProfileId",
    "profileRevision",
    "configRevision",
  ]);
  return {
    selectedProfileId: setupOpaque(value.selectedProfileId),
    profileRevision: setupOpaque(value.profileRevision),
    configRevision: setupOpaque(value.configRevision),
  };
}

export function validateSessionStartResult(raw: unknown): SessionStartResult {
  const value = setupRecord(raw);
  setupFields(value, ["sessionId", "sessionRevision", "readiness"]);
  const readiness = setupRecord(value.readiness);
  setupFields(readiness, ["state"], ["code"]);
  if (readiness.state !== "ready" && readiness.state !== "unavailable")
    throw new Error("Invalid setup response");
  return {
    sessionId: setupOpaque(value.sessionId),
    sessionRevision: setupOpaque(value.sessionRevision),
    readiness: {
      state: readiness.state,
      ...(Object.hasOwn(readiness, "code")
        ? { code: setupOpaque(readiness.code) }
        : {}),
    },
  };
}

export function profileSelectPayload(
  profile: ConfiguredProfile,
  workspaceId: string,
  requestId: string,
) {
  return {
    requestId,
    workspaceId,
    profileId: profile.profileId,
    expectedProfileRevision: profile.profileRevision,
    expectedConfigRevision: profile.configRevision,
  };
}

export function sessionStartPayload(
  selection: ProfileSelectionResult,
  workspaceId: string,
  requestId: string,
) {
  return {
    requestId,
    workspaceId,
    profileId: selection.selectedProfileId,
    expectedConfigRevision: selection.configRevision,
  };
}
