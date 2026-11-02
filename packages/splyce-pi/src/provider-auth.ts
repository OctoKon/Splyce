// TD-16 — credential resolution port (INTERFACE-FIRST, v0).
//
// Types and invariants only; the native implementation follows. Provider
// adapters (TD-19..23) code against `CredentialResolver` and never see how a
// secret is stored, refreshed or redacted.
//
// Invariants every implementation must hold (TD-16 definition of done):
//  1. Import/discovery of a credential reference executes no helper.
//  2. A secret is resolvable only for the admitted endpoint/egress policy of the
//     provider connection; refresh cannot evade that policy.
//  3. A secret never appears in config, persistence, errors or normal artifacts;
//     it only exists inside `SecretLease.use`.
//  4. Unavailable/denied auth throws CredentialError. It NEVER selects another
//     provider, model or credential (no implicit fallback).
//  5. A command-valued helper needs its own C2 decision and a durable intent
//     BEFORE it is spawned, and an observed outcome/cleanup after.
//  6. A canceled or revoked lease cannot cache or later return late output.

export type CredentialSource =
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "credentialStore"; readonly target: string }
  | { readonly kind: "helper"; readonly commandRef: string };

export interface CredentialRequest {
  /** providerConnection.providerConnectionId and the revision the caller holds. */
  readonly providerConnectionId: string;
  readonly connectionRevision: string;
  /** Must equal the endpoint the native layer admitted for this action. */
  readonly endpointRef: string;
  readonly egressPolicyRef: string;
  /** The admitted C2 action this resolution belongs to. */
  readonly actionId: string;
  /**
   * Cancellation of the owning action. Abort before or during resolution makes
   * `resolve` reject with CREDENTIAL_REVOKED; a result that arrives after abort
   * is discarded by the resolver (never cached, never returned late), and any
   * lease already handed out is revoked.
   */
  readonly signal?: AbortSignal;
}

export const CREDENTIAL_ERROR_CODES = [
  "CREDENTIAL_UNAVAILABLE",
  "CREDENTIAL_DENIED_ENDPOINT",
  "CREDENTIAL_STALE_REVISION",
  "CREDENTIAL_HELPER_NOT_ADMITTED",
  "CREDENTIAL_REVOKED",
] as const;
export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number];

export class CredentialError extends Error {
  readonly code: CredentialErrorCode;
  constructor(
    code: CredentialErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CredentialError";
    this.code = code;
  }
}

/**
 * Scoped access to one secret. The value is only visible inside `use`.
 * A lease is bound to the request's AbortSignal: aborting it revokes the lease.
 */
export interface SecretLease {
  use<T>(consume: (secret: string) => T | Promise<T>): Promise<T>;
  /** After revoke (or cancel) `use` throws CREDENTIAL_REVOKED and nothing is cached. */
  revoke(): void;
}

export interface CredentialResolver {
  /** Resolve a lease for an admitted request; throws CredentialError, never falls back. */
  resolve(request: CredentialRequest): Promise<SecretLease>;
}

/** Replace every active secret in `text` before it reaches logs, errors or artifacts. */
export type Redactor = (text: string) => string;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]{0,40}KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}KEY-----|$)/g,
    "[REDACTED]",
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    "[REDACTED]",
  ],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, "[REDACTED]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]"],
  [
    // No `.` in the key: `token.ts: summary` is a file path, not a credential.
    /\b([A-Za-z0-9_-]{0,40}(?:key|secret|token|password|passwd|pwd)[A-Za-z0-9_-]{0,40}|(?:[A-Za-z0-9]+[_-])*pass)(\s{0,4}[:=]\s{0,4})("(?:\\[^\r\n]|[^"\\\r\n])*"?|'(?:\\[^\r\n]|[^'\\\r\n])*'?|[^\s,;&]+)/gi,
    "$1$2[REDACTED]",
  ],
];
/** Built-in redaction of common secret shapes (tokens, keys, PEM blocks, key=value credentials). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    out = out.replace(pattern, replacement);
  return out;
}
