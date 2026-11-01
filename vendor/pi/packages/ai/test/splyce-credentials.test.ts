// Splyce C4: one shared `credentials` option for the provider adapters (TD-19..23).
// Real adapters; only the vendor SDK constructors are replaced, as in anthropic-auth-token.test.ts and
// google-raw-stop-reason.test.ts. Invariants follow TD-16 (credential resolution port).
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	anthropicOpts: [] as Array<Record<string, unknown>>,
	googleOpts: [] as Array<Record<string, unknown>>,
	failWith: undefined as string | undefined,
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
				create: () => {
					return {
						asResponse: async () => {
							// The real SDK sends through its configured fetch; do the same so the lease is exercised.
							const send = this.opts.fetch as typeof fetch | undefined;
							if (send)
								await send("https://api.anthropic.com/v1/messages", {
									method: "POST",
									headers: { "x-api-key": String(this.opts.apiKey) },
								});
							if (sdk.failWith) throw new Error(sdk.failWith);
							return new Response(
								[
									{
										type: "message_start",
										message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } },
									},
									{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
									{ type: "message_stop" },
								]
									.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n`)
									.join("\n"),
								{ status: 200, headers: { "content-type": "text/event-stream" } },
							);
						},
					};
				},
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
				yield {
					candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
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

import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import { assertCredentialOptions, createLeasedFetch, type SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SECRET = "sk-test-secret-0123456789";
const nativeRedact = (text: string) => text.split(SECRET).join("[redacted]");
const model = <TApi extends Api>(provider: string, api: TApi, id: string, baseUrl: string): Model<TApi> => ({
	id,
	name: id,
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
const lease = (secret = SECRET) => ({
	use: async <T>(consume: (s: string) => T | Promise<T>) => consume(secret),
});
const brokenLease = (message = "CREDENTIAL_REVOKED") => ({
	use: async <T>(_consume: (s: string) => T | Promise<T>): Promise<T> => {
		throw new Error(message);
	},
});
/** A lease that works `times` times, then behaves as revoked; counts every use. */
const expiringLease = (times: number) => {
	const state = { uses: 0 };
	return {
		state,
		use: async <T>(consume: (s: string) => T | Promise<T>): Promise<T> => {
			state.uses += 1;
			if (state.uses > times) throw new Error("CREDENTIAL_REVOKED");
			return consume(SECRET);
		},
	};
};
const seen = (list: Array<Record<string, unknown>>) => JSON.stringify(list);
const creds = (leaseOrBroken: { use: <T>(c: (s: string) => T | Promise<T>) => Promise<T> }) => ({
	lease: leaseOrBroken,
	redact: nativeRedact,
});

/** Records what actually leaves through fetch; the SDK mock sends through it like the real client. */
const wire = { sent: [] as Array<{ headers: Headers; redirect: string | undefined }> };
const recordingFetch = (async (_url: unknown, init?: RequestInit) => {
	wire.sent.push({ headers: new Headers(init?.headers), redirect: init?.redirect });
	return new Response("{}");
}) as unknown as typeof fetch;

const families = [
	{
		name: "Anthropic Messages",
		sdkCalls: () => sdk.anthropicOpts,
		baseUrl: "https://api.anthropic.com",
		/** Anthropic leases on every HTTP send, so the secret shows up on the wire, never in the client options. */
		perSend: true,
		run: (extra: Record<string, unknown>) =>
			streamAnthropic(
				model(
					"anthropic",
					"anthropic-messages",
					"claude-haiku-4-5",
					"https://api.anthropic.com",
				) as Model<"anthropic-messages">,
				context(),
				{ fetch: recordingFetch, ...extra },
			).result(),
		wrongApi: (extra: Record<string, unknown>) =>
			streamAnthropic(
				model("anthropic", "pi-messages", "claude-haiku-4-5", "https://api.anthropic.com") as never,
				context(),
				{ fetch: recordingFetch, ...extra },
			).result(),
		baseKey: (opts: Record<string, unknown>) => opts.baseURL,
		ambient: { ANTHROPIC_API_KEY: "env-secret-anthropic", ANTHROPIC_AUTH_TOKEN: "env-secret-token" },
		/** Where the real secret was delivered. */
		delivered: () => wire.sent.map((s) => s.headers.get("x-api-key")),
	},
	{
		name: "Google Generative AI",
		sdkCalls: () => sdk.googleOpts,
		baseUrl: "https://generativelanguage.example/v1beta",
		perSend: false,
		run: (extra: Record<string, unknown>) =>
			streamGoogle(
				model(
					"google",
					"google-generative-ai",
					"gemini-3-flash-preview",
					"https://generativelanguage.example/v1beta",
				) as Model<"google-generative-ai">,
				context(),
				extra,
			).result(),
		wrongApi: (extra: Record<string, unknown>) =>
			streamGoogle(
				model(
					"google",
					"pi-messages",
					"gemini-3-flash-preview",
					"https://generativelanguage.example/v1beta",
				) as never,
				context(),
				extra,
			).result(),
		baseKey: (opts: Record<string, unknown>) => (opts.httpOptions as { baseUrl?: string } | undefined)?.baseUrl,
		ambient: { GEMINI_API_KEY: "env-secret-gemini", GOOGLE_API_KEY: "env-secret-google" },
		delivered: () => sdk.googleOpts.map((o) => o.apiKey),
	},
	{
		name: "Google Vertex",
		sdkCalls: () => sdk.googleOpts,
		baseUrl: "https://vertex.example",
		perSend: false,
		run: (extra: Record<string, unknown>) =>
			streamVertex(
				model(
					"google-vertex",
					"google-vertex",
					"gemini-3-flash-preview",
					"https://vertex.example",
				) as Model<"google-vertex">,
				context(),
				{ project: "p", location: "us-central1", ...extra },
			).result(),
		wrongApi: (extra: Record<string, unknown>) =>
			streamVertex(
				model("google-vertex", "pi-messages", "gemini-3-flash-preview", "https://vertex.example") as never,
				context(),
				{ project: "p", location: "us-central1", ...extra },
			).result(),
		baseKey: (opts: Record<string, unknown>) => (opts.httpOptions as { baseUrl?: string } | undefined)?.baseUrl,
		ambient: { GOOGLE_API_KEY: "env-secret-vertex", GOOGLE_CLOUD_API_KEY: "env-secret-vertex2" },
		delivered: () => sdk.googleOpts.map((o) => o.apiKey),
	},
];

beforeEach(() => {
	sdk.anthropicOpts.length = 0;
	sdk.googleOpts.length = 0;
	sdk.failWith = undefined;
	wire.sent.length = 0;
});

describe.each(families)("credentials option: $name", (family) => {
	// #70/#73: malformed leases must fail before SDK construction or payload callbacks.
	it.each([undefined, null, {}, { use: null }, { use: "not-a-function" }])(
		"refuses malformed lease %j before SDK initialization",
		async (invalidLease) => {
			let payloads = 0;
			const result = await family.run({
				credentials: { lease: invalidLease, redact: nativeRedact },
				onPayload: () => {
					payloads++;
				},
			});
			expect(result.stopReason).toBe("error");
			expect(family.sdkCalls()).toHaveLength(0);
			expect(wire.sent).toHaveLength(0);
			expect(payloads).toBe(0);
		},
	);
	it("delivers the leased secret and the admitted base URL", async () => {
		const result = await family.run({ credentials: creds(lease()) });
		expect(result.stopReason).not.toBe("error");
		expect(family.delivered()).toContain(SECRET);
		expect(family.baseKey(family.sdkCalls()[0]!)).toBe(family.baseUrl);
	});

	it("never stores the secret in client options when a lease is used", async () => {
		await family.run({ credentials: creds(lease()) });
		if (family.perSend) expect(seen(family.sdkCalls())).not.toContain(SECRET);
		expect(seen(family.sdkCalls())).not.toContain("env-secret");
	});

	it("rejects apiKey together with credentials before anything is sent", async () => {
		const result = await family.run({ apiKey: "other-key", credentials: creds(lease()) });
		expect(result.stopReason).toBe("error");
		expect(family.sdkCalls()).toHaveLength(0);
		expect(wire.sent).toHaveLength(0);
		expect(result.errorMessage ?? "").not.toContain(SECRET);
		expect(result.errorMessage ?? "").not.toContain("other-key");
	});

	it("fails closed on a revoked lease: nothing delivered, no env fallback", async () => {
		const result = await family.run({ credentials: creds(brokenLease()), env: family.ambient });
		expect(result.stopReason).toBe("error");
		expect(family.delivered().filter(Boolean)).toHaveLength(0);
		expect(wire.sent).toHaveLength(0);
		expect(seen(family.sdkCalls())).not.toContain("env-secret");
	});

	it("does not use ambient env keys when a lease is supplied", async () => {
		await family.run({ credentials: creds(lease()), env: family.ambient });
		expect(family.delivered()).toContain(SECRET);
		expect(JSON.stringify(family.delivered())).not.toContain("env-secret");
		expect(seen(family.sdkCalls())).not.toContain("env-secret");
	});

	it("redacts the secret from provider error text", async () => {
		sdk.failWith = `401 invalid x-api-key ${SECRET}`;
		const result = await family.run({ credentials: creds(lease()) });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").not.toContain(SECRET);
		expect(result.errorMessage ?? "").toContain("[redacted]");
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("uses the native-owned redactor when one is supplied", async () => {
		sdk.failWith = `401 invalid x-api-key ${SECRET}`;
		const result = await family.run({
			credentials: { lease: lease(), redact: (text: string) => text.split(SECRET).join("[native]") },
		});
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toContain("[native]");
		expect(result.errorMessage ?? "").not.toContain("[redacted]");
		expect(result.errorMessage ?? "").not.toContain(SECRET);
	});

	it("never calls a lease-scoped redactor outside the lease: a revoked lease gives generic error text", async () => {
		sdk.failWith = `401 invalid x-api-key ${SECRET}`;
		const base = expiringLease(1);
		let inside = false;
		const scoped = {
			use: async <T>(consume: (secret: string) => T | Promise<T>) => {
				return base.use(async (secret: string) => {
					inside = true;
					try {
						return await consume(secret);
					} finally {
						inside = false;
					}
				});
			},
		};
		const result = await family.run({
			credentials: {
				lease: scoped,
				redact: (text: string) => (inside ? text.split(SECRET).join("[native]") : text),
			},
		});
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("asks the lease again for every use instead of keeping the first answer", async () => {
		const counted = expiringLease(100);
		await family.run({ credentials: creds(counted) });
		expect(counted.state.uses).toBeGreaterThanOrEqual(1);
		expect(counted.state.uses).toBe(family.delivered().filter(Boolean).length);
	});

	it("refuses credentials without a native redact function before anything is leased", async () => {
		const counted = expiringLease(100);
		const result = await family.run({ credentials: { lease: counted } as never });
		expect(result.stopReason).toBe("error");
		expect(counted.state.uses).toBe(0);
		expect(family.sdkCalls()).toHaveLength(0);
		expect(wire.sent).toHaveLength(0);
	});

	it("refuses a model of another API with native credentials before any lease, SDK or send", async () => {
		const counted = expiringLease(100);
		const result = await family.wrongApi({ credentials: creds(counted) });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toContain("API identity");
		expect(counted.state.uses).toBe(0);
		expect(family.sdkCalls()).toHaveLength(0);
		expect(wire.sent).toHaveLength(0);
	});

	it("keeps the legacy apiKey path unchanged when no lease is given", async () => {
		const result = await family.run({ apiKey: "legacy-key" });
		expect(result.stopReason).not.toBe("error");
		expect(seen(family.sdkCalls())).toContain("legacy-key");
	});
});

describe("Anthropic per-send enforcement", () => {
	const send = async (): Promise<unknown> => {
		const opts = sdk.anthropicOpts[0]!;
		return (opts.fetch as typeof fetch)("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: { "x-api-key": "placeholder", authorization: "Bearer other" },
		});
	};
	const start = (credentialLease: { use: <T>(c: (s: string) => T | Promise<T>) => Promise<T> }) =>
		streamAnthropic(
			model(
				"anthropic",
				"anthropic-messages",
				"claude-haiku-4-5",
				"https://api.anthropic.com",
			) as Model<"anthropic-messages">,
			context(),
			{ fetch: recordingFetch, credentials: creds(credentialLease) },
		).result();

	it("a lease revoked after the first send stops every later send or SDK retry", async () => {
		await start(expiringLease(1));
		expect(wire.sent).toHaveLength(1);
		await expect(send()).rejects.toThrow("CREDENTIAL_REVOKED");
		expect(wire.sent).toHaveLength(1);
	});

	it("replaces the placeholder and any other auth header with the leased secret", async () => {
		await start(lease());
		await send();
		const last = wire.sent.at(-1)!;
		expect(last.headers.get("x-api-key")).toBe(SECRET);
		expect(last.headers.get("authorization")).toBeNull();
	});

	it("refuses redirects so the key cannot follow a response to another host", async () => {
		await start(lease());
		await send();
		expect(wire.sent.every((s) => s.redirect === "error")).toBe(true);
	});
});

describe("shared credential helpers", () => {
	it.each([undefined, null, {}, { use: null }, { use: "not-a-function" }])(
		"requires a callable native lease before accepting credential options (%j)",
		(invalidLease) => {
			const credentials = { lease: invalidLease, redact: nativeRedact } as unknown as SplyceCredentials;
			expect(() => assertCredentialOptions({ credentials })).toThrow(
				"credentials require a native lease.use function",
			);
		},
	);
	const record = () => {
		const calls: Array<{ input: unknown; headers: Headers; redirect: string | undefined }> = [];
		const base = (async (input: unknown, init?: RequestInit) => {
			calls.push({ input, headers: new Headers(init?.headers), redirect: init?.redirect });
			return new Response("{}");
		}) as unknown as typeof fetch;
		return { calls, base };
	};

	it("keeps the headers of a Request input and lets init.headers take precedence", async () => {
		const { calls, base } = record();
		const leased = createLeasedFetch(creds(lease()), "x-api-key", base);
		const request = new Request("https://api.example/v1", {
			method: "POST",
			headers: { "content-type": "application/json", "x-trace": "from-request", authorization: "Bearer other" },
			body: "{}",
		});
		await leased(request, { headers: { "x-trace": "from-init" } });
		const sent = calls[0]!.headers;
		expect(sent.get("content-type")).toBe("application/json");
		expect(sent.get("x-trace")).toBe("from-init");
		expect(sent.get("x-api-key")).toBe(SECRET);
		expect(sent.get("authorization")).toBeNull();
	});

	it("writes a bearer scheme through format and drops a caller-supplied x-api-key", async () => {
		const { calls, base } = record();
		const leased = createLeasedFetch(creds(lease()), "authorization", base, (secret) => `Bearer ${secret}`);
		await leased("https://api.example/v1", { headers: { "x-api-key": "caller-key" } });
		expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
		expect(calls[0]!.headers.get("x-api-key")).toBeNull();
		expect(calls[0]!.redirect).toBe("error");
	});
});

describe("fixed pre-send refusals never lease or run the native redactor", () => {
	const counted = () => {
		let uses = 0;
		let redactions = 0;
		return {
			state: () => ({ uses, redactions }),
			credentials: {
				lease: {
					use: async <T>(consume: (s: string) => T | Promise<T>) => {
						uses += 1;
						return consume(SECRET);
					},
				},
				redact: (text: string) => {
					redactions += 1;
					return nativeRedact(text);
				},
			} as SplyceCredentials,
		};
	};
	const cases: Array<[string, (extra: Record<string, unknown>) => Promise<{ stopReason: string }>]> = [
		[
			"Anthropic caller-supplied client",
			(extra) =>
				streamAnthropic(
					model(
						"anthropic",
						"anthropic-messages",
						"claude-haiku-4-5",
						"https://api.anthropic.com",
					) as Model<"anthropic-messages">,
					context(),
					{ client: {} as never, ...extra },
				).result(),
		],
		[
			"Anthropic github-copilot provider",
			(extra) =>
				streamAnthropic(
					model(
						"github-copilot",
						"anthropic-messages",
						"claude-haiku-4-5",
						"https://api.anthropic.com",
					) as Model<"anthropic-messages">,
					context(),
					extra,
				).result(),
		],
		[
			"Google custom fetch",
			(extra) =>
				streamGoogle(
					model(
						"google",
						"google-generative-ai",
						"gemini-3-flash-preview",
						"https://generativelanguage.example/v1beta",
					) as Model<"google-generative-ai">,
					context(),
					{ fetch: (async () => new Response("{}")) as unknown as typeof fetch, ...extra },
				).result(),
		],
		[
			"Vertex custom fetch",
			(extra) =>
				streamVertex(
					model(
						"google-vertex",
						"google-vertex",
						"gemini-3-flash-preview",
						"https://vertex.example",
					) as Model<"google-vertex">,
					context(),
					{
						project: "p",
						location: "us-central1",
						fetch: (async () => new Response("{}")) as unknown as typeof fetch,
						...extra,
					},
				).result(),
		],
	];
	it.each(cases)("%s: error, zero lease uses, zero redactor calls, zero SDK calls", async (_name, run) => {
		const c = counted();
		const result = await run({ credentials: c.credentials });
		expect(result.stopReason).toBe("error");
		expect(c.state()).toEqual({ uses: 0, redactions: 0 });
		expect(sdk.anthropicOpts).toHaveLength(0);
		expect(sdk.googleOpts).toHaveLength(0);
	});
});
