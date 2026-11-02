import type { ProviderAdmissionPort } from "@splyce/pi/provider-admission";
import type { ProviderConnectionRecord } from "../packages/splyce-pi/src/contracts.js";
import type { CredentialRequest } from "../packages/splyce-pi/src/provider-auth.js";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type AdmissionInput = Assert<
  Equal<
    Parameters<ProviderAdmissionPort["admit"]>,
    [connection: ProviderConnectionRecord, endpointRef: string]
  >
>;
type AdmissionOutput = Assert<
  Equal<ReturnType<ProviderAdmissionPort["admit"]>, Promise<CredentialRequest>>
>;
