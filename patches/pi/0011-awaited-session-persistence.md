# Awaited owned session persistence

Donor ancestry: Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`,
agent and coding-agent packages 1.4.0. Preserve `vendor/pi/LICENSE` and its MIT
copyright. This patch changes no dependencies or package manifests.

## Exact source boundary

Apply `0011-awaited-session-persistence.patch` from the repository root to the
owned bootstrap base `0a700b32b0a0abe5c24194b61a854f9dd9bfe874`. It captures all
18 changed vendor paths (17 sources and one extension-runner fixture) through
frozen source commit `c2ea6a6ad267c8631de178d3cd798f3f9e9f2961`, including the owner helpers,
SessionManager, AgentSession/SDK, extension dispatcher, cache warmer, codemode
callers and export/import/diagnostic guards. It includes earlier owner-helper
changes already committed after that base. Existing patches alone are not a
claim to reconstruct this exact owned base.

The source commit is a bounded work-in-progress checkpoint. The patch excludes
root tests and integration-script changes, which remain in the owned repository.
It does not activate generation, provider requests, grants or production readiness.

## Persistence contract

A private native owner seals one immutable asynchronous persistence callback on
the same WeakMap-owned SessionManager identity. A readiness binding alone cannot
supply persistence authority. The native callback contract requires generic
sanitation plus the existing Rust-only credential-matching lane; Pi stores no
matching secrets and this patch implements no Rust credential inventory.
Unavailable authority, cancellation, revocation, invalid output or lane failure
reject with fixed `PERSIST_REDACTION_UNAVAILABLE` text and no raw fallback.

`createOwned` and `openOwned` construct inert managers, bind the owner, then
initialize through `withPersistence`. This serializes work per real manager.
Its callback runs synchronously against a deep-detached draft; thenables are
refused, draft aliases are revoked, and state/results/write plans are captured
before awaiting sanitation. Owned synchronous writes deny. Unowned donor APIs
retain their standalone behavior outside an owned stage.

Sanitation receives one complete serialized JSONL entry at a time, without its
line terminator. First flushes and rewrites qualify every row before opening or
truncating the target or publishing state. A plain append reuses the exact
previously qualified persisted prefix only while that prefix remains unchanged.
A definite encoded-string lower bound above 256 KiB rejects as fixed
`PERSIST_ENTRY_TOO_LARGE`; the native callback must also enforce the complete
encoded frame limit, including its envelope. Entries are never split or truncated.
Returned entries map to detached sanitized committed graphs, without sending a
whole history array as one sanitation frame.

The returned JSON must preserve key/type shape, session/entry ancestry, message
roles, content discriminators and tool identities. Ownership and cancellation
are rechecked after awaits and immediately before synchronous physical commit.
One transaction permits one output target. Owned getters detach live state;
exports deny owned managers and active or captured drafts before filesystem work.
Unqualified native import/replacement and diagnostic-export paths also deny.

AgentSession and SDK callers await commits before publishing messages or related
state. Extension message-end handlers first see a detached sanitized committed
message; an optional replacement must complete another sanitized rewrite before
publication. Extension dispatch, cache warming and codemode preserve awaited
refusals. Both fixed persistence codes propagate instead of becoming ordinary
extension reports or failure transcripts.

Existing-file rewrites use a same-directory exclusive temporary file and rename;
plain append keeps the append path, and first creation uses exclusive open. A
possibly partial target write fences further mutation until an explicit fresh
owned reopen. This is no fsync/crash-durability or cross-manager CAS guarantee.
Trusted in-process plugins retain operating-system authority.

## Review corrections

Same-manager `withPersistence` reentry from its own asynchronous sanitation chain
now rejects before entering the serialized queue. A private `AsyncLocalStorage`
chain guard prevents a sanitizer from waiting on its own unfinished transaction;
unrelated external callers still queue normally.

Owned opens capture canonical path, file identity, timestamps, size and bytes at
the read boundary. Mutations recheck that version before effects and rewrites
recheck immediately before replacement. A changed baseline rejects instead of
publishing stale state or erasing an acknowledged append; recovery requires a
fresh owned reopen. This is optimistic local validation, with no cross-process
atomic CAS or exclusive-writer promise. The native factory must enforce its
writer/currentness contract across the remaining final-check/write window against
foreign processes.

Custom and bash queues now drain repeatedly, and the joint drain continues until
both are empty. The final empty check and busy-flag transition share one
synchronous continuation. Failed sanitation leaves the affected batch and late
arrivals pending; successful batches are removed only after commit. These checks
cover queued transcript persistence; `waitForIdle` is not a general barrier for
every asynchronous sink.

## Canonical replay evidence

The patch was generated directly from committed Git blobs, with no candidate EOL
normalization. An isolated archive of the exact base passed
`git apply --check --whitespace=error` and strict forward application; all 18
resulting paths matched the frozen source blobs
byte for byte. Raw worktree hashes were recorded separately and happened to
match those blobs. The patch has 1,206 insertions and 260 deletions.

- Patch SHA-256: `d6356a4b8e61be76974a7d84ba83e3b11aa7d4fe281c79280f171b469cdeff8a`.
- Canonical source-manifest SHA-256: `e86816bf93d9ec7b7292cb7676204c47cae095103bc40d3883c14fb44bb440c9`.

The source-manifest digest hashes JSON containing the exact base, frozen source
commit and sorted path/status/SHA-256/byte-length/Git-blob-ID/base-membership
records. The retained local replay receipt also records each path and Git version.
On upgrade, regenerate against an explicit owned base and compare replay outputs
to `git show <source-commit>:<path>` bytes before rerunning behavioral gates.

## Local checks and outstanding qualification

At the earlier `e3fe29f` source checkpoint, the integration owner reported an
initial successful `npm run build:pi`, then successful builds with `npm run build --workspace=@earendil-works/pi-agent-core`,
`npm run build --workspace=@earendil-works/pi-coding-agent` and
`npm run build:contracts`.

Earlier component controls passed 10 source cases, 6 owner cases, 9 built JSONL/
export/import cases and 9 dispatcher cases. Two separate owner-guard cuts, one
structural-role cut and one dispatcher-refusal cut each failed as required.

The first serial combined command,
`node --test --test-concurrency=1 tests/native-persistence-owner.test.mjs tests/native-persistence.test.mjs tests/native-owned-session.test.mjs tests/native-extension-persistence.test.mjs`,
finished at 85/87. One fixture used the wrong lifecycle and was corrected to the
actual owned run-start path with public authentication denial; that isolated case
passed. The original identity-guard mutation case hit a 30-second child timeout
under resource contention in that run and in an original-order owned-session run
that finished at 62/63. Its isolated unchanged-budget rerun passed (all original
guard mutations; 180.68 seconds total); the isolated control passed in 11.28 seconds.
Those failed-run logs are retained, and isolated reruns do not change their results.

The resource-sensitive harness order was corrected by moving the existing compound
mutation block before the 62 SDK fixtures. Its body SHA-256 remained
`6b1f6b48ba8af03bceab365dc80ef50419f955d28c25e95fa42f95dd39eacc2e`. Mutation
targets, assertions and 30,000 ms child budgets were unchanged, with no skips.

The registered scripts at the earlier checkpoint passed all 97 scoped cases,
with zero failures, skips or cancellations:

- `npm run test:native-owned-session`: 63/63 passed in 119978.627 ms.
- `npm run test:native-persistence`: 24/24 compiled-module cases passed in 9543.2659 ms, followed by 10/10 source cases in 4273.644 ms.

Those TAP receipts are retained separately from the initial failed-run logs.
Public authentication denial is not authentication or provider qualification.

At intermediate source commit `0736473`, the full vendor `npm run check` passed, including
Biome (1,578 files, no fixes), pinned/runtime dependencies, TypeScript import forms,
entry graphs, install-lock comparison, `tsc --noEmit` and browser smoke. The earlier
failed check reported six fixture callbacks returning `void` instead of
`Promise<void>` and three string-template style diagnostics. The repair makes only
those six no-op callbacks asynchronous, uses three equivalent newline template
expressions, and retains Biome's type-export ordering.

The source persistence suite then passed 10/10 at that intermediate source
in 2686.537 ms, with no failures, skips or cancellations. These receipts predate
the current combined review fixes.

The affected vendor command, `node node_modules/vitest/vitest.mjs --run test/extensions-runner.test.ts`
from `vendor/pi/packages/coding-agent`, failed 56/56 in 27.10 seconds. Every failure
occurs in shared setup: the unchanged in-memory registry helper calls
`ModelRuntime.create` without a native owner, and the actual readiness guard
rejects with `SPLYCE_UNAVAILABLE` before the callbacks or assertions execute. The
runtime/helper source is unchanged from the exact base. No guard, assertion or
skip was changed to conceal this result; this vendor fixture remains unqualified.

## Current combined component evidence

At frozen source `c2ea6a6`,
`npm run build --workspace=@earendil-works/pi-coding-agent` passed and produced the
83-file, 9.1 MiB SDK bundle.
`node --import ./vendor/pi/packages/coding-agent/src/experimental/source-resolver.ts --test tests/native-session-manager-persistence.test.mjs`
passed 15/15,
including same-chain rejection, unrelated queueing, stale owned opens through
canonical and junction paths, stale-manager refusal and fresh-reopen recovery.
The first five added source cases produced one pass and four failures; a
subsequently strengthened physical-byte assertion also failed against the prior
source. Final loaded-source guard removals for the chain and file-version checks
each produced one relevant failure, with disk implementation and verifier bytes
unchanged.

The targeted actual-SDK command,
`node --test --test-name-pattern="owned SDK (drains|recovers).*awaited late persistence|owned SDK closes the final late-queue|removing late-queue drain guards" tests/native-owned-session.test.mjs`,
passed 8/8 in 23536.5698 ms, with no failures, skips or cancellations. Seven cases
cover custom/custom, bash/bash and custom/bash arrivals, refusal/recovery, and the
final microtask settlement window. The eighth requires both loaded-module guard
mutations to fail on missing persisted-message assertions. Their new child
budgets are 60 seconds; the original guard budgets remain unchanged.

The initial seven-case SDK verifier produced three passes and four missing-entry
failures. Strengthening the successive-arrival case to require four real API
messages also failed against the old SDK before the fix. This prevents a finite
extra pass from satisfying a verifier intended to require complete draining.

The complete registered scripts then passed 110/110 at the same frozen source,
with zero failures, skips or cancellations:

- `npm run test:native-owned-session`: 71/71 in 99582.4549 ms.
- `npm run test:native-persistence`: 24/24 compiled cases in 22890.8813 ms, then 15/15 source cases in 7255.7544 ms.

The complete vendor `npm run check` also passed at these final source bytes:
Biome checked 1,578 files with no fixes, followed by pinned/runtime dependencies,
TypeScript import forms, entry graphs, install-lock comparison, TypeScript 7
and browser smoke. The earlier failures remain recorded above.

Local fixtures and canonical source replay do not establish live Rust inventory,
complete native composition, installed Windows behavior, actual provider access,
release approval or complete exact-head gates. Those require separate receipts.
