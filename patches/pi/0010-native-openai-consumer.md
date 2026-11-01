# TD-19 native OpenAI request consumer

Refs [TD-19 / issue 70](https://github.com/OctoKon/Splyce/issues/70).
Donor: Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`,
`@earendil-works/pi-ai` 1.4.0. Preserve the donor MIT license.

`0010-native-openai-consumer.patch` adds
`vendor/pi/packages/ai/src/api/native-openai-chat.ts` and exports the existing
`assertNoCallerAuthHeaders` helper for its pre-admission check. The shared helper
change is one export keyword; its header set, behavior and credential registry
are unchanged. Apply the provider patches in their recorded order: 0004, 0007,
refreshed 0006, then 0010. Native dependency
patches retain their own recorded order; this additive patch does not replace
0008 or the native owner's 0009 work. The existing `api/*` export makes the
consumer available without package, dependency, compiler or import-budget changes.

## Request lifetime

`runNativeOpenAIChat` accepts a structural `NativeOpenAIRequestPort` with an
opaque scope. The native factory owns scope identity and the request's key,
transport, signal and redactor lifetime. The consumer neither constructs a native
scope nor substitutes a retained-key lease. It supports Chat Completions and
Responses through their actual owned Pi adapters, with explicit SSE and zero SDK
retries. Unsupported APIs and invalid request contracts fail before a send.

Model and context data are copied before asynchronous admission. Event and result
strings and property names are copied through the supplied redactor before the
observer receives them. Both delta channels and live partial-content snapshots
suppress incomplete credential prefixes across chunk boundaries for representations
recognized by that native redactor. This also covers partials populated before
their start event. Tool-argument property names always use full native redaction;
prefix withholding applies only to values in live blocks. The original SDK block
identity is marked complete before an end event's pending channel is flushed or
the event is delivered. Completed public values therefore keep their full content,
while unrelated still-live blocks retain prefix protection. Observer mutations do
not alter the SDK's parse state. Dependency failures cross the boundary as fixed
diagnostic text.

Caller-configured authentication headers and credential-bearing endpoint URLs are
refused before native admission. Endpoints require HTTPS, except loopback HTTP
for local providers. Each physical request sent through the supplied native fetch
explicitly requests manual redirect handling. The native factory remains
responsible for final endpoint/model/workspace and credential qualification.

The consumer observes cancellation promises on the genuine response body and its
readers. It preserves the request body while forcing manual redirects and retains
the real response metadata and bound native methods. Before its request callback settles,
it waits for asynchronous body cancellation that the pinned SDK may otherwise
detach after an abort. This does not qualify cleanup before response acquisition;
the native physical transport owns that boundary.

## Local evidence

`tests/native-openai-chat.test.mjs` runs the actual Pi adapters and pinned OpenAI
SDK against controlled in-memory HTTP/SSE responses. The native request port is a
dependency fixture, not a substitute for native authority. The initial interface
stub passed six cases and failed fourteen. The initial cleanup checkpoint passed 26 cases:
the original twenty, two SDK diagnostic cases and four asynchronous-cancellation
cases. The four added cleanup assertions first failed while the other 22 passed;
they pass after cancellation tracking. There are no skipped or canceled cases.

An independent runtime audit reproduced the original four early-release failures
with an unchanged verifier apart from its import location. All four now keep the
port active until cancellation settles. Six further cases cover observer failure
and rejecting cleanup on both APIs. The ten-case audit observes no premature port
release or consumer settlement. Separate paced-stream and delayed-admission
fixtures cover the recognized credential representations and request snapshots.

That checkpoint passed targeted TypeScript and Biome checks, and its API entrypoint
remained within the original graph budgets. These historical results do not
establish complete checks for the newer review fixes below.

## Review fixes and required gate

The earlier review checkpoint passed 46 controlled actual-SDK cases. Six added live-content
prefix assertions first produced 26 passes and six failures. The expanded boundary
suite then produced 38 passes and eight failures before its fixes. The final
46-case verifier passed without changing its acceptance assertions to hide those
failures. It covers auth preflight, ambient SDK account metadata, malformed
redactors, terminal tool-call cleanup, endpoint restrictions, loopback local
providers and manual redirects alongside the earlier streaming and cancellation
cases.

Four further correctness cases distinguish live prefix protection from complete
tool-argument keys and completed block values. Against the prior compiled
consumer, the unchanged 50-case verifier produced 46 passes and four failures.
The corrected consumer passes all 50 controlled actual-SDK cases, preserving the
original 46 assertions and the six live-prefix cases. This is a correctness fix,
not a reduction of credential redaction. The actual final invocation of the
registered build-and-test script and complete gates is recorded separately.

`npm run test:native-openai` now builds the owned Pi packages before running this
root consumer suite. The release-gate script requires it after the vendor type
check. Script registration is not evidence that a complete new release gate has
passed; the parent integration checkpoint records those runs separately.

The updated reverse/replay of 0010, refreshed 0006, 0007 and 0004, followed by
forward replay, restores all 24 affected paths byte-for-byte. Against the prior
source checkpoint, only the two adapter constructor guards, the one shared helper
export and the new consumer differ. Twenty protected native/shared paths remain
unchanged; the helper's intentional one-keyword export is recorded separately.

The compatibility decision retains Pi's full partial-message shape for the demo.
Live progress redaction therefore copies growing content with
`O(deltas * output)` work; callers must apply an appropriate model output budget.
Incremental partial projection remains follow-up work and is nonblocking for this
bounded demo checkpoint. The two source comments remain as the compatibility
record; the later completion/argument correctness fix preserves that decision.
This is not a measured hard
transport-byte bound or general performance qualification. The complete new vendor,
native and packaged gates remain separate requirements.

## Remaining integration

This is an owned-core consumer and local regression checkpoint. The genuine
native factory must still bind its scope, current profile/model/workspace,
credential lifetime, final physical send, receipts and revocation to this caller.
The patch does not activate generation or wire a production host factory. Full
native composition, installed Windows application, actual provider service,
release and exact-head CI qualification are not established by these fixtures.
Reapply the patch and rerun the relevant consumer, native and packaged entrypoint
checks on a donor upgrade.
