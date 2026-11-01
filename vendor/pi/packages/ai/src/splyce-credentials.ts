import type { ProviderResponse } from "./types.ts";

// Splyce C4: the one credential option shared by every provider adapter (TD-19..23).
// Structural mirror of the native SecretLease and Redactor (packages/splyce-pi/src/provider-auth.ts, TD-16): this
// package must not import @splyce/pi. The native layer builds the lease from ProviderAdmissionPort.admit() and
// CredentialResolver.resolve(); an adapter never sees how a secret is stored or refreshed.
//
// The secret is taken from the lease for each use, not once: every HTTP send (fetch-based adapters) or every request
// attempt (SDK adapters) calls `lease.use`, so a revoked or denied lease stops the next send, retry or attempt.
// Adapters keep no copy of any secret: redaction is the native redactor's job, and a lease without one is refused
// before anything is leased or sent.

/** A refusal decided before anything was leased or sent: its text holds no secret, so it is never lease-redacted. */
export class CredentialPreflightError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialPreflightError";
	}
}

export interface SplyceSecretLease {
	use<T>(consume: (secret: string) => T | Promise<T>): Promise<T>;
}

export interface SplyceCredentials {
	readonly lease: SplyceSecretLease;
	/** Native-owned redactor (TD-16 `Redactor`): replaces every active secret in a text before it reaches an error. */
	readonly redact: (text: string) => string;
}

// The support set and its guard live in utils/model-operations.ts, which the `./models` entry already reaches, so the
// entry-graph budget is unchanged; they are re-exported here for the adapters and the compat layer.
export { assertCredentialsSupported, CREDENTIAL_APIS } from "./utils/model-operations.ts";

const identity = (text: string): string => text;

/** The redactor to apply to error text: the native one when credentials are in use, otherwise nothing is leased. */
export function redactorOf(options: { credentials?: SplyceCredentials | undefined }): (text: string) => string {
	const redact = options.credentials?.redact;
	return typeof redact === "function" ? redact : identity;
}

/** Sanitize inside a live lease; a revoked lease cannot safely expose the provider's error text. */
export async function redactWithLease(credentials: SplyceCredentials | undefined, text: string): Promise<string> {
	if (!credentials) return text;
	// An invalid shape (never leased, or mutated after preflight) must not echo provider text: nothing could mask it.
	if (typeof credentials.redact !== "function" || typeof credentials.lease?.use !== "function") {
		return "Provider credential is no longer available";
	}
	try {
		return await credentials.lease.use(() => credentials.redact(text));
	} catch {
		return "Provider credential is no longer available";
	}
}

/** Redact JSON event keys and values inside a live lease before an observer can retain them. */
export async function redactEventWithLease(
	credentials: SplyceCredentials | undefined,
	event: unknown,
): Promise<unknown> {
	if (!credentials) return event;
	const { lease, redact } = credentials;
	return lease.use(() => {
		const sanitize = (value: unknown): unknown => {
			if (typeof value === "string") return redact(value);
			if (Array.isArray(value)) return value.map(sanitize);
			if (value && typeof value === "object") {
				return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), sanitize(item)]));
			}
			return value;
		};
		return sanitize(event);
	});
}

/** Response metadata is copied and sanitized before a callback can retain it. */
export async function redactResponseWithLease(
	credentials: SplyceCredentials | undefined,
	response: ProviderResponse,
): Promise<ProviderResponse> {
	if (!credentials) return response;
	return credentials.lease.use(() => ({
		status: response.status,
		headers: Object.fromEntries(
			Object.entries(response.headers).map(([key, value]) => [credentials.redact(key), credentials.redact(value)]),
		),
	}));
}

/** Headers that carry or select a credential. With a lease the caller may not supply any of them. */
const CALLER_AUTH_HEADERS: ReadonlySet<string> = new Set([
	"authorization",
	"proxy-authorization",
	"x-api-key",
	"api-key",
	"x-goog-api-key",
	"cookie",
]);

