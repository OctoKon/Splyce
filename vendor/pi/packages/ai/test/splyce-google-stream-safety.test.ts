// TD-20 / C4 Google families: failing-first cases for signatures, identity failures and error finishes.
// Real adapters and real message conversion; only the @google/genai SDK boundary is replaced, as in
// google-raw-stop-reason.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	chunks: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		constructor(config: Record<string, unknown>) {
			sdk.constructorCalls.push(config);
		}
		models = {
			generateContentStream: async function* () {
				yield* sdk.chunks;
			},
		};
	}
	return {
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			SAFETY: "SAFETY",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			OTHER: "OTHER",
			FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
		},
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY", VALIDATED: "VALIDATED" },
		GoogleGenAI,
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: { THINKING_LEVEL_UNSPECIFIED: "A", MINIMAL: "B", LOW: "C", MEDIUM: "D", HIGH: "E" },
	};
});

import { Type } from "typebox";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { convertMessages } from "../src/api/google-shared.ts";
import { stream as streamVertex } from "../src/api/google-vertex.ts";
import type { Api, AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model = <TApi extends Api>(provider: string, api: TApi, id: string): Model<TApi> => ({
	id,
	name: id,
	api,
	provider,
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 8000,
});
const gemini = model("google", "google-generative-ai", "gemini-3-flash-preview");
const vertex = model("google-vertex", "google-vertex", "gemini-3-flash-preview");

const context = () =>
	normalizeContext({
		messages: [{ role: "user", content: "go", timestamp: 1 }],
		tools: [{ name: "read", description: "read a file", parameters: Type.Object({ path: Type.String() }) }],
	});
const call = (extra: Record<string, unknown> = {}) => ({
	functionCall: { id: "fc_1", name: "read", args: { path: "/workspace/a.txt" } },
	...extra,
});
const chunk = (parts: unknown[], finishReason?: string) => ({
	candidates: [{ content: { parts }, ...(finishReason && { finishReason }) }],
	usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
});
const toolCalls = (content: Array<{ type: string }>) => content.filter((b) => b.type === "toolCall");

beforeEach(() => {
	sdk.constructorCalls.length = 0;
	sdk.chunks = [];
});

describe("TD-20 Google families under the shared core contract", () => {
	it("round-trips a function-call signature for the same model and drops it for another", async () => {
		sdk.chunks = [chunk([call({ thoughtSignature: "c2lnbmF0dXJlLTE=" })], "STOP")];
		const result = await streamGoogle(gemini, context(), { apiKey: "k" }).result();
		const original = toolCalls(result.content)[0] as unknown as { thoughtSignature?: string };
		expect(original.thoughtSignature).toBe("c2lnbmF0dXJlLTE=");

		const replay = (target: Model<"google-generative-ai">) =>
			convertMessages(
				target,
				normalizeContext({
					...context(),
					messages: [...context().messages, result as AssistantMessage],
				}),
			);
		const sameModel = JSON.stringify(replay(gemini));
		expect(sameModel).toContain("c2lnbmF0dXJlLTE=");
		const otherModel = JSON.stringify(replay(model("google", "google-generative-ai", "gemini-2.5-flash")));
		expect(otherModel).not.toContain("c2lnbmF0dXJlLTE=");
	});

	it("never returns a tool call from a malformed-function-call finish", async () => {
		sdk.chunks = [chunk([call()], "MALFORMED_FUNCTION_CALL")];
		const result = await streamGoogle(gemini, context(), { apiKey: "k" }).result();
		expect(result.stopReason).toBe("error");
		expect(toolCalls(result.content)).toHaveLength(0);
	});

	it("never returns a tool call when the stream ends without a finish reason", async () => {
		sdk.chunks = [chunk([call()])];
		const events: string[] = [];
		const s = streamGoogle(gemini, context(), { apiKey: "k" });
		for await (const event of s) events.push(event.type);
		const result = await s.result();
		expect(events).not.toContain("done");
		expect(result.stopReason).toBe("error");
		expect(toolCalls(result.content)).toHaveLength(0);
	});

	it("applies the same rule on Vertex", async () => {
		sdk.chunks = [chunk([call()], "MALFORMED_FUNCTION_CALL")];
		const result = await streamVertex(vertex, context(), { project: "p", location: "us-central1" }).result();
		expect(result.stopReason).toBe("error");
		expect(toolCalls(result.content)).toHaveLength(0);
	});

	it("keeps a normal STOP tool call as toolUse", async () => {
		sdk.chunks = [chunk([call()], "STOP")];
		const result = await streamGoogle(gemini, context(), { apiKey: "k" }).result();
		expect(result.stopReason).toBe("toolUse");
		expect(toolCalls(result.content)).toHaveLength(1);
	});

	it("fails before any SDK client exists when the Vertex project or location is missing", async () => {
		const noProject = await streamVertex(vertex, context(), { location: "us-central1", env: {} }).result();
		expect(noProject.stopReason).toBe("error");
		expect(noProject.errorMessage ?? "").toMatch(/project/i);
		const noLocation = await streamVertex(vertex, context(), { project: "p", env: {} }).result();
		expect(noLocation.stopReason).toBe("error");
		expect(noLocation.errorMessage ?? "").toMatch(/location/i);
		expect(sdk.constructorCalls).toHaveLength(0);
	});

	it("rejects a custom fetch before any SDK client exists", async () => {
		const customFetch = (() => Promise.reject(new Error("must not be called"))) as unknown as typeof fetch;
		const a = await streamGoogle(gemini, context(), { apiKey: "k", fetch: customFetch }).result();
		const b = await streamVertex(vertex, context(), { project: "p", location: "l", fetch: customFetch }).result();
		expect(a.stopReason).toBe("error");
		expect(b.stopReason).toBe("error");
		expect(sdk.constructorCalls).toHaveLength(0);
	});
});
