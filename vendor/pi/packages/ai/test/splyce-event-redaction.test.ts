// Shared helper handoff: actual native resolver, no SDK or provider network involved.
import { describe, expect, it } from "vitest";
import { NativeCredentialResolver } from "../../../../../packages/splyce-pi/src/credential-resolver.ts";
import { redactEventWithLease, type SplyceCredentials } from "../src/splyce-credentials.ts";

const SECRET = 'synthetic-event-key"\\';
async function fixture() {
	const resolver = new NativeCredentialResolver({ env: { EVENT_FIXTURE_KEY: SECRET } });
	const request = {
		providerConnectionId: "event-fixture",
		connectionRevision: "v1",
		endpointRef: "endpoint",
		egressPolicyRef: "policy",
		actionId: "action",
	};
	resolver.register({ ...request, source: { kind: "env", name: "EVENT_FIXTURE_KEY" } });
	const lease = await resolver.resolve(request);
	return { lease, credentials: { lease, redact: resolver.redact } satisfies SplyceCredentials };
}

describe("shared native event redaction", () => {
	it("gives an observer a sanitized copy while preserving the parser input and JSON value shapes", async () => {
		const { credentials } = await fixture();
		const input = { [SECRET]: [SECRET, { nested: SECRET }, 42, true, null], clean: "kept" };
		const original = structuredClone(input);
		const observed = await redactEventWithLease(credentials, input);
		expect(observed).toEqual({
			"[REDACTED]": ["[REDACTED]", { nested: "[REDACTED]" }, 42, true, null],
			clean: "kept",
		});
		expect(input).toEqual(original);
		expect(observed).not.toBe(input);
	});

	it("revocation before the observer handoff prevents retention of an in-flight result", async () => {
		const { lease, credentials } = await fixture();
		const retained: unknown[] = [];
		const pending = redactEventWithLease(credentials, { message: SECRET }).then((event) => {
			retained.push(event);
		});
		lease.revoke();
		await expect(pending).rejects.toThrow();
		expect(retained).toHaveLength(0);
	});
});
