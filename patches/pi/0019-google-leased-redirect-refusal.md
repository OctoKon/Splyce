# TD-13 Google and Vertex leased redirect refusal

Refs [issue 138](https://github.com/OctoKon/Splyce/issues/138) (TD-13 / TD-20).
Donor: Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`, `@earendil-works/pi-ai` 1.4.0, `@google/genai` 2.21.0.
Preserve the donor MIT license. Apply `0019-google-leased-redirect-refusal.patch` from the Splyce root after 0004, on
`Itachi-1824/td07-11-bootstrap` at `4ab0b7a`.

With native credentials the Google and Vertex adapters hold the leased key for one SDK attempt. The pinned SDK follows
redirects inside its own fetch call, so a redirect from the admitted endpoint carried `x-goog-api-key` to the other
host. The SDK does not accept an injected fetch, so the patch wraps the per-attempt client's `apiClient.apiCall` to
force `redirect: "error"`, keeping every other request option. A client that lacks that seam is refused before any send.

## Local evidence

- `packages/ai/test/splyce-credentials-wire.test.ts` runs the real pinned Google and Vertex SDKs against a local server
  answering 307/302 to a second local origin. The leased send reaches the admitted origin with the key, the redirect
  target sees no request, the result is `error` and contains no secret. With the adapter wiring reverted both cases
  fail (2 failed, 13 passed); with it the file passes 15/15. Unit cases pin the wrapper and its fail-closed refusal.
- `packages/ai/test/splyce-credentials.test.ts` 65/65 (its `GoogleGenAI` mock now carries the `apiClient.apiCall` seam).
- `google-vertex-api-key-resolution`, `google-raw-stop-reason`, `retry` and `fetch-option` suites pass unchanged.
- Model data was hydrated with `node scripts/update-model-catalog-pin.mjs --hydrate-pinned` (pinned revision in
  `nix/model-catalog.json`) for the catalog-dependent cases; the redirect cases use catalog-free inline models.

## Limits

This is an SDK-seam guard pinned to `@google/genai` 2.21.0; re-verify the seam after any SDK update (the guard refuses
sends if it disappears). It does not add per-hop host allowlisting; it refuses every redirect on leased Google/Vertex
sends, matching `createLeasedFetch` on the other providers. The native transport's final per-send check stays in place.
