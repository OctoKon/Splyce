import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenAICodexWebSocketSessions, stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { stream as streamChat } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const fixture = vi.hoisted(() => ({
	chat: [] as unknown[],
	responses: [] as unknown[],
	abortAtEnd: undefined as AbortController | undefined,
}));

// The remote SDK is the fixture; the actual adapter and stream parser run.
vi.mock("openai", () => {
	function responseFor(chunks: unknown[]) {
		const data = {
			async *[Symbol.asyncIterator]() {
				for (const chunk of chunks) yield chunk;
				fixture.abortAtEnd?.abort();
			},
		};
		const result = Promise.resolve(data) as Promise<typeof data> & {
			withResponse: () => Promise<{ data: typeof data; response: Response }>;
		};
		result.withResponse = async () => ({ data, response: new Response(null, { status: 200 }) });
		return result;
	}
	class FakeOpenAI {
		chat = { completions: { create: () => responseFor(fixture.chat) } };
		responses = { create: () => responseFor(fixture.responses) };
	}
	return { default: FakeOpenAI };
});

const model = <T extends Api>(api: T): Model<T> => ({
	id: "fixture-model",
	name: "Fixture model",
	api,
	provider: api === "openai-codex-responses" ? "openai-codex" : "openai",
	baseUrl: "https://provider.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
});

const context = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] });
const calls = (content: { type: string }[]) => content.filter((block) => block.type === "toolCall");

function chatTool(finish: string | null) {
	return [
		{ id: "chat-fixture", choices: [{ index: 0, delta: { content: "Partial answer" }, finish_reason: null }] },
		{
			id: "chat-fixture",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{ index: 0, id: "call_a", type: "function", function: { name: "alpha", arguments: '{"a":1}' } },
						],
					},
					finish_reason: null,
				},
			],
		},
		{ id: "chat-fixture", choices: [{ index: 0, delta: {}, finish_reason: finish }] },
	];
}

function responsesTool(terminal: "completed" | "failed" | "error" | "eof") {
	const item = { type: "function_call", id: "fc_1", call_id: "call_a", name: "alpha", arguments: '{"a":1}' };
	const events: unknown[] = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Partial answer" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Partial answer" }],
			},
		},
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"a":1}' },
		{ type: "response.output_item.done", output_index: 0, item },
	];
	if (terminal === "error") events.push({ type: "error", code: "fixture_error", message: "fixture failure" });
	else if (terminal !== "eof")
		events.push({
			type: `response.${terminal}`,
			response: {
				id: "resp_1",
				status: terminal,
				output: [item],
				error: terminal === "failed" ? { code: "fixture_error", message: "fixture failure" } : null,
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		});
	return events;
}

beforeEach(() => {
	fixture.chat = [];
	fixture.responses = [];
	fixture.abortAtEnd = undefined;
});

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.restoreAllMocks();
});

// Splyce #70: incomplete or cancelled streams must not expose executable calls.
describe("Splyce OpenAI Chat Completions stream safety", () => {
	it.each(["content_filter", "network_error", null])(
		"does not return executable tool calls after terminal %s",
		async (terminal) => {
			fixture.chat = chatTool(terminal);
			const result = await streamChat(model("openai-completions"), context, {
				apiKey: "fixture-key",
				maxRetries: 0,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(calls(result.content)).toEqual([]);
			expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Partial answer" }));
		},
	);
	it("does not return executable tool calls after caller cancellation", async () => {
		const controller = new AbortController();
		fixture.chat = chatTool("tool_calls");
		fixture.abortAtEnd = controller;
		const result = await streamChat(model("openai-completions"), context, {
			apiKey: "fixture-key",
			signal: controller.signal,
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(calls(result.content)).toEqual([]);
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Partial answer" }));
	});
	it("preserves successful interleaved argument fragments and call identities", async () => {
		fixture.chat = [
			{
				id: "c",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, id: "call_a", type: "function", function: { name: "alpha", arguments: '{"a":' } },
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "c",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 1, id: "call_b", type: "function", function: { name: "beta", arguments: '{"b":' } },
							],
						},
						finish_reason: null,
					},
				],
			},
			{
				id: "c",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: "1}" } },
								{ index: 1, function: { arguments: "2}" } },
							],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		];
		const result = await streamChat(model("openai-completions"), context, { apiKey: "fixture-key" }).result();
		expect(result.stopReason).toBe("toolUse");
		expect(
			result.content
				.filter((block) => block.type === "toolCall")
				.map((block) => ({ id: block.id, name: block.name, arguments: block.arguments })),
		).toEqual([
			{ id: "call_a", name: "alpha", arguments: { a: 1 } },
			{ id: "call_b", name: "beta", arguments: { b: 2 } },
		]);
	});
});

describe("Splyce OpenAI Responses stream safety", () => {
	it.each(["failed", "error", "eof"] as const)("does not return executable tool calls after %s", async (terminal) => {
		fixture.responses = responsesTool(terminal);
		const result = await streamResponses(model("openai-responses"), context, {
			apiKey: "fixture-key",
			maxRetries: 0,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(calls(result.content)).toEqual([]);
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Partial answer" }));
	});
	it("does not return executable tool calls after cancellation", async () => {
		const controller = new AbortController();
		fixture.responses = responsesTool("completed");
		fixture.abortAtEnd = controller;
		const result = await streamResponses(model("openai-responses"), context, {
			apiKey: "fixture-key",
			signal: controller.signal,
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(calls(result.content)).toEqual([]);
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Partial answer" }));
	});
	it("retains a complete tool call after a successful terminal response", async () => {
		fixture.responses = responsesTool("completed");
		const result = await streamResponses(model("openai-responses"), context, { apiKey: "fixture-key" }).result();
		expect(result.stopReason).toBe("toolUse");
		expect(calls(result.content)).toHaveLength(1);
	});
});

describe("Splyce Codex Responses stream safety", () => {
	const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.fixture`;
	const options = (events: unknown[], signal?: AbortSignal) => ({
		apiKey: token,
		transport: "sse" as const,
		maxRetries: 0,
		...(signal ? { signal } : {}),
		fetch: async () =>
			new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				headers: { "content-type": "text/event-stream" },
			}),
	});
	it.each(["failed", "error", "eof"] as const)("does not return executable tool calls after %s", async (terminal) => {
		const result = await streamCodex(
			model("openai-codex-responses"),
			context,
			options(responsesTool(terminal)),
		).result();
		expect(result.stopReason).toBe("error");
		expect(calls(result.content)).toEqual([]);
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Partial answer" }));
	});
	it("does not return executable tool calls after cancellation at the terminal event", async () => {
		const controller = new AbortController();
		const result = await streamCodex(model("openai-codex-responses"), context, {
			...options(responsesTool("completed"), controller.signal),
			onProviderStreamEvent: (event) => {
				if (typeof event === "object" && event !== null && "type" in event && event.type === "response.completed") {
					controller.abort();
				}
			},
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(calls(result.content)).toEqual([]);
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "Partial answer" }));
	});
	it("retains a complete tool call after successful SSE completion", async () => {
		const result = await streamCodex(
			model("openai-codex-responses"),
			context,
			options(responsesTool("completed")),
		).result();
		expect(result.stopReason).toBe("toolUse");
		expect(calls(result.content)).toHaveLength(1);
	});
});
