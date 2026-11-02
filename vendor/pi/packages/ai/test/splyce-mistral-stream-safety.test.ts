// TD-23 / C4 Mistral conversations under the shared credentials option and the common stream-safety rules.
// Real adapter and real SSE parsing; only `fetch` is replaced (the adapter talks HTTP itself, there is no SDK).
import { Type } from "typebox";
import { beforeEach, describe, expect, it } from "vitest";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import { getModel } from "../src/compat.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Context } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SECRET = "mistral-secret-0123456789";
const nativeRedact = (text: string) => text.split(SECRET).join("[REDACTED]");
const lease = (secret = SECRET) => ({ use: async <T>(consume: (s: string) => T | Promise<T>) => consume(secret) });
const brokenLease = () => ({
	use: async <T>(_consume: (s: string) => T | Promise<T>): Promise<T> => {
		throw new Error("CREDENTIAL_REVOKED");
	},
});
const creds = (l = lease()): SplyceCredentials => ({ lease: l, redact: nativeRedact });

const model = () => getModel("mistral", "mistral-large-latest");
const context = (): Context => ({
	messages: [{ role: "user", content: "go", timestamp: 1 }],
	tools: [{ name: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }) }],
});

type Sent = { url: string; headers: Headers; redirect: string | undefined };
const sent: Sent[] = [];
const sse = (events: unknown[]) =>
	new Response(`${events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
const serve = (make: () => Response) =>
	(async (input: unknown, init?: RequestInit) => {
		sent.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
		return make();
	}) as unknown as typeof fetch;

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
	id: "r1",
	model: "mistral-large-latest",
	choices: [{ index: 0, delta, finish_reason: finish }],
	usage: finish ? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } : undefined,
});
const toolDelta = (args: string, id = "tc1") => ({
	tool_calls: [{ id, index: 0, function: { name: "read", arguments: args } }],
});
const toolCalls = (content: Array<{ type: string }>) => content.filter((b) => b.type === "toolCall");
const run = (extra: Record<string, unknown>, make: () => Response = () => sse([chunk({ content: "ok" }, "stop")])) =>
	streamMistral(model(), normalizeContext(context()), { fetch: serve(make), ...extra }).result();

beforeEach(() => {
	sent.length = 0;
});

describe("TD-23 Mistral: credentials", () => {
	it("sends the leased secret as the bearer token to the admitted base URL, refusing redirects", async () => {
		const result = await run({ credentials: creds() });
		expect(result.stopReason).toBe("stop");
		expect(sent).toHaveLength(1);
		expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
		expect(new URL(sent[0]!.url).origin).toBe(new URL(model().baseUrl).origin);
		expect(sent[0]!.redirect).toBe("error");
	});

	it("rejects apiKey with credentials, and credentials without a native redact, before anything is sent", async () => {
		const both = await run({ apiKey: "k", credentials: creds() });
		expect(both.stopReason).toBe("error");
		const noRedact = await run({ credentials: { lease: lease() } as never });
		expect(noRedact.stopReason).toBe("error");
		expect(sent).toHaveLength(0);
	});

	it("fails closed on a revoked lease and never uses an ambient key", async () => {
		const result = await run({ credentials: creds(brokenLease()), env: { MISTRAL_API_KEY: "ambient-key" } });
		expect(result.stopReason).toBe("error");
		expect(sent).toHaveLength(0);
	});

	it("redacts the secret from a provider error body with the native redactor", async () => {
		const result = await run(
			{ credentials: creds() },
			() => new Response(JSON.stringify({ message: `bad key ${SECRET}` }), { status: 401 }),
		);
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("rejects a caller-supplied auth header, in any letter case, before anything is sent", async () => {
		for (const name of ["Authorization", "x-api-key", "Cookie"]) {
			const result = await run({ credentials: creds(), headers: { [name]: "caller-value" } });
			expect(result.stopReason, name).toBe("error");
		}
		expect(sent).toHaveLength(0);
	});

	it("refuses a model of another API with native credentials before any lease or send", async () => {
		let uses = 0;
		const counted = {
			use: async <T>(consume: (s: string) => T | Promise<T>) => {
				uses += 1;
				return consume(SECRET);
			},
		};
		const wrong = { ...model(), api: "anthropic-messages" } as never;
		const result = await streamMistral(wrong, normalizeContext(context()), {
			fetch: serve(() => sse([chunk({ content: "ok" }, "stop")])),
			credentials: creds(counted),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toContain("API identity");
		expect(uses).toBe(0);
		expect(sent).toHaveLength(0);
	});

	it("keeps the legacy apiKey path unchanged", async () => {
		const result = await run({ apiKey: "legacy-key" });
		expect(result.stopReason).toBe("stop");
		expect(sent[0]!.headers.get("authorization")).toBe("Bearer legacy-key");
	});
});

describe("TD-23 Mistral: stream safety", () => {
	it("returns a finished tool call as toolUse with parsed arguments", async () => {
		const result = await run({ apiKey: "k" }, () =>
			sse([chunk(toolDelta('{"path": "/workspace/a.txt"}')), chunk({}, "tool_calls")]),
		);
		expect(result.stopReason).toBe("toolUse");
		const call = toolCalls(result.content)[0] as unknown as { arguments: unknown };
		expect(call.arguments).toEqual({ path: "/workspace/a.txt" });
	});

	it("never returns a tool call from a stream that ended without a finish reason", async () => {
		const result = await run({ apiKey: "k" }, () => sse([chunk(toolDelta('{"path": "/etc/pas'))]));
		expect(result.stopReason).toBe("error");
		expect(toolCalls(result.content)).toHaveLength(0);
	});

	it("never returns a tool call from an error finish", async () => {
		const result = await run({ apiKey: "k" }, () =>
			sse([chunk(toolDelta('{"path": "/a"}')), chunk({}, "model_length_error")]),
		);
		expect(toolCalls(result.content).length === 0 || result.stopReason !== "toolUse").toBe(true);
		expect(result.stopReason).not.toBe("toolUse");
	});

	it("marks truncated tool arguments instead of presenting them as complete", async () => {
		const result = await run({ apiKey: "k" }, () =>
			sse([chunk(toolDelta('{"path": "/etc/pas')), chunk({}, "length")]),
		);
		expect(result.stopReason).toBe("length");
		for (const call of toolCalls(result.content) as unknown as Array<{ argumentsError?: unknown }>) {
			expect(call.argumentsError).toBeTruthy();
		}
	});
});