type HeaderSource = Record<string, string | null | undefined> | undefined;

export function assertNoCallerAuthHeaders(...sources: HeaderSource[]): void {
	for (const source of sources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (value !== null && value !== undefined && CALLER_AUTH_HEADERS.has(name.toLowerCase())) {
				throw new CredentialPreflightError(`credentials do not allow a caller-supplied ${name} header`);
			}
		}
	}
}

/**
 * `apiKey` and `credentials` are mutually exclusive, credentials need a native redactor, and neither the caller nor the
 * model configuration may add an auth header of their own (a pinned SDK may prefer it to the lease). With a lease no
 * ambient or fallback credential exists. Throws before anything is leased or sent.
 */
export function assertCredentialOptions(
	options: {
		apiKey?: string | undefined;
		credentials?: SplyceCredentials | undefined;
		headers?: HeaderSource;
	},
	modelHeaders?: HeaderSource,
): void {
	const { credentials } = options;
	if (!credentials) return;
	if (options.apiKey !== undefined)
		throw new CredentialPreflightError("apiKey and credentials are mutually exclusive");
	if (typeof credentials.redact !== "function")
		throw new CredentialPreflightError("credentials require a native redact function");
	if (typeof credentials.lease?.use !== "function")
		throw new CredentialPreflightError("credentials require a native lease.use function");
	assertNoCallerAuthHeaders(modelHeaders, options.headers);
}

/** A single-API provider must not reinterpret the API admitted with native credentials. */
export function assertCredentialApiIdentity(
	actualApi: string,
	expectedApi: string,
	options: { credentials?: SplyceCredentials | undefined } | undefined,
): void {
	if (options?.credentials && actualApi !== expectedApi) {
		throw new CredentialPreflightError("Native credential API identity does not match this adapter");
	}
}

/**
 * The Google SDK takes transport settings from the request payload. With a lease, a payload hook may not move the
 * endpoint, add headers or turn on SDK-level retries (which would reuse one lease for several sends).
 */
export function assertSafeLeasedGooglePayload(params: unknown): void {
	const http = (params as { config?: { httpOptions?: Record<string, unknown> } } | undefined)?.config?.httpOptions;
	if (!http) return;
	for (const key of ["baseUrl", "headers", "retryOptions", "apiVersion", "baseUrlResourceScope"]) {
		if (http[key] !== undefined)
			throw new CredentialPreflightError(`credentials do not allow the payload to set httpOptions.${key}`);
	}
}

/** Runs `consume` with a freshly leased secret; a denied or revoked lease throws and nothing runs. */
export async function withLeasedSecret<T>(
	credentials: SplyceCredentials,
	consume: (secret: string) => T | Promise<T>,
): Promise<T> {
	return credentials.lease.use(async (secret) => {
		if (typeof secret !== "string" || secret.length === 0) {
			throw new Error("Credential lease returned no secret");
		}
		return consume(secret);
	});
}

/**
 * A fetch that obtains the secret from the lease on every send and writes it into one auth header, so the SDK client
 * built around it never holds the real key. `format` shapes the header value (default: the raw secret; pass
 * `(s) => `Bearer ${s}`` for bearer schemes). Headers carried by a `Request` input are kept, with `init.headers`
 * taking precedence as `fetch` does. Known credential headers are dropped, and redirects are refused so the key cannot
 * follow a response to another host.
 */
export function createLeasedFetch(
	credentials: SplyceCredentials,
	header: string,
	base: typeof globalThis.fetch = globalThis.fetch,
	format: (secret: string) => string = (secret) => secret,
): typeof globalThis.fetch {
	return (input, init) =>
		withLeasedSecret(credentials, (secret) => {
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
			for (const name of CALLER_AUTH_HEADERS) headers.delete(name);
			headers.set(header, format(secret));
			return base(input, { ...init, headers, redirect: "error" });
		});
}
