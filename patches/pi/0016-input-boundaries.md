# Input boundaries for pinned refs and JSON members

`0016-input-boundaries.patch` applies from the Splyce root after the existing Pi patches. It keeps pinned Git refs that start with an option marker out of every package-manager command path, before clone, fetch or checkout. It also reads only own JSON members during recursive tracked updates, so an inherited property cannot become an update target. Ordinary Git refs and JSON members retain their behavior.

Donor: `earendil-works/pi` commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`, coding-agent and durable 1.4.0; retain `vendor/pi/LICENSE`. Owned fork symbols: `DefaultPackageManager.parseSource` and `assignJson`.

Regression entrypoints: `packages/coding-agent/test/package-manager-ref-boundary.test.ts` and `packages/durable/test/harness-json-boundary.test.ts`. On Windows with the pinned Node 24.22.1, the focused coding-agent test passed 2/2, and the durable boundary plus existing partial-change tests passed 8/8 using the workspace source alias config. Removing either guard caused its dedicated negative test to fail, then the guard was restored. The package-manager test covers the source parsing route; no remote package installation or packaged desktop run is claimed.
