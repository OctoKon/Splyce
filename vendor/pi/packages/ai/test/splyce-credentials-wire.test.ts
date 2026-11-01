// Actual-wire checks for the shared credentials option: the pinned vendor SDKs run for real against local HTTP
// servers, so what is asserted is what a socket would see, not what a constructor was handed. No network beyond
// 127.0.0.1 and no paid credential is involved.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { getModel } from "../src/compat.ts";
import { createLeasedFetch, type SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Context } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const SECRET = "wire-secret-0123456789";
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] } satisfies Context);
const lease = () => ({ use: async <T>(consume: (s: string) => T | Promise<T>) => consume(SECRET) });
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
const creds = (l: { use: <T>(c: (s: string) => T | Promise<T>) => Promise<T> } = lease()): SplyceCredentials => ({
	lease: l,
	redact: (text) => text.split(SECRET).join("[REDACTED]"),
});

type Seen = { url: string; headers: IncomingMessage["headers"] };
interface Local {
	server: Server;
	origin: string;
	seen: Seen[];
}
const servers: Server[] = [];
async function listen(handler: (req: IncomingMessage, res: ServerResponse, seen: Seen[]) => void): Promise<Local> {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		seen.push({ url: req.url ?? "", headers: req.headers });
		req.resume();
		req.on("end", () => handler(req, res, seen));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const anthropicOk = (res: ServerResponse) => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(
		[
			{ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]
			.map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`)
			.join(""),
	);
};
const googleOk = (res: ServerResponse) => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(
		`data: ${JSON.stringify({
			candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
		})}\n\n`,
	);
};

const claude = (origin: string) => ({ ...getModel("anthropic", "claude-haiku-4-5"), baseUrl: origin });
const gemini = (origin: string) => ({ ...getModel("google", "gemini-2.5-flash"), baseUrl: origin });

describe("shared leased fetch on the wire", () => {
	it.each(["Request", "init"])(
		"strips alternate credential headers and placeholders from %s headers",
		async (source) => {
			const local = await listen((_req, res) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end("{}");
			});
			const authNames = ["authorization", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key", "cookie"];
			const headers = { ...Object.fromEntries(authNames.map((name) => [name, "splyce-leased"])), "x-trace": "kept" };
			const leased = createLeasedFetch(creds(), "authorization", globalThis.fetch, (secret) => `Bearer ${secret}`);
			const response =
				source === "Request"
					? await leased(new Request(`${local.origin}/lease`, { headers }))
					: await leased(`${local.origin}/lease`, { headers });
			await response.text();
			expect(local.seen).toHaveLength(1);
			const sent = local.seen[0]!.headers;
			expect(sent.authorization).toBe(`Bearer ${SECRET}`);
			for (const name of authNames.filter((name) => name !== "authorization"))
				expect(sent[name], name).toBeUndefined();
			expect(sent["x-trace"]).toBe("kept");
			expect(JSON.stringify(sent)).not.toContain("splyce-leased");
		},
	);
});

describe("Anthropic on the wire (real SDK)", () => {
	it("sends exactly the leased key, with no other credential", async () => {
		const local = await listen((_req, res) => anthropicOk(res));
		const result = await streamAnthropic(claude(local.origin), context, { credentials: creds() }).result();
		expect(result.stopReason).toBe("stop");
		expect(local.seen).toHaveLength(1);
		expect(local.seen[0]!.headers["x-api-key"]).toBe(SECRET);
		expect(local.seen[0]!.headers.authorization).toBeUndefined();
	});

	it("rejects a caller-supplied auth header, in any letter case, before anything is sent", async () => {
		const local = await listen((_req, res) => anthropicOk(res));
		for (const name of ["X-Api-Key", "authorization", "Proxy-Authorization", "x-goog-api-key", "Cookie"]) {
			const result = await streamAnthropic(claude(local.origin), context, {
				credentials: creds(),
				headers: { [name]: "caller-value" },
			}).result();
			expect(result.stopReason, name).toBe("error");
		}
		expect(local.seen).toHaveLength(0);
	});

	it("rejects a caller-supplied SDK client, which would bypass the lease", async () => {
		const local = await listen((_req, res) => anthropicOk(res));
		// A client that would answer successfully: without the guard this call would complete using its own auth.
		const okBody = [
			{ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]
			.map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`)
			.join("");
		const client = {
			beta: {
				messages: {
					create: () => ({
						asResponse: async () =>
							new Response(okBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
					}),
				},
			},
		};
		const result = await streamAnthropic(claude(local.origin), context, {
			credentials: creds(),
			client: client as never,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage ?? "").toMatch(/caller-supplied client/);
		expect(local.seen).toHaveLength(0);
	});

	it("does not follow a redirect, so the key never reaches the other origin", async () => {
		const other = await listen((_req, res) => anthropicOk(res));
		const first = await listen((_req, res) => {
			res.writeHead(302, { location: `${other.origin}/v1/messages` });
			res.end();
		});
		const result = await streamAnthropic(claude(first.origin), context, { credentials: creds() }).result();
		expect(result.stopReason).toBe("error");
		expect(first.seen).toHaveLength(1);
		expect(other.seen).toHaveLength(0);
	});

	it("a lease revoked after the first send stops the SDK's own retry", async () => {
		const local = await listen((_req, res) => {
			res.writeHead(529, { "content-type": "application/json", "x-should-retry": "true" });
			res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }));
		});
		const result = await streamAnthropic(claude(local.origin), context, {
			credentials: creds(expiringLease(1)),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(local.seen).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});
});

