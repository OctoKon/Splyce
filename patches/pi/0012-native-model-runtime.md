# Owned native model runtime

Donor: Pi `d5b3de22d0e24a3e9c38a9410d3329b099717283`, coding-agent 1.4.0.
Preserve its MIT license and notices. This patch adds no dependencies.

`0012-native-model-runtime.patch` records the `ModelRuntime` changes against
Splyce source `66b9b9e`, after the owned-readiness and native-consumer patches.
Apply from the repository root. Patch 0011 is reserved for the separate awaited
persistence change; its complete series replay must be verified during integration.

## Native path

Registration requires the existing sealed runtime owner and returns an awaited
promise. The registered provider checks credential presence through the private
native service; it does not resolve a secret in `ModelRuntime`. Availability and
request preparation check current ownership around that asynchronous operation.
Requests must match the registered provider, model, API and base URL. Caller
authentication, environment, header and transport overrides are rejected.
Native refresh stays offline and propagates failures without detached promises.

The native provider adapter consumes the actual OpenAI SDK inside the existing
`NativeProviderRequests` lifetime. Its terminal event is published after reader
cleanup, credential close and the durable outcome. The factory remains responsible
for genuine admission and the immutable model/context snapshot.

## Local evidence and integration limits

The coding-agent build and runtime/owned-session/entrypoint tests passed 78/78 at
the source checkpoint. Four independent guard-removal checks cover ownership,
endpoint identity, request overrides and missing credential presence.

At source `1fdd244`, the actual sealed runtime, native provider adapter, policy,
Store, private credential-control protocol and local HTTP fixture pass the
12-case SDK composition suite. That suite checks the system prompt on the wire,
exact available models, denied model/API/URL changes, and completion ordering.
It does not exercise the Windows credential store or public `Session.prompt`.

The SDK caller must await native registration and omit an unused header hook.
The adapter currently accepts only a cancellation signal. Supported request
options and native session/tool wiring remain integration work. Legacy auth and
extension paths stay unavailable. Installed-app, live-provider and exact-head CI
qualification are outstanding.

Reapply the series to a clean pinned donor on upgrade, rebuild the real packages,
rerun the behavioral and guard-removal cases, and qualify the installed entrypoint
before publication. Keep the prior source and artifact for recovery.
