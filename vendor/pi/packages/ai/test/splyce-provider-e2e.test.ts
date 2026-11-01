// TD-20 / TD-21 end to end: the real NativeCredentialResolver (TD-16) feeds the real Anthropic, Google and Vertex
// adapters through the shared `credentials` option. Only the vendor SDK boundary is replaced. The admission port is
// interface-only upstream (TD-13), so a minimal implementation lives here to exercise the same call sequence the
// native layer will make: admit -> resolve -> adapter, with one AbortSignal for the whole action.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	anthropicOpts: [] as Array<Record<string, unknown>>,
	googleOpts: [] as Array<Record<string, unknown>>,
	failWith: undefined as string | undefined,
	/** When set, the Google generator waits for it after the first chunk (to abort mid-stream). */
	pause: undefined as Promise<void> | undefined,
	started: undefined as (() => void) | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		private readonly opts: Record<string, unknown>;
		constructor(opts: Record<string, unknown>) {
			this.opts = opts;
			sdk.anthropicOpts.push(opts);
		}
		beta = {
			messages: {
				create: () => ({
					asResponse: async () => {
						const send = this.opts.fetch as typeof fetch | undefined;
						if (send)
							await send("https://api.anthropic.com/v1/messages", {
								method: "POST",
								headers: { "x-api-key": "placeholder" },
							});
						if (sdk.failWith) throw new Error(sdk.failWith);
						return new Response(
							[
								{ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
								{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
								{ type: "message_stop" },
							]
								.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n`)
								.join("\n"),
							{ status: 200, headers: { "content-type": "text/event-stream" } },
						);
					},
				}),
			},
		};
	}
	return { default: FakeAnthropic };
});

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		constructor(opts: Record<string, unknown>) {
			sdk.googleOpts.push(opts);
		}
		models = {
			generateContentStream: async function* () {
				if (sdk.failWith) throw new Error(sdk.failWith);
				yield { candidates: [{ content: { parts: [{ text: "first" }] } }] };
				sdk.started?.();
				if (sdk.pause) await sdk.pause;
				yield {
					candidates: [{ content: { parts: [{ text: " second" }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
				};
			},
		};
	}
	return {
		FinishReason: { STOP: "STOP", MAX_TOKENS: "MAX_TOKENS", OTHER: "OTHER", FINISH_REASON_UNSPECIFIED: "F" },
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY", VALIDATED: "VALIDATED" },
		GoogleGenAI,
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: { THINKING_LEVEL_UNSPECIFIED: "A", MINIMAL: "B", LOW: "C", MEDIUM: "D", HIGH: "E" },
	};
});

import type { ProviderConnectionRecord } from "@splyce/pi/contracts";
import type { ProviderAdmissionPort } from "@splyce/pi/provider-admission";
import { NativeCredentialResolver } from "../../../../../packages/splyce-pi/src/credential-resolver.ts";
import type { CredentialRequest } from "../../../../../packages/splyce-pi/src/provider-auth.ts";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SECRET = "e2e-secret-value-0123456789";
const ADMITTED = "endpoint-admitted";

const model = <TApi extends Api>(provider: string, api: TApi, baseUrl: string): Model<TApi> => ({
	id: "m-1",
	name: "m-1",
	api,
	provider,
	baseUrl,
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 8000,
});
const context = () => normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

/** Interface-only upstream; this is the smallest faithful implementation: admit only the bound endpoint. */
/** The per-action port the native layer constructs: the action's signal is bound at construction, so admit takes two arguments. */
const admission = (connectionId: string, revision: string, signal?: AbortSignal): ProviderAdmissionPort => ({
	async admit(connection, endpointRef) {
		if (connection.providerConnectionId !== connectionId || connection.revision !== revision)
			throw new Error("ADMISSION_DENIED");
		if (endpointRef !== ADMITTED) throw new Error("ADMISSION_DENIED");
		const request: CredentialRequest = {
			providerConnectionId: connectionId,
			connectionRevision: revision,
			endpointRef,
			egressPolicyRef: "egress-1",
			actionId: "action-1",
			...(signal ? { signal } : {}),
		};
		return request;
	},
});

const recorded: Array<{ headers: Headers; redirect: string | undefined }> = [];
const wireFetch = (async (_input: unknown, init?: RequestInit) => {
	recorded.push({ headers: new Headers(init?.headers), redirect: init?.redirect });
	return new Response("{}");
}) as unknown as typeof fetch;

function nativeSide(env: Record<string, string | undefined>, signal?: AbortController) {
	const resolver = new NativeCredentialResolver({ env });
	resolver.register({
		providerConnectionId: "conn-1",
		connectionRevision: "r1",
		endpointRef: ADMITTED,
		egressPolicyRef: "egress-1",
		source: { kind: "env", name: "PROVIDER_KEY" },
	});
	const admit = admission("conn-1", "r1", signal?.signal);
	return {
		resolver,
		async credentials(endpointRef = ADMITTED): Promise<SplyceCredentials> {
			const request = await admit.admit(
				{ providerConnectionId: "conn-1", revision: "r1" } as ProviderConnectionRecord,
				endpointRef,
			);
			const lease = await resolver.resolve(request);
			return { lease, redact: resolver.redact };
		},
	};
}

const families = [
	{
		name: "Anthropic Messages",
		run: (credentials: SplyceCredentials, extra: Record<string, unknown> = {}) =>
			streamAnthropic(
				model("anthropic", "anthropic-messages", "https://admitted.example") as Model<"anthropic-messages">,
				context(),
				{
					fetch: wireFetch,
					credentials,
					...extra,
				},
			).result(),
		delivered: () => recorded.map((r) => r.headers.get("x-api-key")),
		constructed: () => sdk.anthropicOpts.length,
		baseUrl: () => (sdk.anthropicOpts[0]?.baseURL as string | undefined) ?? "",
	},
	{
		name: "Google Generative AI",
		run: (credentials: SplyceCredentials, extra: Record<string, unknown> = {}) =>
			streamGoogle(
				model("google", "google-generative-ai", "https://admitted.example") as Model<"google-generative-ai">,
				context(),
				{
					credentials,
					...extra,
				},
			).result(),
		delivered: () => sdk.googleOpts.map((o) => o.apiKey),
		constructed: () => sdk.googleOpts.length,
		baseUrl: () => (sdk.googleOpts[0]?.httpOptions as { baseUrl?: string } | undefined)?.baseUrl ?? "",
	},
	{
		name: "Google Vertex",
		run: (credentials: SplyceCredentials, extra: Record<string, unknown> = {}) =>
			streamVertex(
				model("google-vertex", "google-vertex", "https://admitted.example") as Model<"google-vertex">,
				context(),
				{
					project: "p",
					location: "us-central1",
					credentials,
					...extra,
				},
			).result(),
		delivered: () => sdk.googleOpts.map((o) => o.apiKey),
		constructed: () => sdk.googleOpts.length,
		baseUrl: () => (sdk.googleOpts[0]?.httpOptions as { baseUrl?: string } | undefined)?.baseUrl ?? "",
	},
];

beforeEach(() => {
	sdk.anthropicOpts.length = 0;
	sdk.googleOpts.length = 0;
	sdk.failWith = undefined;
	sdk.pause = undefined;
	sdk.started = undefined;
	recorded.length = 0;
});

describe.each(families)("native resolver end to end: $name", (family) => {
	it("delivers the resolved secret and talks only to the admitted base URL", async () => {
		const native = nativeSide({ PROVIDER_KEY: SECRET });
		const result = await family.run(await native.credentials());
		expect(result.stopReason).not.toBe("error");
		expect(family.delivered()).toContain(SECRET);
		expect(family.baseUrl()).toBe("https://admitted.example");
	});

	it("never falls back to the process environment or an apiKey when the credential is unavailable", async () => {
		const native = nativeSide({
			PROVIDER_KEY: undefined,
			ANTHROPIC_API_KEY: "ambient",
			GEMINI_API_KEY: "ambient",
			GOOGLE_API_KEY: "ambient",
		});
		await expect(native.credentials()).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
		expect(family.constructed()).toBe(0);
	});

	it("is denied for an endpoint the connection is not admitted for", async () => {
		const native = nativeSide({ PROVIDER_KEY: SECRET });
		await expect(native.credentials("endpoint-other")).rejects.toThrow("ADMISSION_DENIED");
		expect(family.constructed()).toBe(0);
		expect(recorded).toHaveLength(0);
	});

	it("an abort before the request revokes the lease: nothing is sent", async () => {
		const abort = new AbortController();
		const native = nativeSide({ PROVIDER_KEY: SECRET }, abort);
		const credentials = await native.credentials();
		abort.abort();
		const result = await family.run(credentials, { signal: abort.signal });
		expect(["error", "aborted"]).toContain(result.stopReason);
		expect(family.delivered().filter(Boolean)).toHaveLength(0);
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("redacts the secret from provider error text with the native redactor", async () => {
		sdk.failWith = `401 invalid key ${SECRET}`;
		const native = nativeSide({ PROVIDER_KEY: SECRET });
		const result = await family.run(await native.credentials());
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toContain("[REDACTED]");
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});
});

describe("abort mid-stream", () => {
	it("Google: aborting after the first chunk ends the call as aborted and leaks nothing", async () => {
		const abort = new AbortController();
		const native = nativeSide({ PROVIDER_KEY: SECRET }, abort);
		const credentials = await native.credentials();
		let release!: () => void;
		sdk.pause = new Promise<void>((resolve) => {
			release = resolve;
		});
		const firstChunk = new Promise<void>((resolve) => {
			sdk.started = resolve;
		});
		const running = streamGoogle(
			model("google", "google-generative-ai", "https://admitted.example") as Model<"google-generative-ai">,
			context(),
			{ credentials, signal: abort.signal },
		).result();
		await firstChunk;
		abort.abort();
		release();
		const result = await running;
		expect(result.stopReason).toBe("aborted");
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("Anthropic: a lease revoked by abort stops the next send of the same call", async () => {
		const abort = new AbortController();
		const native = nativeSide({ PROVIDER_KEY: SECRET }, abort);
		const credentials = await native.credentials();
		await streamAnthropic(
			model("anthropic", "anthropic-messages", "https://admitted.example") as Model<"anthropic-messages">,
			context(),
			{
				fetch: wireFetch,
				credentials,
				signal: abort.signal,
			},
		).result();
		expect(recorded).toHaveLength(1);
		abort.abort();
		const send = sdk.anthropicOpts[0]!.fetch as typeof fetch;
		await expect(send("https://admitted.example/v1/messages", { method: "POST" })).rejects.toThrow(/revoked/i);
		expect(recorded).toHaveLength(1);
	});
});
