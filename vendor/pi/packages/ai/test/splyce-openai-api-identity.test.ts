// Splyce #70: real Models/provider factories may not change the API admitted with native credentials.
import { describe, expect, it } from "vitest";
import { NativeCredentialResolver } from "../../../../../packages/splyce-pi/src/credential-resolver.ts";
import { openAICodexResponsesApi } from "../src/api/openai-codex-responses.lazy.ts";
import { openAICompletionsApi } from "../src/api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../src/api/openai-responses.lazy.ts";
import { createModels, createProvider } from "../src/models.ts";
import { openaiProvider } from "../src/providers/openai.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Api, Model, StreamOptions } from "../src/types.ts";

const apis = ["openai-completions", "openai-responses", "openai-codex-responses"] as const;
const factories = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"openai-codex-responses": openAICodexResponsesApi,
};
const context = { messages: [{ role: "user" as const, content: "fixture", timestamp: 0 }] };
const secret = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.fixture`;

describe("native OpenAI API identity at the actual implementation", () => {
	for (const implementation of apis) {
		for (const declared of apis.filter((api) => api !== implementation)) {
			for (const simple of [false, true]) {
				it(`${implementation} refuses model API ${declared} through Models (simple=${simple}) before lease or effects`, async () => {
					const resolver = new NativeCredentialResolver({ env: { FIXTURE_KEY: secret } });
					resolver.register({
						providerConnectionId: "fixture-connection",
						connectionRevision: "v1",
						endpointRef: "fixture-endpoint",
						egressPolicyRef: "fixture-egress",
						source: { kind: "env", name: "FIXTURE_KEY" },
					});
					const lease = await resolver.resolve({
						providerConnectionId: "fixture-connection",
						connectionRevision: "v1",
						endpointRef: "fixture-endpoint",
						egressPolicyRef: "fixture-egress",
						actionId: "fixture-action",
					});
					let uses = 0;
					let effects = 0;
					let payloads = 0;
					const credentials: SplyceCredentials = {
						lease: {
							use: (consume) => {
								uses++;
								return lease.use(consume);
							},
						},
						redact: resolver.redact,
					};
					const model: Model<Api> = {
						id: "fixture-model",
						name: "Fixture",
						api: declared,
						provider: "fixture-provider",
						baseUrl: "https://provider.invalid/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 1024,
					};
					const models = createModels({
						authContext: {
							env: async () => {
								throw new Error("must not resolve ambient auth");
							},
							fileExists: async () => false,
						},
					});
					models.setProvider(
						createProvider({
							id: model.provider,
							name: "Fixture",
							baseUrl: model.baseUrl,
							auth: openaiProvider().auth,
							models: [model],
							api: factories[implementation](),
						}),
					);
					const options = {
						credentials,
						transport: "sse",
						maxRetries: 0,
						onPayload: () => {
							payloads++;
						},
						fetch: async () => {
							effects++;
							throw new Error("fixture must not send");
						},
					} satisfies StreamOptions;
					const result = await (simple
						? models.streamSimple(model, context, options)
						: models.stream(model, context, options)
					).result();
					expect(result.stopReason).toBe("error");
					expect(result.errorMessage).toMatch(/native credential API identity/i);
					expect(uses).toBe(0);
					expect(effects).toBe(0);
					expect(payloads).toBe(0);
				});
			}
		}
	}
});
