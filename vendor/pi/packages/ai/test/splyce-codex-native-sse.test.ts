// Splyce #70: actual Codex SSE parser and native resolver; only the remote service is replaced.
// Adapter/public caller evidence only: native final-send authority remains a separate gate.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CredentialBinding,
	NativeCredentialResolver,
} from "../../../../../packages/splyce-pi/src/credential-resolver.ts";
import { type OpenAICodexResponsesOptions, stream, streamSimple } from "../src/api/openai-codex-responses.ts";
import { streamSimple as compatSimple, stream as compatStream } from "../src/compat.ts";
import { createModels } from "../src/models.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const TOKEN = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.fixture`;
const rawContext = { messages: [{ role: "user" as const, content: "fixture", timestamp: 0 }] };
const context = normalizeContext(rawContext);
const model: Model<"openai-codex-responses"> = {
	api: "openai-codex-responses",
	id: "fixture-model",
	name: "Fixture",
	provider: "openai-codex",
	baseUrl: "https://provider.invalid/backend-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const binding: CredentialBinding = {
	providerConnectionId: "fixture-codex",
	connectionRevision: "v1",
	endpointRef: "fixture-endpoint",
	egressPolicyRef: "fixture-egress",
	source: { kind: "env", name: "FIXTURE_CODEX_KEY" },
};
async function native(secret = TOKEN) {
	const resolver = new NativeCredentialResolver({ env: { FIXTURE_CODEX_KEY: secret } });
	resolver.register(binding);
	const lease = await resolver.resolve({
		providerConnectionId: binding.providerConnectionId,
		connectionRevision: binding.connectionRevision,
		endpointRef: binding.endpointRef,
		egressPolicyRef: binding.egressPolicyRef,
		actionId: "fixture-action",
	});
	const state = { uses: 0, redactions: 0 };
	const credentials = {
		lease: {
			use: <T>(consume: (secret: string) => T | Promise<T>) => {
				state.uses++;
				return lease.use(consume);
			},
		},
		redact: (text: string) => {
			state.redactions++;
			return resolver.redact(text);
		},
	} satisfies SplyceCredentials;
	return { resolver, lease, credentials, state };
}
function sse(event: Record<string, unknown>) {
	return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const completed = () =>
	sse({
		type: "response.completed",
		response: {
			id: "fixture-response",
			status: "completed",
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		},
	});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

const publicEntrypoints = ["compat stream", "compat simple", "Models stream", "Models simple"] as const;
function publicStream(entrypoint: (typeof publicEntrypoints)[number], options: SimpleStreamOptions) {
	if (entrypoint === "compat stream") return compatStream(model, rawContext, { ...options });
	if (entrypoint === "compat simple") return compatSimple(model, rawContext, options);
	const models = createModels({
		authContext: {
			env: async () => {
				throw new Error("ambient auth must not be resolved");
			},
			fileExists: async () => false,
		},
	});
	models.setProvider(openaiCodexProvider());
	return entrypoint === "Models stream"
		? models.stream(model, rawContext, options)
		: models.streamSimple(model, rawContext, options);
}

// #70: exercise the real exported call paths, provider factory, parser and native lease together.
describe("public native Codex SSE", () => {
	for (const entrypoint of publicEntrypoints) {
		it(`${entrypoint} uses explicit SSE with the leased bearer and admitted endpoint`, async () => {
			vi.stubEnv("OPENAI_API_KEY", "fixture-ambient-key-must-not-be-used");
			const { credentials } = await native();
			let sends = 0;
			const result = await publicStream(entrypoint, {
				credentials,
				transport: "sse",
				maxRetries: 0,
				fetch: async (input, init) => {
					sends++;
					expect(String(input)).toBe("https://provider.invalid/backend-api/codex/responses");
					expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
					expect(init?.redirect).toBe("error");
					return completed();
				},
			}).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(sends).toBe(1);
		});
		it.each([undefined, "auto", "websocket", "websocket-cached"] as const)(
			`${entrypoint} refuses native transport %s without HTTP or socket effects`,
			async (transport) => {
				const { credentials, state } = await native();
				let effects = 0;
				let payloads = 0;
				vi.stubGlobal(
					"WebSocket",
					class {
						constructor() {
							effects++;
							throw new Error("must not connect");
						}
					},
				);
				const result = await publicStream(entrypoint, {
					credentials,
					transport,
					onPayload: () => {
						payloads++;
					},
					fetch: async () => {
						effects++;
						return completed();
					},
				}).result();
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/explicit SSE/i);
				expect(state).toEqual({ uses: 0, redactions: 0 });
				expect(payloads).toBe(0);
				expect(effects).toBe(0);
			},
		);
		it(`${entrypoint} rechecks connection revision after its payload hook`, async () => {
			const { resolver, credentials } = await native();
			let payloads = 0;
			let sends = 0;
			const result = await publicStream(entrypoint, {
				credentials,
				transport: "sse",
				maxRetries: 0,
				onPayload: () => {
					payloads++;
					resolver.register({ ...binding, connectionRevision: "v2" });
				},
				fetch: async () => {
					sends++;
					return completed();
				},
			}).result();
			expect(payloads).toBe(1);
			expect(sends).toBe(0);
			expect(result.stopReason).toBe("error");
		});
		it(`${entrypoint} sanitizes structured observer data through the native lease`, async () => {
			const { credentials } = await native();
			const observed: unknown[] = [];
			const result = await publicStream(entrypoint, {
				credentials,
				transport: "sse",
				maxRetries: 0,
				onProviderStreamEvent: (event) => {
					observed.push(event);
				},
				fetch: async () =>
					sse({ type: "error", message: `fixture error ${TOKEN}`, diagnostic: { [TOKEN]: [TOKEN] } }),
			}).result();
			expect(result.stopReason).toBe("error");
			expect(observed).toHaveLength(1);
			expect(observed[0]).toEqual({
				type: "error",
				message: "fixture error [REDACTED]",
				diagnostic: { "[REDACTED]": ["[REDACTED]"] },
			});
			expect(JSON.stringify(result)).not.toContain(TOKEN);
		});
	}
});

