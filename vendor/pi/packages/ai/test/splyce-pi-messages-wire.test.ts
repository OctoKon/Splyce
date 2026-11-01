// TD-23 / C4 Pi-native messages: the declared API name must never substitute the actual wire contract. A terminal or
// event that does not match it fails the call (no fallback, no half-built result), and the shared credentials option
// binds the same way as the other families. Real adapter; only `fetch` is replaced.
import { beforeEach, describe, expect, it } from "vitest";
import { stream as streamPi } from "../src/api/pi-messages.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Api, Context, Model } from "../src/types.ts";

const SECRET = "pi-secret-0123456789";
const lease = () => ({ use: async <T>(consume: (s: string) => T | Promise<T>) => consume(SECRET) });
const creds = (): SplyceCredentials => ({ lease: lease(), redact: (t) => t.split(SECRET).join("[REDACTED]") });
const model = {
	id: "m-1",
	name: "m-1",
	api: "pi-messages",
	provider: "radius",
	baseUrl: "https://gateway.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 8000,
} as unknown as Model<Api> as Model<"pi-messages">;
const context = (): Context => ({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

type Sent = { url: string; headers: Headers; redirect: string | undefined };
const sent: Sent[] = [];
const sse = (events: unknown[]) =>
	new Response(`${events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
const serve = (make: () => Response) =>
	(async (input: unknown, init?: RequestInit) => {
		sent.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
		return make();
	}) as unknown as typeof fetch;
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const run = (events: unknown[], extra: Record<string, unknown> = { apiKey: "k" }) =>
	streamPi(model, context() as never, { fetch: serve(() => sse(events)), ...extra }).result();
const toolCalls = (content: Array<{ type: string }>) => content.filter((b) => b.type === "toolCall");

const start = { type: "start" };
const callStart = { type: "toolcall_start", contentIndex: 0, id: "tc1", toolName: "read" };
const callDelta = { type: "toolcall_delta", contentIndex: 0, delta: '{"path": "/etc/pas' };
const callEnd = {
	type: "toolcall_end",
	contentIndex: 0,
	toolCall: { type: "toolCall", id: "tc1", name: "read", arguments: { path: "/a" } },
};
const done = (reason: string) => ({ type: "done", reason, usage, responseId: "r1" });
const failed = (reason = "error") => ({ type: "error", reason, usage, errorMessage: "boom", responseId: "r1" });

beforeEach(() => {
	sent.length = 0;
});

describe("TD-23 Pi-native: credentials", () => {
	it("sends the leased secret as the bearer token to <baseUrl>/messages and refuses redirects", async () => {
		const result = await run([start, done("stop")], { credentials: creds() });
		expect(result.stopReason).toBe("stop");
		expect(sent[0]!.url).toBe("https://gateway.example/v1/messages");
		expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
		expect(sent[0]!.redirect).toBe("error");
	});

	it("rejects apiKey with credentials and credentials without redact before anything is sent", async () => {
		expect((await run([done("stop")], { apiKey: "k", credentials: creds() })).stopReason).toBe("error");
		expect((await run([done("stop")], { credentials: { lease: lease() } as never })).stopReason).toBe("error");
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
		const wrong = { ...model, api: "anthropic-messages" } as never;
		const result = await streamPi(wrong, context() as never, {
			fetch: serve(() => sse([start, done("stop")])),
			credentials: { lease: counted, redact: (t: string) => t.split(SECRET).join("[REDACTED]") },
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toContain("API identity");
		expect(uses).toBe(0);
		expect(sent).toHaveLength(0);
	});

	it("rejects a caller-supplied auth header before anything is sent", async () => {
		for (const name of ["Authorization", "X-Api-Key"]) {
			const result = await run([done("stop")], { credentials: creds(), headers: { [name]: "caller-value" } });
			expect(result.stopReason, name).toBe("error");
		}
		expect(sent).toHaveLength(0);
	});

	it("redacts the secret from a failing response body", async () => {
		const result = await streamPi(model, context() as never, {
			fetch: serve(() => new Response(`denied for ${SECRET}`, { status: 401 })),
			credentials: creds(),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("redacts a secret that JSON escaping would change (quote, backslash) from the diagnostic", async () => {
		const tricky = 's"ec\\ret-0123456789';
		const result = await streamPi(model, context() as never, {
			fetch: serve(() => new Response(`denied for ${tricky}`, { status: 401 })),
			credentials: {
				lease: { use: async (consume) => consume(tricky) },
				redact: (t) => t.split(tricky).join("[REDACTED]"),
			},
		}).result();
		expect(result.stopReason).toBe("error");
		const text = JSON.stringify(result);
		expect(text).not.toContain(tricky);
		expect(text).not.toContain(JSON.stringify(tricky).slice(1, -1));
		expect(text).toContain("[REDACTED]");
	});

	it("a throwing redactor still delivers the terminal error event without raw bytes", async () => {
		const result = await streamPi(model, context() as never, {
			fetch: serve(() => new Response(`denied for ${SECRET}`, { status: 401 })),
			credentials: {
				lease: lease(),
				redact: () => {
					throw new Error("redactor down");
				},
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});
});

describe("TD-23 Pi-native: wire contract", () => {
	it("a done event while a tool call is still open is an error, not a completed result", async () => {
		const result = await run([start, callStart, callDelta, done("toolUse")]);
		expect(result.stopReason).toBe("error");
		expect(toolCalls(result.content)).toHaveLength(0);
	});

	it("an error event drops every tool call, finished or not", async () => {
		const result = await run([start, callStart, callDelta, failed()]);
		expect(result.stopReason).toBe("error");
		expect(toolCalls(result.content)).toHaveLength(0);
	});

	it("an unknown event type fails the call instead of being passed through", async () => {
		const result = await run([start, { type: "gateway_notice", text: "hi" }, done("stop")]);
		expect(result.stopReason).toBe("error");
	});

	it("a terminal reason outside the contract fails the call", async () => {
		expect((await run([start, done("weird")])).stopReason).toBe("error");
		expect((await run([start, failed("weird")])).stopReason).toBe("error");
	});

	it("done with toolUse but no tool call is a mismatch, not a result", async () => {
		const result = await run([start, done("toolUse")]);
		expect(result.stopReason).toBe("error");
	});

	it("a finished tool call with a toolUse terminal is accepted", async () => {
		const result = await run([start, callStart, callEnd, done("toolUse")]);
		expect(result.stopReason).toBe("toolUse");
		expect(toolCalls(result.content)).toHaveLength(1);
	});

	it("a stream that ends without a terminal event is an error", async () => {
		const result = await run([start, { type: "text_start", contentIndex: 0 }]);
		expect(result.stopReason).toBe("error");
	});
});

describe("TD-23 Pi-native: revoked lease at error time", () => {
	it("still redacts the diagnostic and delivers the terminal event when the lease is revoked after the send", async () => {
		let uses = 0;
		const result = await streamPi(model, context() as never, {
			fetch: serve(() => new Response(`denied for ${SECRET}`, { status: 401 })),
			credentials: {
				lease: {
					use: async <T>(consume: (s: string) => T | Promise<T>) => {
						uses += 1;
						if (uses > 1) throw new Error("lease revoked");
						return consume(SECRET);
					},
				},
				redact: (t) => t.split(SECRET).join("[REDACTED]"),
			},
		}).result();
		expect(uses).toBeGreaterThan(1);
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("a redactor that only knows the secret inside the lease never runs outside it: revoked lease -> generic terminal, no diagnostic", async () => {
		let uses = 0;
		let inside = false;
		const result = await streamPi(model, context() as never, {
			fetch: serve(() => new Response(`denied for ${SECRET}`, { status: 401 })),
			credentials: {
				lease: {
					use: async <T>(consume: (s: string) => T | Promise<T>) => {
						uses += 1;
						if (uses > 1) throw new Error("lease revoked");
						inside = true;
						try {
							return await consume(SECRET);
						} finally {
							inside = false;
						}
					},
				},
				// native-style redactor: it can only mask the secret while a lease is active, else it returns raw text.
				redact: (t) => (inside ? t.split(SECRET).join("[REDACTED]") : t),
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect(result.errorMessage).toBe("Provider credential is no longer available");
		expect(JSON.stringify(result)).not.toContain("pi_messages_response_failure");
	});

	it("observers see redacted response headers and provider events while the lease is active", async () => {
		const headers: Record<string, string>[] = [];
		const events: string[] = [];
		const leaky = sse([
			start,
			{ type: "text_start", contentIndex: 0, note: `echo ${SECRET}`, [`k-${SECRET}`]: 1 },
			done("stop"),
		]);
		leaky.headers.set("x-echo", SECRET);
		await streamPi(
			model,
			context() as never,
			{
				fetch: serve(() => leaky),
				credentials: creds(),
				onResponse: async (response: { headers: Record<string, string> }) => {
					headers.push(response.headers);
				},
				onProviderStreamEvent: async (event: unknown) => {
					events.push(JSON.stringify(event));
				},
			} as never,
		).result();
		expect(headers.length).toBe(1);
		expect(JSON.stringify(headers)).not.toContain(SECRET);
		expect(events.length).toBeGreaterThan(0);
		expect(events.join("")).not.toContain(SECRET);
		expect(events.join("")).toContain("[REDACTED]");
	});

	it("keeps the admitted credentials when onPayload mutates the caller options (error text and observers stay redacted)", async () => {
		const events: string[] = [];
		const options: Record<string, unknown> = {
			fetch: serve(() => new Response(`denied for ${SECRET}`, { status: 401, headers: { "x-echo": SECRET } })),
			credentials: creds(),
			onPayload: () => {
				options.credentials = undefined;
			},
			onResponse: async (response: { headers: Record<string, string> }) => {
				events.push(JSON.stringify(response.headers));
			},
		};
		const result = await streamPi(model, context() as never, options as never).result();
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect(events.join("")).not.toContain(SECRET);
	});

	it("a credentials object whose redact or lease was removed after preflight yields generic text, never raw", async () => {
		const mutated = creds() as { redact?: unknown };
		const result = await streamPi(
			model,
			context() as never,
			{
				fetch: serve(() => new Response(`denied for ${SECRET}`, { status: 401 })),
				credentials: mutated,
				onPayload: () => {
					mutated.redact = undefined;
				},
			} as never,
		).result();
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("redacts a provider error event's errorMessage and rewrite diagnostic before they reach the message", async () => {
		const rewrite = {
			policyId: `policy-${SECRET}`,
			policyVersion: 1,
			changed: true,
			tokenCountChange: 0,
			messageCountChange: 0,
			systemPromptChanged: false,
		};
		const errored = await run([start, { ...failed(), errorMessage: `denied for ${SECRET}`, rewrite }], {
			credentials: creds(),
		});
		expect(errored.stopReason).toBe("error");
		expect(JSON.stringify(errored)).not.toContain(SECRET);
		expect(errored.errorMessage).toContain("[REDACTED]");
		const completed = await run([start, { ...done("stop"), rewrite }], { credentials: creds() });
		expect(completed.stopReason).toBe("stop");
		expect(JSON.stringify(completed)).not.toContain(SECRET);
		expect(JSON.stringify(completed)).toContain("pi_messages_rewrite");
	});
});
