# Test fixture roots

`0014-test-fixture-roots.patch` applies from the Splyce root after the existing Pi patches. It updates the package manager, resource loader and tool test fixtures to create each temporary root atomically with Node's `mkdtempSync`. Fixture contents, assertions and cleanup remain unchanged. No runtime code or dependencies change.

Donor: `earendil-works/pi` commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`, coding-agent 1.4.0; retain `vendor/pi/LICENSE`.

Regression entrypoints: `packages/coding-agent/test/package-manager.test.ts`, `resource-loader.test.ts` and `tools.test.ts`. Node 24.22.1 on Windows: 207 passed, 66 failed, 2 skipped. Failures include the native readiness guard, Windows-specific expectations and unavailable `fd`; these suites are not qualified by this run. Generated model data passed its pinned validation.

The same three suites run against commit `3e891351` with the same runtime, dependencies and temporary-directory environment also produced 66 failures, 207 passes and 2 skips. All 66 failed test identities and the 63 reported error lines matched after normalizing fixture names. The changed files were restored byte-for-byte. A focused run of the existing read, write and edit fixture cases passed 3 tests; 83 other cases were filtered out.
