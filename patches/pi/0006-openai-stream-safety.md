# TD-19 OpenAI stream and credential safety

Refs [TD-19 / issue 70](https://github.com/OctoKon/Splyce/issues/70).
Donor: Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`,
`@earendil-works/pi-ai` 1.4.0. Preserve the donor MIT license.
Apply `0006-openai-stream-safety.patch` from the Splyce root after the native
bootstrap and the shared provider handoff at
`d5bf6bd356461f1ec30d3a42e8bb5d486e86054b`. The provider patch order is
0004, 0007, then 0006; the shared preflight marker belongs to the prior handoff.
The native resolver integration cases also require the reviewed TD-16 resolver
at `febf67d`; native changes are consumed as a dependency, not bundled here.
The initial stream-cleanup slice is checkpointed separately at `da0ae10`.

The real `stream` implementations in `openai-completions.ts`,
`openai-responses.ts` and `openai-codex-responses.ts` now remove tool-call content
when returning an error or cancellation. Partial answer text, diagnostic
reasoning, usage and successful tool-call identities keep their existing paths.
This changes the final failed result; partial stream events remain progress
notifications and cannot authorize tool execution.

## Local adapter evidence

`vendor/pi/packages/ai/test/splyce-openai-stream-safety.test.ts` runs the actual
three adapters and stream parsers. Only the remote OpenAI SDK/service is a
fixture. It covers failed terminals, missing terminals, caller cancellation,
preserved partial answer text and successful fragmented/interleaved arguments.
The Codex fixtures use explicit SSE transport. No real credential or paid
provider call is required.

The initial test run failed 11 assertions while all three success controls
passed. After the change, all 15 cases pass. Independently removing each of the
three cleanup guards fails that adapter's assertions; restoring them passes all
15 again. The two existing raw-stop-reason cases also pass. A broader selected
OpenAI run passed 261 tests; its four live-provider image cases skipped because
credentials were unavailable. They are not qualification evidence.

The initial stream-cleanup slice passed the donor's full `npm run check` with
its own pinned TypeScript 7.0.2 closure and lifecycle scripts disabled. That
historical result does not qualify the newer credential integration below.

The local source tests use the published `@earendil-works/pi-ai@1.4.0` catalog
data in the ignored `src/providers/data` directory. The npm artifact integrity is
`sha512-hQM/C4+1w8rHYACzDDf+0vQMnEnpzIop1tptIERVgR3ZeT/hHSzBNG8PaWPgxWQjqSeKCyBZSyp8uTT6eKK1pQ==`.
The model-data checker accepts schema 6 and structure hash
`68fde21cda04641d6d0b956ad5f840a7fe4adc2ebff7577fb8ccaac4e2e48a3f`.
These are real published catalog bytes, not generated stand-ins; this does not
establish equivalence to every artifact built from the donor source pin.

## HTTP credential binding in progress

Chat Completions and Responses now use the shared native lease/redactor option
through their direct, compatibility and Models stream/simple entrypoints. The
actual OpenAI SDK talks to a deterministic fake service in the tests. Every HTTP
send obtains a fresh lease use, replaces the SDK placeholder with the leased
bearer, refuses redirects and preserves the admitted endpoint. Caller or model
configuration cannot supply a competing auth header. A revoked lease
stops the next retry. Native redaction runs inside a live lease on terminal error
text; an unavailable lease produces a fixed safe message. Request
classification for ChatGPT sign-in returns only a boolean from the lease scope;
the token is not returned or cached in adapter options.

Malformed native redactors and non-callable native leases terminate before SDK
construction, payload hooks or sends. Formatting that validation error also
remains safe. The shared unsupported-API assertion stays in place for unbound
families. The serial registry handoff now includes Codex through compatibility
and Models entrypoints; every native Codex call still requires explicit SSE.

The direct Codex `stream` and `streamSimple` paths now accept native credentials
only with explicit SSE. Automatic and WebSocket transports fail before any
connection or send. Account identity is derived inside a lease; retained headers
carry a placeholder until the per-send leased fetch supplies the real bearer.
Error-event observers receive a sanitized copy of every string key and value
inside a live lease, before JSON encoding; revoked observers receive no event.
Terminal errors use the same live-lease redaction boundary as Chat and Responses.
The direct native/explicit-key conflict remains rejected before any lease/send.

Fourteen cases use the actual native resolver and OpenAI SDK with only the
remote service replaced. They reject a connection revision changed after lease
issuance and protect terminal errors and event observers before and after
revocation for both APIs. The callbacks share `redactEventWithLease`, which
sanitizes nested string keys, values and arrays without changing the parser
input. A revoked lease suppresses the observer; an in-flight result is rejected
if revocation wins before handoff. Forty-six Codex SSE cases cover direct/simple
and four public stream/simple entrypoints, transport denial, revision changes, retries and
terminal/observer redaction, including escaped diagnostic strings and keys.
All 28 added public-caller cases failed while the shared registry remained
closed; the additive Codex entry makes them pass without changing the adapter's
explicit-SSE guard. Twenty malformed-lease cases failed before adding the shared
callable `lease.use` preflight assertion. Four payload-hook transport mutations
each constructed a socket before the native SSE choice was kept fixed after
admission; all now use SSE without a socket attempt. Response-header callbacks
also use a copied, native-lease redaction boundary: three reflected-key cases
failed before the wrappers and pass after, alongside three revoked-lease cases.
All 115 focused credential/native OpenAI/Codex cases pass with these guards.
These checks replace only the remote service or SDK constructor;
they do not establish native egress authority or actual provider support.

Twelve further cases use the real Models collection and single-API provider
factories with mismatched declared APIs. They reached the wrong implementation
before native API identity checks were added at the three concrete OpenAI
adapters. They now fail before lease use, payload callbacks or fetch. The checks
apply only when native credentials are supplied; legacy custom provider routing
keeps its existing behavior. The unsupported-family fixture uses a permanently
unbound test API, an invalid remote hostname and explicit zero-fetch/ambient-auth
assertions as real families gain support.
Removing each transport, per-send lease, observer and terminal redaction guard
fails its matching test. Removing the shared sanitizer, its lease guard or any
of the three callback bindings also fails the actual observer data assertions.
The native resolver's 27 cases and the integrated store/bridge/config/snapshot
suite pass together, 110 cases after synchronizing the bootstrap dependency.
The request-port contract and its type fixture also pass, alongside 58 shared
contract cases. The 15 SessionMap cases pass in source mode with the real Pi
SessionManager; the built/installed path remains unqualified. These are local deterministic
checks, not native egress or installed-provider qualification.

The shared credential registry now lives in the already-reachable
`utils/model-operations.ts`, with the original helper export preserved. This
keeps the Models entrypoint within its existing import-graph budget. Shared test
models use their concrete API type and normalized transcript contexts. The full
vendor `npm run check` passes with TypeScript 7.0.2, original graph budgets and
browser smoke checks. No dependency, threshold or assertion is relaxed.

The `b0dde52` shared handoff adds caller-auth, custom-client and Google payload
guards. All three OpenAI adapters pass both option and model headers to that
assertion; 18 model-header cases failed before this wiring, and all 36 header
cases now pass before any lease or send. The admission fixture uses the actual
native package type declarations, built by `build:contracts`, to keep native
implementation syntax outside the donor's erasable TypeScript source closure.
The leased fetch strips the existing six known credential headers from both
Request and init headers before writing its selected auth header. Two local
socket cases failed first because a placeholder reached the server through an
alternate header; both now pass while a non-auth trace header is preserved.
Reverting that strip loop fails both wire cases. All six shared/callback
guard-removal probes fail as expected. The final selected provider/legacy run
passes 297 cases across thirteen files. One inherited Google
cross-origin redirect case remains TODO pending native egress mediation; it is
not a passing qualification result.

After consuming the declared bootstrap at `a5a3b1e`, 58 shared-contract cases,
111 store/credential/bridge cases, 55 built Pi native admission/entrypoint cases
and 15 built SessionMap cases pass locally. These establish their named module
and fixture paths, not an installed desktop or real provider result.

## Shared provider integration checkpoint

The shared handoff now includes Anthropic, Gemini, Vertex, Mistral and Pi-native;
this patch adds Chat, Responses and Codex to the same registry without removing
any of those five APIs. The stronger native credential resolver and the native
request-port interface from the declared bootstrap are retained unchanged.

Codex also rejects a non-SSE native transport before assigning the credentials
used for terminal error sanitation. The fixed refusal uses the shared
`CredentialPreflightError` marker and touches no lease, redactor, payload hook,
socket or HTTP transport, even when the supplied lease is already revoked.
Ordinary post-send errors retain native lease-scoped sanitation. The updated
fixture first failed 24 assertions with 26 controls passing; after the change,
all 50 cases pass. That preliminary run used Vitest 5.0.5. The integrated run
uses the donor-pinned Vitest 4.1.12 and passes 301 cases across 14 controlled
fixture files; the inherited Google redirect TODO remains unqualified.

The full vendor check passes with TypeScript 7.0.2, original entry-graph budgets,
browser smoke checks and no Biome fixes. The native declaration build passes
with TypeScript 6.0.3. These source and fixture results do not qualify the
native final-send composition, installed application or actual provider cells.

## Injected transport diagnostic and account boundary

Chat Completions and Responses now disable OpenAI SDK logging when an explicit
fetch transport is supplied. They also explicitly set SDK organization and
project values to null, so ambient SDK account metadata cannot enter the native
request. Native transports own diagnostic redaction and account binding; SDK
defaults otherwise bypass those boundaries. Calls without an injected transport
retain their existing behavior. The adapter change is limited to the two client
constructors; no environment variable or global SDK setting is changed.

Two cases in `tests/native-openai-chat.test.mjs` exercise the actual pinned
OpenAI SDK with a controlled service response and diagnostic collection. The
reflected synthetic marker reached SDK diagnostics before the constructor guard;
both cases pass with the guard. Two later cases independently check that ambient
organization and project values do not reach injected native request headers.
These are controlled transport fixtures, not actual-service or native-authority
qualification. The complete native consumer and its cleanup boundary are recorded in
[patch 0010](0010-native-openai-consumer.md).

## Integration still required

This is a work-in-progress adapter regression slice. Native provider admission,
credential resolution/redaction, per-send egress authority, receipt ordering,
WebSocket continuation and the real engine/packaged desktop gates remain TD-19
integration work. The bootstrap's unavailable-readiness guard remains intact.
No provider support, release readiness or CI result is claimed here. On donor
upgrades, reapply the patch and rerun the adapter, native-authority and packaged
entrypoint gates before publication.
