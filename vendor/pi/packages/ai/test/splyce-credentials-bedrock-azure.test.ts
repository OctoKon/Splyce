// TD-22 / C4: the Bedrock and Azure adapters honour a leased credential the way the Anthropic, Google and Vertex
// bindings already do (splyce-credentials.test.ts, splyce-credentials-routing.test.ts): the gate admits their APIs,
// the secret comes from the lease per send instead of sitting in client options (Bedrock leases a fresh identity
// for each send and reuses it for that send's retries; Azure reads the lease per fetch), every ambient
// source loses to the lease, malformed leases fail closed, and no secret reaches an error message.
// The AWS SDK boundary is replaced as in bedrock-credentials.test.ts; Azure runs its real SDK against a recording fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "lease-secret-0123456789abcdef";
const LEASED_KEY_JSON = JSON.stringify({
	accessKeyId: "AKIALEASED",
	secretAccessKey: SECRET,
	sessionToken: "leased-session-token",
});

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	rejectWith: undefined as Error | undefined,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(bedrockMock.rejectWith ?? new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import type { BedrockOptions } from "../src/api/bedrock-converse-stream.ts";
import { getModel, stream, streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Context } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const leaseOf = (secret: string, onUse?: () => void): SplyceCredentials => ({
	lease: {
		use: async (consume) => {
			onUse?.();
			return consume(secret);
		},
	},
	redact: (text) => text.split(secret).join("[redacted]"),
});

type AwsKeys = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
const provider = (config: Record<string, unknown>) => config.credentials as () => Promise<AwsKeys>;

/** The Bedrock lease secret is the access-key identity as JSON; redaction targets the value inside it. */
const bedrockLease = (onUse?: () => void, json = LEASED_KEY_JSON): SplyceCredentials => ({
	lease: {
		use: async (consume) => {
			onUse?.();
			return consume(json);
		},
	},
	redact: (text) => text.split(SECRET).join("[redacted]"),
});

/** A recording fetch that answers 401 with `message` in the body, like an upstream rejecting a key. */
const record401 =
	(message: string, into: Headers[]) =>
	async (_input: unknown, init?: RequestInit): Promise<Response> => {
		into.push(new Headers(init?.headers));
		return new Response(JSON.stringify({ error: { message } }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
	};

describe("TD-22 bedrock: a lease is the only identity", () => {
	const bedrockModel = () => getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

	beforeEach(() => {
		bedrockMock.constructorCalls.length = 0;
		bedrockMock.rejectWith = undefined;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	async function captureConfig(options: BedrockOptions = {}): Promise<Record<string, unknown>> {
		bedrockMock.constructorCalls.length = 0;
		await stream(bedrockModel(), context, { cacheRetention: "none", ...options }).result();
		expect(bedrockMock.constructorCalls).toHaveLength(1);
		return bedrockMock.constructorCalls[0];
	}

	it("admits the api through compat instead of refusing the lease", async () => {
		const result = await stream(bedrockModel(), context, {
			cacheRetention: "none",
			credentials: bedrockLease(),
		}).result();
		// Reaching the (mocked) send at all proves the gate did not throw "not supported".
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("mock send");
	});

	it("leases on first use, and every send builds a client that leases again", async () => {
		let uses = 0;
		const credentials = bedrockLease(() => uses++);
		const config = await captureConfig({ credentials });
		expect(typeof config.credentials).toBe("function");
		expect(uses).toBe(0); // building the client leases nothing
		expect(await provider(config)()).toEqual({
			accessKeyId: "AKIALEASED",
			secretAccessKey: SECRET,
			sessionToken: "leased-session-token",
		});
		expect(uses).toBe(1);
		// A resolved identity with no expiration is memoized inside the client, so a retry in this send reuses
		// this lease; what makes a revoked lease fail is that the next send builds a new client to lease from.
		await stream(bedrockModel(), context, { cacheRetention: "none", credentials }).result();
		expect(bedrockMock.constructorCalls).toHaveLength(2);
		expect(uses).toBe(1); // the second client has leased nothing until it signs
		const second = bedrockMock.constructorCalls[1] as Record<string, unknown> | undefined;
		expect(second).toBeDefined();
		await provider(second ?? {})();
		expect(uses).toBe(2);
	});

	it("fails the attempt when the lease is revoked", async () => {
		const revoked: SplyceCredentials = {
			lease: {
				use: async () => {
					throw new Error("CREDENTIAL_REVOKED");
				},
			},
			redact: (text) => text,
		};
		const config = await captureConfig({ credentials: revoked });
		await expect(provider(config)()).rejects.toThrow("CREDENTIAL_REVOKED");
	});

	it("loses to no ambient source: env keys, profile, bearer token and skip-auth are ignored", async () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAAMBIENT");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
		vi.stubEnv("AWS_PROFILE", "ambient-profile");
		vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "ambient-bearer");
		vi.stubEnv("AWS_BEDROCK_SKIP_AUTH", "1");

		const config = await captureConfig({ credentials: bedrockLease() });

		expect(config.profile).toBeUndefined();
		expect(config.token).toBeUndefined();
		expect(typeof config.credentials).toBe("function");
		expect(await provider(config)()).toEqual({
			accessKeyId: "AKIALEASED",
			secretAccessKey: SECRET,
			sessionToken: "leased-session-token",
		});
		expect(JSON.stringify(config)).not.toContain("ambient-");
		expect(JSON.stringify(config)).not.toContain("AKIAAMBIENT");
	});

	it("fails closed on a malformed lease without echoing the secret", async () => {
		const truncated = `{"accessKeyId": "${SECRET}"`; // deliberately not closed JSON
		const bad = await captureConfig({ credentials: bedrockLease(undefined, truncated) });
		const jsonFailure = (await provider(bad)().catch((error: unknown) => error)) as Error;
		expect(jsonFailure.message).toBe("Bedrock credential lease is not valid JSON");
		expect(jsonFailure.message).not.toContain(SECRET);

		const partial = await captureConfig({
			credentials: bedrockLease(undefined, JSON.stringify({ accessKeyId: "AKIAONLY" })),
		});
		await expect(provider(partial)()).rejects.toThrow(
			"Bedrock credential lease has no secretAccessKey",
		);
	});

	it("redacts the leased secret from a provider failure", async () => {
		bedrockMock.rejectWith = new Error(`upstream refused key ${SECRET}`);
		const result = await stream(bedrockModel(), context, {
			cacheRetention: "none",
			credentials: bedrockLease(),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("[redacted]");
		expect(result.errorMessage).not.toContain(SECRET);
	});

	it("refuses apiKey next to a lease before a client exists", async () => {
		const result = await stream(bedrockModel(), context, {
			cacheRetention: "none",
			credentials: bedrockLease(),
			apiKey: "explicit-key",
		}).result();
		expect(result.errorMessage).toMatch(/mutually exclusive/);
		expect(bedrockMock.constructorCalls).toHaveLength(0);
	});
});

describe("TD-22 azure: a lease is the only identity", () => {
	const azureModel = () => getModel("azure", "gpt-4o-mini");

	beforeEach(() => {
		// The simple-options bridge only forwards the shared field list, so the endpoint comes from the
		// scoped env channel (the same way production configures Azure through provider env).
		vi.stubEnv("AZURE_OPENAI_BASE_URL", "https://my-resource.openai.azure.com");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("admits the api through compat instead of refusing the lease", async () => {
		const sent: Headers[] = [];
		const result = await streamSimple(azureModel(), context, {
			credentials: leaseOf(SECRET),
			fetch: record401("upstream rejected request", sent),
			maxRetries: 0,
		}).result();
		// Reaching the wire at all proves the gate did not throw "not supported".
		expect(sent).toHaveLength(1);
		expect(result.stopReason).toBe("error");
	});

	it("leases the api-key on every send: never the placeholder and never an ambient key", async () => {
		vi.stubEnv("AZURE_OPENAI_API_KEY", "ambient-azure-key");
		vi.stubEnv("OPENAI_API_KEY", "ambient-openai-key");
		const sent: Headers[] = [];

		const result = await streamSimple(azureModel(), context, {
			credentials: leaseOf(SECRET),
			fetch: record401("upstream rejected request", sent),
			maxRetries: 0,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(sent.length).toBeGreaterThan(0);
		for (const headers of sent) {
			const values = [...headers.values()].join(" ");
			expect(headers.get("api-key")).toBe(SECRET);
			expect(headers.get("x-api-key")).toBeNull();
			expect(values).not.toContain("splyce-leased-placeholder");
			expect(values).not.toContain("ambient-");
		}
	});

	it("redacts the leased secret from a provider error", async () => {
		const sent: Headers[] = [];
		const result = await streamSimple(azureModel(), context, {
			credentials: leaseOf(SECRET),
			fetch: record401(`bad key ${SECRET}`, sent),
			maxRetries: 0,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("[redacted]");
		expect(result.errorMessage).not.toContain(SECRET);
	});

	it("refuses apiKey next to a lease before anything is leased or sent", async () => {
		const sent: Headers[] = [];
		const result = await streamSimple(azureModel(), context, {
			credentials: leaseOf(SECRET),
			apiKey: "explicit-key",
			fetch: record401("must not be sent", sent),
			maxRetries: 0,
		}).result();
		expect(result.errorMessage).toMatch(/mutually exclusive/);
		expect(sent).toHaveLength(0);
	});
});