// Reviewed by the lead (Syed's nit): the strict-tools fallback diagnostic stores the provider's error text and persists on
// a SUCCESSFUL response, so it must be redacted inside the lease. Real SDK HTTP error parsing; only fetch is replaced.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { type AnthropicOptions, stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SECRET = "fallback-secret-0123456789";
const model: Model<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://anthropic.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 100,
	compat: { supportsStrictTools: true },
};
const preferred: Tool = {
	name: "preferred",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
	constrainedSampling: { type: "json_schema", strict: "prefer" },
};
const success = () =>
	new Response(
		[
			{ type: "message_start", message: { id: "m", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]
			.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
const failure = () =>
	Response.json(
		{ type: "error", error: { type: "invalid_request_error", message: `Too many strict tools (32). key ${SECRET}` } },
		{ status: 400 },
	);
const run = async (credentials: SplyceCredentials) => {
	let attempt = 0;
	const fetch: NonNullable<AnthropicOptions["fetch"]> = async () => (++attempt === 1 ? failure() : success());
	const s = streamAnthropic(
		model,
		normalizeContext({ tools: [preferred], messages: [{ role: "user", content: "hi", timestamp: 1 }] }),
		{
			fetch,
			maxRetries: 0,
			credentials,
		},
	);
	return s.result();
};

describe("Anthropic strict-tools fallback diagnostic under native credentials", () => {
	it("redacts the provider text stored in the diagnostic of a successful response", async () => {
		const result = await run({
			lease: { use: async (consume) => consume(SECRET) },
			redact: (t) => t.split(SECRET).join("[REDACTED]"),
		});
		expect(result.stopReason).toBe("stop");
		const text = JSON.stringify(result);
		expect(text).toContain("anthropic_strict_tools_fallback");
		expect(text).not.toContain(SECRET);
		expect(text).toContain("[REDACTED]");
	});

	it("never keeps raw provider text when the redactor only knows the secret inside the lease and the lease is gone", async () => {
		let uses = 0;
		let inside = false;
		const result = await run({
			lease: {
				use: async (consume) => {
					uses += 1;
					if (uses > 2) throw new Error("revoked");
					inside = true;
					try {
						return await consume(SECRET);
					} finally {
						inside = false;
					}
				},
			},
			redact: (t) => (inside ? t.split(SECRET).join("[REDACTED]") : t),
		});
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});
});