describe("direct native Codex SSE", () => {
	it.each([false, true])("protects response observer headers (revoked=%s)", async (revoked) => {
		const { lease, credentials } = await native();
		const observed: unknown[] = [];
		const result = await stream(model, context, {
			credentials,
			transport: "sse",
			maxRetries: 0,
			onResponse: (response) => {
				observed.push(response);
			},
			fetch: async () => {
				const response = completed();
				response.headers.set("x-fixture-secret", TOKEN);
				if (revoked) lease.revoke();
				return response;
			},
		}).result();
		expect(JSON.stringify(observed)).not.toContain(TOKEN);
		if (revoked) {
			expect(observed).toHaveLength(0);
			expect(result.stopReason).toBe("error");
		} else {
			expect(observed).toHaveLength(1);
			expect(observed[0]).toMatchObject({ status: 200, headers: { "x-fixture-secret": "[REDACTED]" } });
			expect(result.stopReason).toBe("stop");
		}
	});
	// #70: a payload callback cannot replace the native transport after its preflight check.
	it.each([undefined, "auto", "websocket", "websocket-cached"] as const)(
		"keeps native SSE when the payload hook mutates transport to %s",
		async (transport) => {
			const { credentials } = await native();
			let sockets = 0;
			let sends = 0;
			vi.stubGlobal(
				"WebSocket",
				class {
					constructor() {
						sockets++;
						throw new Error("fixture socket must not be constructed");
					}
				},
			);
			const options: OpenAICodexResponsesOptions = {
				credentials,
				transport: "sse",
				maxRetries: 0,
				onPayload: () => {
					options.transport = transport;
				},
				fetch: async () => {
					sends++;
					return completed();
				},
			};
			const result = await stream(model, context, options).result();
			expect(sockets).toBe(0);
			expect(sends).toBe(1);
			expect(result.stopReason, result.errorMessage).toBe("stop");
		},
	);
	for (const [name, start] of [
		["stream", stream],
		["streamSimple", streamSimple],
	] as const) {
		it(`${name} sends the leased bearer through explicit SSE with redirects refused`, async () => {
			const { credentials } = await native();
			let sends = 0;
			const options = {
				credentials,
				transport: "sse",
				maxRetries: 0,
				headers: { "x-trace": "fixture-trace" },
				fetch: async (input, init) => {
					sends++;
					expect(String(input)).toBe("https://provider.invalid/backend-api/codex/responses");
					const headers = new Headers(init?.headers);
					expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
					expect(headers.get("x-api-key")).toBeNull();
					expect(headers.get("chatgpt-account-id")).toBe("fixture-account");
					expect(init?.redirect).toBe("error");
					return completed();
				},
			} satisfies OpenAICodexResponsesOptions;
			const result = await start(model, context, options).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(sends).toBe(1);
		});
	}
	// #70: a fixed transport refusal must not touch even a revoked native credential.
	describe.each([false, true])("native lease revoked=%s", (revoked) => {
		it.each([undefined, "auto", "websocket", "websocket-cached"] as const)(
			"refuses native transport %s before credential, payload or transport effects",
			async (transport) => {
				const { credentials, lease, state } = await native();
				if (revoked) lease.revoke();
				let effects = 0;
				let payloads = 0;
				vi.stubGlobal(
					"WebSocket",
					class {
						constructor() {
							effects++;
							throw new Error("must not connect");
						}
					},
				);
				const result = await stream(model, context, {
					credentials,
					transport,
					onPayload: () => {
						payloads++;
					},
					fetch: async () => {
						effects++;
						return completed();
					},
				}).result();
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toMatch(/explicit SSE/i);
				expect(state).toEqual({ uses: 0, redactions: 0 });
				expect(payloads).toBe(0);
				expect(effects).toBe(0);
			},
		);
	});
	it("rechecks connection revision after payload hooks and sends nothing stale", async () => {
		const { resolver, credentials } = await native();
		let payloads = 0;
		let sends = 0;
		const result = await stream(model, context, {
			credentials,
			transport: "sse",
			maxRetries: 0,
			onPayload: () => {
				payloads++;
				resolver.register({ ...binding, connectionRevision: "v2" });
			},
			fetch: async () => {
				sends++;
				return completed();
			},
		}).result();
		expect(payloads).toBe(1);
		expect(sends).toBe(0);
		expect(result.stopReason).toBe("error");
	});
	it("a revoked lease before dispatch never sends", async () => {
		const { lease, credentials } = await native();
		lease.revoke();
		let sends = 0;
		const result = await stream(model, context, {
			credentials,
			transport: "sse",
			fetch: async () => {
				sends++;
				return completed();
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(sends).toBe(0);
	});
	it("rechecks the lease before a retry rather than reusing the first bearer", async () => {
		const { lease, credentials } = await native();
		let sends = 0;
		const result = await stream(model, context, {
			credentials,
			transport: "sse",
			maxRetries: 1,
			fetch: async () => {
				sends++;
				lease.revoke();
				return new Response("fixture unavailable", { status: 503, headers: { "retry-after-ms": "0" } });
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(sends).toBe(1);
	});
	it.each([false, true])(
		"redacts a provider error from terminal output and event observers (revoked=%s)",
		async (revoked) => {
			const { lease, credentials } = await native();
			let sends = 0;
			const observed: unknown[] = [];
			const result = await stream(model, context, {
				credentials,
				transport: "sse",
				maxRetries: 0,
				onProviderStreamEvent: (event) => {
					observed.push(event);
				},
				fetch: async () => {
					sends++;
					const body = new ReadableStream<Uint8Array>(
						{
							pull(controller) {
								if (revoked) lease.revoke();
								controller.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({ type: "error", code: "fixture_error", message: `fixture error ${TOKEN}` })}\n\n`,
									),
								);
								controller.close();
							},
						},
						{ highWaterMark: 0 },
					);
					return new Response(body, { headers: { "content-type": "text/event-stream" } });
				},
			}).result();
			expect(sends).toBe(1);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBeTruthy();
			expect(JSON.stringify(result)).not.toContain(TOKEN);
			expect(JSON.stringify(observed)).not.toContain(TOKEN);
			if (!revoked) expect(observed).toHaveLength(1);
		},
	);
	it("redacts observer keys and values before JSON escaping can hide secret bytes", async () => {
		const secret = TOKEN.replace("fixture.", 'fixture"\\.');
		const { credentials } = await native(secret);
		const observed: unknown[] = [];
		const result = await stream(model, context, {
			credentials,
			transport: "sse",
			maxRetries: 0,
			onProviderStreamEvent: (event) => {
				observed.push(event);
			},
			fetch: async () =>
				sse({
					type: "error",
					message: `fixture error ${secret}`,
					metadata: { [secret]: [secret, { nested: secret }] },
				}),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(observed).toHaveLength(1);
		const event = observed[0] as { message: string; metadata: Record<string, unknown> };
		expect(event.message).toBe("fixture error [REDACTED]");
		expect(event.metadata).toEqual({ "[REDACTED]": ["[REDACTED]", { nested: "[REDACTED]" }] });
		expect(result.errorMessage).not.toContain(secret);
		expect(result.errorMessage).not.toContain(JSON.stringify(secret).slice(1, -1));
	});
});
