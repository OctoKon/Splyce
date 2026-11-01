// A leased credential must reach the adapter intact through every public entrypoint (compat stream/streamSimple,
// the Models layer, buildBaseOptions) and must never be mixed with ambient or stored auth. An API whose adapter does
// not support leases must refuse them instead of silently ignoring the option (which would fall back to an env key).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	opts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@anthropic-ai/sdk", () => {
	class FakeAnthropic {
		private readonly opts: Record<string, unknown>;
		constructor(opts: Record<string, unknown>) {
			this.opts = opts;
			sdk.opts.push(opts);
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

import { buildBaseOptions } from "../src/api/simple-options.ts";
import { getModel, stream, streamSimple } from "../src/compat.ts";
import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Context } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SECRET = "routing-secret-0123456789";
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const transcript = normalizeContext(context);
const credentials: SplyceCredentials = {
	lease: { use: async (consume) => consume(SECRET) },
	redact: (text) => text.split(SECRET).join("[redacted]"),
};
const wire: Array<Headers> = [];
const wireFetch = (async (_input: unknown, init?: RequestInit) => {
	wire.push(new Headers(init?.headers));
	return new Response("{}");
}) as unknown as typeof fetch;
const model = () => getModel("anthropic", "claude-haiku-4-5");
const ctor = () => sdk.opts[0] ?? {};
const unexpectedFetch = vi.fn(async () => {
	throw new Error("routing fixture must never contact a provider");
});

beforeEach(() => {
	sdk.opts.length = 0;
	wire.length = 0;
	unexpectedFetch.mockClear();
	vi.stubGlobal("fetch", unexpectedFetch);
	vi.stubEnv("ANTHROPIC_API_KEY", "ambient-env-key");
	vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-env-token");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("credentials through the public entrypoints", () => {
	it("compat.streamSimple delivers the lease and no ambient env key", async () => {
		const result = await streamSimple(model(), context, { credentials, fetch: wireFetch }).result();
		expect(result.stopReason).not.toBe("error");
		expect(wire.at(-1)?.get("x-api-key")).toBe(SECRET);
		expect(JSON.stringify(ctor())).not.toContain("ambient-env");
	});

	it("compat.stream delivers the lease and no ambient env key", async () => {
		const result = await stream(model(), context, { credentials, fetch: wireFetch }).result();
		expect(result.stopReason).not.toBe("error");
		expect(wire.at(-1)?.get("x-api-key")).toBe(SECRET);
		expect(JSON.stringify(ctor())).not.toContain("ambient-env");
	});

	it("the Models layer ignores stored and ambient auth entirely when a lease is given", async () => {
		const models = createModels({
			authContext: {
				env: async (name) =>
					name === "ANTHROPIC_AUTH_TOKEN" ? "ctx-token" : name === "ANTHROPIC_API_KEY" ? "ctx-key" : undefined,
				fileExists: async () => false,
			},
		});
		models.setProvider(anthropicProvider());
		const result = await models.streamSimple(model(), context, { credentials, fetch: wireFetch }).result();
		expect(result.stopReason).not.toBe("error");
		expect(wire.at(-1)?.get("x-api-key")).toBe(SECRET);
		expect(wire.at(-1)?.get("authorization")).toBeNull();
		const headers = (ctor().defaultHeaders ?? {}) as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(JSON.stringify(ctor())).not.toContain("ctx-");
	});

	it("the Models layer works with a lease alone, without any configured auth", async () => {
		const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
		models.setProvider(anthropicProvider());
		const result = await models.streamSimple(model(), context, { credentials, fetch: wireFetch }).result();
		expect(result.stopReason).not.toBe("error");
		expect(wire.at(-1)?.get("x-api-key")).toBe(SECRET);
	});

	it("keeps the admitted base URL: auth resolution cannot redirect it", async () => {
		const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
		models.setProvider(anthropicProvider());
		await models.streamSimple(model(), context, { credentials, fetch: wireFetch }).result();
		expect(ctor().baseURL).toBe(model().baseUrl);
	});

	it("buildBaseOptions forwards credentials to the adapter options", () => {
		const options = buildBaseOptions(model(), transcript, { credentials });
		expect(options.credentials).toBe(credentials);
	});
});

describe("APIs without lease support refuse credentials", () => {
	// #70: use a fixture API that stays unbound as real adapter families gain support.
	const unsupported = () => ({
		...getModel("openai", "gpt-4o"),
		api: "splyce-unbound-test-api" as const,
		compat: undefined,
		baseUrl: "https://provider.invalid/v1",
	});

	it("compat.stream throws before any adapter or SDK runs", () => {
		expect(() => stream(unsupported(), context, { credentials, fetch: unexpectedFetch })).toThrow(/not supported/);
		expect(sdk.opts).toHaveLength(0);
		expect(unexpectedFetch).not.toHaveBeenCalled();
	});

	it("compat.streamSimple throws too", () => {
		expect(() => streamSimple(unsupported(), context, { credentials, fetch: unexpectedFetch })).toThrow(
			/not supported/,
		);
		expect(unexpectedFetch).not.toHaveBeenCalled();
	});

	it("the Models layer rejects instead of resolving ambient auth", async () => {
		const ambientAuth = vi.fn(async () => "ambient");
		const models = createModels({ authContext: { env: ambientAuth, fileExists: async () => false } });
		models.setProvider(openaiProvider());
		const result = await models
			.streamSimple(unsupported(), context, { credentials, fetch: unexpectedFetch })
			.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/not supported|not configured|not found|No provider/i);
		expect(ambientAuth).not.toHaveBeenCalled();
		expect(unexpectedFetch).not.toHaveBeenCalled();
	});
});
