# Test fixture roots

`0018-fixture-roots.patch` applies from the Splyce root after the existing Pi patches. It replaces timestamp/random temporary fixture root allocation in the affected test files with Node `mkdtempSync`, retaining fixture content, assertions and cleanup. It changes no runtime code or dependencies.

Donor: `earendil-works/pi` commit `d5b3de22d0e24a3e9c38a9410d3329b099717283`, coding-agent 1.4.0; retain `vendor/pi/LICENSE`. The patch reverses and replays cleanly on the candidate following patches through 0017.

Validation on Windows, Node 24.22.1, one worker and a 512 MiB heap: scoped Prettier and patch reverse/replay passed. The two existing auth-storage coalescing cases passed both before and after the patch in quiet runs (28 other cases filtered). Before the final auth fixture adjustment, broader fixture runs included 193 passes, 61 failures and 3 skips; 59 failures reached the native readiness guard, and two auth-storage/trust failures remain unqualified by those runs. Fixed-name temporary files and other non-root alerts are outside this patch.
