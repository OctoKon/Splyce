# 0007: Mistral and Pi-native stream safety and credentials (TD-23)

`0007-mistral-pi-native-stream-safety.patch` applies from the Splyce root to `vendor/pi/`, after patch 0004 (the shared
credentials option). It changes `packages/ai/src/api/mistral-conversations.ts`, `pi-messages.ts` and the
`CREDENTIAL_APIS` set in `utils/model-operations.ts`.

- **Credentials.** Both adapters send through `createLeasedFetch` when `options.credentials` is set: the lease is asked
  for the secret on every send, written as `Authorization: Bearer`, other auth headers are dropped and redirects are
  refused. `apiKey` with `credentials`, or credentials without the native `redact`, are refused before anything is sent.
  Error text, the failing response body and the response-failure diagnostic of Pi-native go through the native redactor.
  The Mistral and Pi-native simple wrappers skip their early "no API key" check for a lease.
- **Same credential guards as 0004.** Both adapters refuse a model of another API with native credentials before any lease
  (`assertCredentialApiIdentity`), keep the admitted credentials across `onPayload`, redact errors with `redactWithLease`,
  sanitize `onResponse` headers and `onProviderStreamEvent` payloads inside the lease, and Pi-native drops its response-failure
  diagnostic rather than keep an unredacted one (`redactEventWithLease`). `splyce-pi-messages-wire.test.ts` covers revoked
  leases, a lease-scoped redactor, mutated options and observers.
- **Errored responses carry no tool calls.** The Mistral error path and the Pi-native `error` event drop every tool call.
- **Pi-native wire contract.** A declared `pi-messages` API name must match what arrives: an unknown event type, a `done`
  or `error` reason outside the contract, a `done` while a tool call is still open, or `done` with `toolUse` and no tool
  call fails the call. The stream is not passed through half-built, and there is no fallback.
- **Regression entrypoints.** `packages/ai/test/splyce-mistral-stream-safety.test.ts` and `splyce-pi-messages-wire.test.ts`
  run the real adapters with only `fetch` replaced. Removing the unknown-event rejection, the open-tool-call check, either
  tool-call drop, or the leased fetch fails a test.
- **Not qualified.** Real Mistral and gateway calls were not made. Provider-specific admission and the final per-send check
  belong to the native transport (TD-13).
