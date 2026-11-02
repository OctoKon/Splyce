import type { ProviderConnectionRecord } from "./contracts.js";
import type { CredentialRequest, Redactor } from "./provider-auth.js";

/**
 * Interface only: the native owner binds the selected role, profile, action and
 * current grants when constructing this port. Connection descriptors confer no
 * authority. Admission rejects without implicit provider or credential fallback.
 *
 * Credential resolution must recheck the admitted request; each actual transport
 * must perform final checks before every send, redirect, retry or WebSocket send.
 * This descriptor is not a reusable authorization to transmit data.
 */
export interface ProviderAdmissionPort {
  admit(
    connection: ProviderConnectionRecord,
    endpointRef: string,
  ): Promise<CredentialRequest>;
}

declare const nativeProviderScope: unique symbol;

/** Native-created identity; implementations must also verify their private registry. */
export interface NativeProviderScope {
  readonly [nativeProviderScope]: true;
}

/** Lease-scoped values, valid only until the consuming operation and cleanup settle. */
export interface NativeProviderRequest {
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  readonly signal: AbortSignal;
  readonly redact: Redactor;
  readonly transport: "sse";
  readonly maxRetries: 0;
}

/**
 * The native owner supplies final-send authority, never a descriptor-derived grant.
 * Scope binds current session/revisions/workspace epoch, role, connection, actual
 * endpoint/egress and cancellation. Fetch checks each physical send, commits its
 * correlated intent before handoff and rejects redirects. Unsupported transports
 * remain denied. The callback must await stream completion and error cleanup;
 * returning a live lazy stream would let work escape the credential lease.
 * Interface only: no provider path becomes available by importing this port.
 */
export interface NativeProviderRequestPort {
  withRequest<T>(
    scope: NativeProviderScope,
    consume: (request: NativeProviderRequest) => Promise<T>,
  ): Promise<T>;
}
