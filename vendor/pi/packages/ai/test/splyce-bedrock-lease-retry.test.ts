// TD-22 / C4: a leased Bedrock send must make exactly one physical request.
//
// The leased identity is memoized per client (@aws-sdk/core wraps the provider in
// @smithy/core memoizeIdentityProvider, which never re-invokes a provider whose identity carries no
// expiration), so a retry inside one send reuses the first lease. That is only acceptable if the leased
// path never lets the SDK send a second request on its own: a mid-send revocation must not be followed by
// an unauthorized send, and a revoked lease must not be skipped by a transport-level retry either.
//
// The fixtures in splyce-credentials-bedrock-azure.test.ts replace the SDK client, so they cannot count
// physical requests. This runs the real @aws-sdk/client-bedrock-runtime against a loopback HTTP endpoint.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import type { BedrockOptions } from "../src/api/bedrock-converse-stream.ts";
import { stream } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { SplyceCredentials } from "../src/splyce-credentials.ts";
import type { Context } from "../src/types.ts";

const SECRET = "lease-secret-0123456789abcdef";
const LEASED_KEY_JSON = JSON.stringify({
	accessKeyId: "AKIALEASED",
	secretAccessKey: SECRET,
	sessionToken: "leased-session-token",
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/**
 * Bedrock runtime defaults to a NodeHttp2Handler, which cannot talk to a plain loopback HTTP/1 server, and
 * an unset region would make the SDK resolve credentials from the ambient chain. Both are pinned here so a
 * request that never leaves the process fails the request count instead of silently passing it.
 */
const env = {
	AWS_ACCESS_KEY_ID: "AKIACONTROL",
	AWS_SECRET_ACCESS_KEY: "control-secret-access-key",
	AWS_REGION: "us-east-1",
	AWS_BEDROCK_FORCE_HTTP1: "1",
};

type Recorder = { requests: string[]; leaseUses: number };

/**
 * A loopback Bedrock endpoint that always answers with a retryable status, so the SDK's own retry policy is
 * the only thing that could produce a second physical request. The lease revokes itself the moment the first
 * identity is handed out, which is exactly the mid-send revocation the lease contract must survive.
 */
async function recordingEndpoint(): Promise<{
	baseUrl: string;
	recorder: Recorder;
	close: () => Promise<void>;
}> {
	const recorder: Recorder = { requests: [], leaseUses: 0 };
	const server = createServer((request, response) => {
		recorder.requests.push(`${request.method} ${request.url}`);
		request.resume();
		response.writeHead(503, { "content-type": "application/json" });
		response.end(JSON.stringify({ message: "throttled by the recording endpoint" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("loopback endpoint has no port");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		recorder,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function leasedCredentials(recorder: Recorder): SplyceCredentials {
	let revoked = false;
	return {
		lease: {
			use: async (consume) => {
				if (revoked) throw new Error("Bedrock credential lease was revoked");
				recorder.leaseUses += 1;
				const identity = await consume(LEASED_KEY_JSON);
				revoked = true;
				return identity;
			},
		},
		redact: (text) => text.split(SECRET).join("[redacted]"),
	};
}

const bedrockModel = () => getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

describe("TD-22 bedrock: a leased send does not retry past its lease", () => {
	it("control: an unleased send really retries the loopback endpoint", async () => {
		const { baseUrl, recorder, close } = await recordingEndpoint();
		cleanup = close;

		await stream({ ...bedrockModel(), baseUrl }, context, {
			cacheRetention: "none",
			env,
		} satisfies BedrockOptions).result();

		// Without a lease the SDK's own retry policy must be observable, otherwise the leased assertion
		// below could pass because no request reached the endpoint at all.
		expect(recorder.requests.length).toBeGreaterThanOrEqual(2);
	}, 60_000);

	it("makes one physical request when a retryable response follows the lease's first use", async () => {
		const { baseUrl, recorder, close } = await recordingEndpoint();
		cleanup = close;

		const result = await stream({ ...bedrockModel(), baseUrl }, context, {
			cacheRetention: "none",
			env,
			credentials: leasedCredentials(recorder),
		} satisfies BedrockOptions).result();

		// A 503 is retryable: an unmediated SDK retry would be a second physical send after the lease died.
		expect(recorder.requests).toHaveLength(1);
		expect(recorder.leaseUses).toBe(1);
		// The single attempt still fails closed with a typed error result rather than hanging.
		expect(result.stopReason).toBe("error");
	}, 60_000);
});
