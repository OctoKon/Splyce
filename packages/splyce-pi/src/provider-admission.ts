import type { ProviderConnectionRecord } from "./contracts.js";
import type { CredentialRequest } from "./provider-auth.js";

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
