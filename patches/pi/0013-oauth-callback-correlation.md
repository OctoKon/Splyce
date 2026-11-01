# Pi OAuth callback correlation

Donor: Pi commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`,
`@earendil-works/pi-ai` 1.4.0. Preserve the donor MIT license.

`0013-oauth-callback-correlation.patch` changes the existing
`startCallbackServer` in `packages/ai/src/auth/oauth/openai-chatgpt.ts`
and its existing provider test suite. Apply from the Splyce root after the
recorded donor import and earlier patches. No dependency, public API,
credential schema, token exchange or packaged-host activation changes.

The loopback callback server checks the pending login state before processing
terminal callback outcomes. Requests that do not correlate leave login active;
correlated completion retains the existing success and error handling.

Local evidence uses Node 24.22.1 and the genuine exported login entrypoint,
a real loopback HTTP listener, a token-endpoint fixture and no browser or
provider service. The three affected OAuth suites pass 35 tests. The provider
suite has 10 tests; removing the new correlation guard yields two failures and
eight passes. Restoring it returns all three suites to green. Scoped TypeScript
and Biome WASM checks pass using the unchanged vendor configuration.

Real provider authorization, the installed Windows application and exact-head
CI remain separate qualification requirements. Reapply and rerun the callback
and provider suites on donor upgrades.
