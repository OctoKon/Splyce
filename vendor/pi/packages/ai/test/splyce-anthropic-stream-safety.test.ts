// TD-21 / C4 Messages: failing-first cases for tool blocks, cumulative usage and stream errors.
// Real adapter, real SSE parsing; only the HTTP client is replaced, as in anthropic-sse-parsing.test.ts.
import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type Ev = { event: string; data: unknown };
const sse = (events: Ev[]) =>
	new Response(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n"), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
const client = (response: Response) =>
	({ beta: { messages: { create: () => ({ asResponse: async () => response }) } } }) as unknown as Anthropic;

const start = (usage: Record<string, number> = { input_tokens: 12, output_tokens: 1 }): Ev => ({
	event: "message_start",
	data: { type: "message_start", message: { id: "msg", usage } },
});
const toolStart: Ev = {
	event: "content_block_start",
	data: {
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "tu_1", name: "read", input: {} },
	},
};
const jsonDelta = (partial_json: string): Ev => ({
	event: "content_block_delta",
	data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } },
});
const stop: Ev = { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } };
const delta = (stop_reason: string, usage: Record<string, number>): Ev => ({
	event: "message_delta",
	data: { type: "message_delta", delta: { stop_reason }, usage },
});
const msgStop: Ev = { event: "message_stop", data: { type: "message_stop" } };

const model: Model<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 200000,
	maxTokens: 64000,
};
const context = () =>
	normalizeContext({
		messages: [{ role: "user", content: "go", timestamp: 1 }],
		tools: [{ name: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }) }],
	});
const run = async (events: Ev[]) => {
	const s = streamAnthropic(model, context(), { client: client(sse(events)) });
	const types: string[] = [];
	for await (const event of s) types.push(event.type);
	return { types, result: await s.result() };
};
const toolCalls = (content: Array<{ type: string }>) => content.filter((block) => block.type === "toolCall");

describe("TD-21 Anthropic Messages under the shared core contract", () => {
	it("counts cumulative message_delta usage once", async () => {
		const { result } = await run([
			start({ input_tokens: 12, output_tokens: 1 }),
			delta("end_turn", { input_tokens: 12, output_tokens: 5 }),
			delta("end_turn", { input_tokens: 12, output_tokens: 9 }),
			msgStop,
		]);
		expect(result.usage.input).toBe(12);
		expect(result.usage.output).toBe(9);
		expect(result.usage.totalTokens).toBe(21);
	});

	it("emits a tool call only at block stop, with fully parsed arguments", async () => {
		const { types, result } = await run([
			start(),
			toolStart,
			jsonDelta('{"path": "/wor'),
			jsonDelta('kspace/a.txt"}'),
			stop,
			delta("tool_use", { input_tokens: 12, output_tokens: 7 }),
			msgStop,
		]);
		expect(types.filter((t) => t === "toolcall_end")).toHaveLength(1);
		expect(types.indexOf("toolcall_end")).toBeGreaterThan(types.lastIndexOf("toolcall_delta"));
		expect(result.stopReason).toBe("toolUse");
		expect(toolCalls(result.content)).toHaveLength(1);
		expect((toolCalls(result.content)[0] as unknown as { arguments: unknown }).arguments).toEqual({
			path: "/workspace/a.txt",
		});
	});

	it("never completes with a tool block that was not closed", async () => {
		const { types, result } = await run([
			start(),
			toolStart,
			jsonDelta('{"path": "/etc/pas'),
			delta("tool_use", { input_tokens: 12, output_tokens: 7 }),
			msgStop,
		]);
		expect(types).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(toolCalls(result.content)).toHaveLength(0);
	});

	it("drops a partial tool call when the provider sends an error event mid-block", async () => {
		const { types, result } = await run([
			start(),
			toolStart,
			jsonDelta('{"path": "/etc/pas'),
			{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
		]);
		expect(types).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(toolCalls(result.content)).toHaveLength(0);
	});

	it("drops even a FINISHED tool call when the stream then errors", async () => {
		const { types, result } = await run([
			start(),
			toolStart,
			jsonDelta('{"path": "/a"}'),
			stop,
			{ event: "error", data: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } },
		]);
		expect(types).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(toolCalls(result.content)).toHaveLength(0);
	});

	it("does not report a completed result when the stream ends without a stop reason", async () => {
		const { types, result } = await run([start(), toolStart, jsonDelta('{"path": "/a"}'), stop]);
		expect(types).not.toContain("done");
		expect(result.stopReason).toBe("error");
	});
});
