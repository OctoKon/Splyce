// Splyce #70: actual OpenAI SDK with a fake remote service; this is adapter evidence, not native-authority proof.
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as codex } from "../src/api/openai-codex-responses.ts";
import { openAICompletionsApi } from "../src/api/openai-completions.lazy.ts";
import { stream as chat, streamSimple as simpleChat } from "../src/api/openai-completions.ts";
import { stream as responses, streamSimple as simpleResponses } from "../src/api/openai-responses.ts";
import { streamSimple as compatSimple, stream as compatStream } from "../src/compat.ts";
import { createModels, createProvider } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Api, Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] });
const key = "sk-fixture-lease-only";
afterEach(() => vi.unstubAllEnvs());
function makeModel<T extends Api>(api: T): Model<T> {
	return {
		api,
		id: "fixture-model",
		name: "Fixture",
		provider: "openai",
		baseUrl: "https://provider.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}
function leaseFixture(secret = key) {
	const state = { depth: 0, uses: 0, revoked: false };
	const credentials: SplyceCredentials = {
		lease: {
			async use(consume) {
				state.uses++;
				if (state.revoked) throw new Error("fixture lease revoked");
				state.depth++;
				try {
					return await consume(secret);
				} finally {
					state.depth--;
				}
			},
		},
		redact: (text) => text.replaceAll(secret, "[redacted]"),
	};
	return { state, credentials };
}
function payload(api: Api) {
	const event =
		api === "openai-completions"
			? { id: "chat-fixture", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }
			: {
					type: "response.completed",
					response: {
						id: "resp-fixture",
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				};
	return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
}

for (const [api, start] of [
	["openai-completions", (options: StreamOptions) => chat(makeModel("openai-completions"), context, options)],
	["openai-responses", (options: StreamOptions) => responses(makeModel("openai-responses"), context, options)],
] as const) {
	describe(`Splyce leased ${api} through the actual SDK`, () => {
		it.each([undefined, null, "invalid"])(
			"terminates malformed native redactor %s before any lease or send",
			async (redact) => {
				const { state, credentials } = leaseFixture();
				const malformed = { ...credentials, redact } as unknown as SplyceCredentials;
				let sends = 0;
				const result = await start({
					credentials: malformed,
					fetch: async () => {
						sends++;
						throw new Error("must not send");
					},
				}).result();
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain("native redact function");
				expect(state.uses).toBe(0);
				expect(sends).toBe(0);
			},
		);
		it("sends only inside the lease with the leased bearer and redirects refused", async () => {
			const { state, credentials } = leaseFixture();
			let sends = 0;
			const fetch: typeof globalThis.fetch = async (_input, init) => {
				sends++;
				expect(state.depth).toBe(1);
				expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
				expect(new Headers(init?.headers).get("x-api-key")).toBeNull();
				expect(init?.redirect).toBe("error");
				return new Response(payload(api), { headers: { "content-type": "text/event-stream" } });
			};
			const result = await start({
				credentials,
				fetch,
				maxRetries: 0,
				headers: { "x-trace": "fixture-trace" },
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(sends).toBe(1);
			expect(state.depth).toBe(0);
		});
		it("refuses a revoked lease before any HTTP send", async () => {
			const { state, credentials } = leaseFixture();
			state.revoked = true;
			let sends = 0;
			const result = await start({
				credentials,
				fetch: async () => {
					sends++;
					throw new Error("must not send");
				},
				maxRetries: 0,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(state.uses).toBeGreaterThan(0);
			expect(result.errorMessage).not.toContain(key);
			expect(sends).toBe(0);
		});
		it("rechecks the lease before a retry and sends nothing after revocation", async () => {
			const { state, credentials } = leaseFixture();
			let sends = 0;
			const result = await start({
				credentials,
				maxRetries: 1,
				fetch: async () => {
					sends++;
					expect(state.depth).toBe(1);
					state.revoked = true;
					return new Response(JSON.stringify({ error: { message: "fixture unavailable" } }), {
						status: 503,
						headers: { "content-type": "application/json", "retry-after-ms": "0" },
					});
				},
			}).result();
			expect(result.stopReason).toBe("error");
			expect(state.uses).toBeGreaterThanOrEqual(2);
			expect(sends).toBe(1);
		});
		it("rejects an explicit key combined with native credentials", async () => {
			const { state, credentials } = leaseFixture();
			const result = await start({
				credentials,
				apiKey: "other-fixture",
				fetch: async () => {
					throw new Error("must not send");
				},
				maxRetries: 0,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("mutually exclusive");
			expect(state.uses).toBe(0);
		});
		it("redacts service error text through the native redactor", async () => {
			const { credentials } = leaseFixture();
			const result = await start({
				credentials,
				fetch: async () =>
					new Response(JSON.stringify({ error: { message: `fixture error ${key}` } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					}),
				maxRetries: 0,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("[redacted]");
			expect(result.errorMessage).not.toContain(key);
		});
	});
}

describe("Splyce simplified OpenAI entrypoints", () => {
	for (const [api, start] of [
		["openai-completions", (options: StreamOptions) => simpleChat(makeModel("openai-completions"), context, options)],
		[
			"openai-responses",
			(options: StreamOptions) => simpleResponses(makeModel("openai-responses"), context, options),
		],
	] as const) {
		it(`${api} preserves the credential option`, async () => {
			const { credentials, state } = leaseFixture();
			let sends = 0;
			const result = await start({
				credentials,
				fetch: async () => {
					sends++;
					expect(state.depth).toBe(1);
					return new Response(payload(api), { headers: { "content-type": "text/event-stream" } });
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(sends).toBe(1);
		});
	}
});

it("keeps ChatGPT sign-in request semantics without returning the leased token", async () => {
	const { credentials } = leaseFixture("fixture-oauth-access-token");
	let sent: Record<string, unknown> | undefined;
	const result = await responses({ ...makeModel("openai-responses"), baseUrl: "https://api.openai.com/v1" }, context, {
		credentials,
		maxTokens: 128,
		cacheRetention: "long",
		onPayload: (body) => {
			sent = body as Record<string, unknown>;
		},
		fetch: async () =>
			new Response(payload("openai-responses"), { headers: { "content-type": "text/event-stream" } }),
	}).result();
	expect(result.stopReason).toBe("stop");
	expect(sent).toBeDefined();
	expect(sent?.max_output_tokens).toBeUndefined();
	expect(sent?.prompt_cache_retention).toBeUndefined();
});

describe("Splyce OpenAI public call paths", () => {
	for (const api of ["openai-completions", "openai-responses"] as const) {
		for (const entrypoint of ["compat stream", "compat simple", "Models stream", "Models simple"] as const) {
			it(`${api} ${entrypoint} preserves native credentials and the admitted endpoint`, async () => {
				vi.stubEnv("OPENAI_API_KEY", "fixture-ambient-key");
				const { state, credentials } = leaseFixture();
				let sends = 0;
				const options = {
					credentials,
					maxRetries: 0,
					fetch: async (input, init) => {
						sends++;
						expect(String(input)).toMatch(/^https:\/\/provider\.invalid\/v1\//);
						expect(state.depth).toBe(1);
						expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
						return new Response(payload(api), { headers: { "content-type": "text/event-stream" } });
					},
				} satisfies StreamOptions;
				const models = createModels({
					authContext: {
						env: async () => {
							throw new Error("ambient auth must not be resolved");
						},
						fileExists: async () => false,
					},
				});
				const selected = makeModel(api);
				models.setProvider(
					api === "openai-responses"
						? openaiProvider()
						: createProvider({
								id: "openai",
								name: "Fixture OpenAI-compatible",
								baseUrl: selected.baseUrl,
								auth: openaiProvider().auth,
								models: [selected],
								api: openAICompletionsApi(),
							}),
				);
				const raw = { messages: [{ role: "user" as const, content: "fixture", timestamp: 0 }] };
				const stream =
					entrypoint === "compat stream"
						? compatStream(selected, raw, options)
						: entrypoint === "compat simple"
							? compatSimple(selected, raw, options)
							: entrypoint === "Models stream"
								? models.stream(selected, raw, options)
								: models.streamSimple(selected, raw, options);
				const result = await stream.result();
				expect(result.stopReason, result.errorMessage).toBe("stop");
				expect(sends).toBe(1);
			});
		}
	}
});

it("rejects conflicting native and explicit Codex credentials before any effect", async () => {
	const { credentials, state } = leaseFixture();
	let sends = 0;
	const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.fixture`;
	const result = await codex(makeModel("openai-codex-responses"), context, {
		credentials,
		apiKey: token,
		transport: "sse",
		fetch: async () => {
			sends++;
			throw new Error("must not send");
		},
	}).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("mutually exclusive");
	expect(state.uses).toBe(0);
	expect(sends).toBe(0);
});

// #70: the shared header contract must also reject auth carried by model configuration.
for (const [api, start] of [
	[
		"openai-completions",
		(options: StreamOptions, headers: Record<string, string>) =>
			chat({ ...makeModel("openai-completions"), headers }, context, options),
	],
	[
		"openai-responses",
		(options: StreamOptions, headers: Record<string, string>) =>
			responses({ ...makeModel("openai-responses"), headers }, context, options),
	],
	[
		"openai-codex-responses",
		(options: StreamOptions, headers: Record<string, string>) =>
			codex({ ...makeModel("openai-codex-responses"), headers }, context, options),
	],
] as const) {
	for (const source of ["options", "model"] as const) {
		it.each(["Authorization", "Proxy-Authorization", "X-Api-Key", "api-key", "X-Goog-Api-Key", "Cookie"])(
			`${api} rejects ${source} auth header %s before any lease or send`,
			async (name) => {
				const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.fixture`;
				const { credentials, state } = leaseFixture(token);
				let sends = 0;
				const headers = { [name]: "caller-override" };
				const result = await start(
					{
						credentials,
						transport: "sse",
						maxRetries: 0,
						headers: source === "options" ? headers : {},
						fetch: async () => {
							sends++;
							return new Response(payload(api), { headers: { "content-type": "text/event-stream" } });
						},
					},
					source === "model" ? headers : {},
				).result();
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/caller-supplied.*header/);
				expect(state.uses).toBe(0);
				expect(sends).toBe(0);
			},
		);
	}
}
