import type {
  NativeProviderRequest,
  NativeProviderRequestPort,
  NativeProviderScope,
  ProviderAdmissionPort,
} from "@splyce/pi/provider-admission";
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

type NativeFetch = Assert<
  Equal<NativeProviderRequest["fetch"], typeof globalThis.fetch>
>;
type ExplicitTransport = Assert<
  Equal<NativeProviderRequest["transport"], "sse">
>;
type ExplicitRetry = Assert<Equal<NativeProviderRequest["maxRetries"], 0>>;

declare const nativePort: NativeProviderRequestPort;
declare const nativeScope: NativeProviderScope;
const result: Promise<number> = nativePort.withRequest(
  nativeScope,
  async (request) => request.redact("public diagnostic").length,
);
// @ts-expect-error A connection descriptor is not a native request identity.
nativePort.withRequest({}, async () => 0);
// @ts-expect-error A live stream cannot be returned synchronously from the lease.
nativePort.withRequest(nativeScope, () => new ReadableStream());
void result;
