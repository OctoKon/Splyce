// Splyce #70: actual credential resolver + actual OpenAI SDK. Only the remote service is a fixture.
// These cases do not qualify native egress admission, receipts or the packaged app.
import { describe, expect, it } from "vitest";
import {
	type CredentialBinding,
	NativeCredentialResolver,
} from "../../../../../packages/splyce-pi/src/credential-resolver.ts";
import { stream as chat } from "../src/api/openai-completions.ts";
import { stream as responses } from "../src/api/openai-responses.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Api, Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SECRET = "sk-synthetic-native-resolver-fixture";
const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] });
function model<T extends Api>(api: T): Model<T> {
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
const binding: CredentialBinding = {
	providerConnectionId: "fixture-connection",
	connectionRevision: "v1",
	endpointRef: "fixture-endpoint",
	egressPolicyRef: "fixture-policy",
	source: { kind: "env", name: "FIXTURE_KEY" },
};
async function nativeCredentials() {
	const resolver = new NativeCredentialResolver({ env: { FIXTURE_KEY: SECRET } });
	resolver.register(binding);
	const lease = await resolver.resolve({
		providerConnectionId: binding.providerConnectionId,
		connectionRevision: binding.connectionRevision,
		endpointRef: binding.endpointRef,
		egressPolicyRef: binding.egressPolicyRef,
		actionId: "fixture-action",
	});
	return { resolver, lease, credentials: { lease, redact: resolver.redact } satisfies SplyceCredentials };
}
function successfulResponse(api: Api) {
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
	return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

for (const [api, start] of [
	["openai-completions", (options: StreamOptions) => chat(model("openai-completions"), context, options)],
	["openai-responses", (options: StreamOptions) => responses(model("openai-responses"), context, options)],
] as const) {
	describe(`${api} with the real native resolver`, () => {
		// #70: response metadata is an observer boundary just like parsed stream events.
		it.each([false, true])("protects response observer headers (revoked=%s)", async (revoked) => {
			const { lease, credentials } = await nativeCredentials();
			const observed: unknown[] = [];
			const result = await start({
				credentials,
				maxRetries: 0,
				onResponse: (response) => {
					observed.push(response);
				},
				fetch: async () => {
					const response = successfulResponse(api);
					response.headers.set("x-fixture-secret", SECRET);
					if (revoked) lease.revoke();
					return response;
				},
			}).result();
			expect(JSON.stringify(observed)).not.toContain(SECRET);
			if (revoked) {
				expect(observed).toHaveLength(0);
				expect(result.stopReason).toBe("error");
			} else {
				expect(observed).toHaveLength(1);
				expect(observed[0]).toMatchObject({ status: 200, headers: { "x-fixture-secret": "[REDACTED]" } });
				expect(result.stopReason).toBe("stop");
			}
		});
		it("sends nothing when the connection revision changes after the lease was issued", async () => {
			const { resolver, credentials } = await nativeCredentials();
			resolver.register({ ...binding, connectionRevision: "v2" });
			let sends = 0;
			const result = await start({
				credentials,
				maxRetries: 0,
				fetch: async () => {
					sends++;
					return successfulResponse(api);
				},
			}).result();
			expect(sends).toBe(0);
			expect(result.stopReason).toBe("error");
		});
		it("does not expose a revoked credential in a late stream error", async () => {
			const { lease, credentials } = await nativeCredentials();
			let sends = 0;
			const observed: unknown[] = [];
			const result = await start({
				credentials,
				maxRetries: 0,
				onProviderStreamEvent: (event) => {
					observed.push(event);
				},
				fetch: async () => {
					sends++;
					const body = new ReadableStream<Uint8Array>(
						{
							pull(controller) {
								lease.revoke();
								const error = { message: `fixture failure ${SECRET}`, code: "fixture_error" };
								const event = api === "openai-completions" ? { error } : { type: "error", ...error };
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
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
			expect(result.errorMessage).not.toContain(SECRET);
			expect(JSON.stringify(observed)).not.toContain(SECRET);
		});
		it("does not expose credential bytes to an error-event observer", async () => {
			const { credentials } = await nativeCredentials();
			const observed: unknown[] = [];
			const error = { message: `fixture failure ${SECRET}`, code: "fixture_error" };
			const event = api === "openai-completions" ? { error } : { type: "error", ...error };
			const result = await start({
				credentials,
				maxRetries: 0,
				onProviderStreamEvent: (value) => {
					observed.push(value);
				},
				fetch: async () =>
					new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).not.toContain(SECRET);
			expect(JSON.stringify(observed)).not.toContain(SECRET);
		});
		it.each([false, true])(
			"protects successful event metadata at the observer boundary (revoked=%s)",
			async (revoked) => {
				const { lease, credentials } = await nativeCredentials();
				const observed: unknown[] = [];
				const result = await start({
					credentials,
					maxRetries: 0,
					onProviderStreamEvent: (event) => {
						observed.push(event);
					},
					fetch: async () => {
						const text = await successfulResponse(api).text();
						const event = JSON.parse(text.split("\n")[0]!.slice(6)) as Record<string, unknown>;
						const body = new ReadableStream<Uint8Array>(
							{
								pull(controller) {
									if (revoked) lease.revoke();
									controller.enqueue(
										new TextEncoder().encode(
											`data: ${JSON.stringify({ ...event, diagnostic: { [SECRET]: [SECRET] } })}\n\n`,
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
				expect(JSON.stringify(observed)).not.toContain(SECRET);
				if (revoked) {
					expect(observed).toHaveLength(0);
					expect(result.stopReason).toBe("error");
				} else {
					expect(observed).toHaveLength(1);
					expect(observed[0]).toMatchObject({ diagnostic: { "[REDACTED]": ["[REDACTED]"] } });
					expect(result.stopReason).toBe("stop");
				}
			},
		);
	});
}