describe("Google on the wire (real SDK)", () => {
	it("sends exactly the leased key in x-goog-api-key", async () => {
		const local = await listen((_req, res) => googleOk(res));
		const result = await streamGoogle(gemini(local.origin), context, { credentials: creds() }).result();
		expect(result.stopReason).toBe("stop");
		expect(local.seen).toHaveLength(1);
		expect(local.seen[0]!.headers["x-goog-api-key"]).toBe(SECRET);
		expect(local.seen[0]!.headers.authorization).toBeUndefined();
	});

	it("rejects a caller-supplied auth header, which the SDK would prefer to the lease", async () => {
		const local = await listen((_req, res) => googleOk(res));
		for (const name of ["X-Goog-Api-Key", "Authorization"]) {
			const result = await streamGoogle(gemini(local.origin), context, {
				credentials: creds(),
				headers: { [name]: "caller-value" },
			}).result();
			expect(result.stopReason, name).toBe("error");
		}
		expect(local.seen).toHaveLength(0);
	});

	it("rejects a payload hook that moves the endpoint, adds headers or turns on SDK retries", async () => {
		const local = await listen((_req, res) => googleOk(res));
		for (const httpOptions of [
			{ baseUrl: "http://127.0.0.1:1" },
			{ headers: { "x-goog-api-key": "caller" } },
			{ retryOptions: { attempts: 3 } },
		]) {
			const result = await streamGoogle(gemini(local.origin), context, {
				credentials: creds(),
				onPayload: (params) => ({ ...(params as object), config: { httpOptions } }),
			}).result();
			expect(result.stopReason).toBe("error");
		}
		expect(local.seen).toHaveLength(0);
	});

	it("asks the lease once per request attempt", async () => {
		const local = await listen((_req, res) => googleOk(res));
		const counted = expiringLease(100);
		await streamGoogle(gemini(local.origin), context, { credentials: creds(counted) }).result();
		expect(counted.state.uses).toBe(local.seen.length);
	});

	// The pinned SDK calls the global fetch with its own request options, follows redirects and cannot be given our
	// leased fetch, so a redirect from the admitted endpoint would carry x-goog-api-key along. This is why Google and
	// Vertex stay behind the native transport's final per-send check (TD-13) and are not claimed end-to-end safe here.
	it.todo("denies a cross-origin redirect (needs native egress mediation or an SDK transport hook)");
});
