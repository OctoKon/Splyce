import { describe, expect, it } from "vitest";
import {
  configuredProfileResult,
  profileSelectPayload,
  sessionStartPayload,
  setupErrorCopy,
  validateProfileSelectionResult,
  validateSessionStartResult,
} from "./profiles";

const profile = {
  profileId: "profile-1",
  profileRevision: "p1",
  configRevision: "c1",
};
const selection = {
  selectedProfileId: "profile-1",
  profileRevision: "p1",
  configRevision: "c1",
};
const session = {
  sessionId: "session-1",
  sessionRevision: "s1",
  policyRevision: "7",
  readiness: { state: "ready" },
};

describe("setup contracts", () => {
  it("builds exact payloads and projects configure metadata", () => {
    expect(configuredProfileResult({ ...profile, secret: "private" })).toEqual(
      profile,
    );
    expect(profileSelectPayload(profile, "workspace", "request")).toEqual({
      requestId: "request",
      workspaceId: "workspace",
      profileId: "profile-1",
      expectedProfileRevision: "p1",
      expectedConfigRevision: "c1",
    });
    expect(sessionStartPayload(selection, "workspace", "request")).toEqual({
      requestId: "request",
      workspaceId: "workspace",
      profileId: "profile-1",
      expectedConfigRevision: "c1",
    });
  });

  it("copies valid responses including optional readiness code", () => {
    expect(validateProfileSelectionResult(selection)).toEqual(selection);
    expect(validateSessionStartResult(session)).toEqual(session);
    expect(
      validateSessionStartResult({
        ...session,
        readiness: { state: "unavailable", code: "offline" },
      }),
    ).toEqual({
      ...session,
      readiness: { state: "unavailable", code: "offline" },
    });
    expect(validateSessionStartResult(session)).not.toBe(session);
  });

  it("rejects missing, extra and malformed fields", () => {
    for (const [value, validate] of [
      [selection, validateProfileSelectionResult],
      [session, validateSessionStartResult],
    ] as const) {
      for (const key of Object.keys(value)) {
        const missing = { ...value } as Record<string, unknown>;
        delete missing[key];
        expect(() => validate(missing)).toThrow();
        expect(() => validate({ ...value, [key]: null })).toThrow();
      }
      expect(() => validate({ ...value, extra: "private" })).toThrow();
      for (const invalid of [null, [], "text", 1])
        expect(() => validate(invalid)).toThrow();
    }
    for (const policyRevision of ["", "01", "-1", "1.0", " 1", "1".repeat(129)])
      expect(() =>
        validateSessionStartResult({ ...session, policyRevision }),
      ).toThrow();
    for (const readiness of [
      {},
      { state: "unknown" },
      { state: "ready", code: undefined },
      { state: "ready", extra: "private" },
      null,
    ])
      expect(() =>
        validateSessionStartResult({ ...session, readiness }),
      ).toThrow();
    for (const invalid of ["", "a b", "a/b", "a\\b", "a\n", "..", 1]) {
      for (const key of Object.keys(profile))
        expect(() =>
          configuredProfileResult({ ...profile, [key]: invalid }),
        ).toThrow();
      expect(() =>
        validateProfileSelectionResult({
          ...selection,
          selectedProfileId: invalid,
        }),
      ).toThrow();
      expect(() =>
        validateSessionStartResult({
          ...session,
          readiness: { state: "ready", code: invalid },
        }),
      ).toThrow();
    }
    expect(() =>
      configuredProfileResult({ ...profile, configRevision: undefined }),
    ).toThrow();
    expect(() => configuredProfileResult(Object.create(profile))).toThrow();
  });

  it("uses only known own error codes and never echoes native text", () => {
    const fallback = setupErrorCopy({ code: "other", message: "private" });
    for (const code of [
      "STALE_REVISION",
      "SETUP_REQUEST_CONFLICT",
      "WORKSPACE_SUPERSEDED",
    ])
      expect(setupErrorCopy({ code })).not.toBe(fallback);
    expect(setupErrorCopy(Object.create({ code: "STALE_REVISION" }))).toBe(
      fallback,
    );
    expect(setupErrorCopy({ code: "toString", message: "private" })).toBe(
      fallback,
    );
    expect(setupErrorCopy(null)).toBe(fallback);
    expect(fallback).not.toContain("private");
  });
});
