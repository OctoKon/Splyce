# Bootstrap release smoke

This runner uses the real uninstrumented Windows executable and its bundled Node
engine through external `tauri-driver`. It never starts a dev server, substitutes
IPC, adds capabilities or treats missing tools/app as a pass. It is the bootstrap
native-core-ready/generation-unconfigured and child-exit subset, not full TD-11 or UI qualification.

Run from the repository root after building the release app and staging its engine
resources beside the executable. The preparation script rebuilds the pinned
`tauri-driver`, selects the Microsoft WebDriver for the registered Evergreen
WebView2 runtime, and writes a per-run provenance manifest before the smoke starts:

```powershell
& tests/bootstrap/prepare-release-drivers.ps1
& apps/desktop/src-tauri/resources/engine/node.exe tests/bootstrap/release-smoke.mjs
```

`SPLYCE_SMOKE_APP` can select an installed release executable. The default is
`apps/desktop/src-tauri/target/release/splyce-desktop.exe`; testing that build is
packaged-resource evidence, not installer/uninstall evidence. Ports 4444 and 4445
must be free. Run in an interactive Windows desktop session. The runner closes
only its own app and driver process tree; its crash case terminates the confirmed
direct bundled Node child, never an ambient Node process. Screenshots, process
identities, artifact hashes, failures and driver logs remain under ignored
`apps/desktop/src-tauri/target/bootstrap-smoke/`.

The production DOM must expose `data-connection-state` and validated
`data-readiness-policy/store/receipts` on `[data-testid="app-shell"]`, an unavailable
banner headed **Generation unconfigured**, all three native core readiness values
`true`, no workspace view, and disabled **Send** even with a nonempty draft. The
native lifecycle's disconnected state must show **Engine stopped** and keep Send disabled.
These reflect real application state; no test-only IPC is required. The native
`send` command rejects the malformed `{op:'session.start',payload:{protocolVersion:0}}`
arguments with `POLICY_DENIED` before forwarding to the engine. Smoke uses this
no-dialog denial probe instead of opening the workspace picker, then rechecks the
unconfigured state. These expectations target the protocol 2 native bootstrap
checkpoint; the older core-unavailable app must fail. This does not qualify
general filesystem/tool effects or native UIA accessibility.

CI runs Pi's build-only `--hydrate-pinned` command before the offline build. It
fetches the immutable revision in `vendor/pi/nix/model-catalog.json`, verifies
its bytes against that SHA-256 revision, and uses Pi's existing hydrator. It
does not refresh or change the pin from the live models.dev catalog.

## Qualified tool inputs

The [official Tauri overview](https://v2.tauri.app/develop/tests/webdriver/) and
[manual setup](https://v2.tauri.app/develop/tests/webdriver/manual-setup/) allow a
custom W3C protocol harness. Node's standard `fetch` avoids another client package.
The locked embedded WebdriverIO route remains required separately; this external
release smoke does not replace it.

- Node **24.22.1**: the repository's packaged engine runtime.
- `tauri-driver` **2.1.0**, the stable 2.x crate from the
  [official Tauri repository](https://github.com/tauri-apps/tauri), licensed
  **Apache-2.0 OR MIT**. The source archive SHA-256 is pinned in
  `tauri-driver-inventory.json`. The helper installs it with the published crate
  lockfile and verifies the cached archive against that pin before recording the
  build's executable hash in `target/smoke-tools/driver-manifest.json`. Each run
  uses a new isolated Cargo home so Cargo cannot reuse an unpacked, locally
  modified source tree. CI runs archive-path and BOM-free manifest regression
  checks before preparing the drivers:

  ```powershell
  & tests/bootstrap/prepare-release-drivers.ps1 -TestOnly
  & tests/bootstrap/prepare-release-drivers.ps1
  ```

  `tauri-driver-inventory.json` records package versions, licenses, repositories
  and the selected crate checksum. Original crate licenses and lockfile remain in
  the Cargo registry install sources. The driver has no version flag, so the smoke
  binds its executable bytes to the verified source pin and per-run manifest.

- Microsoft Edge WebDriver is selected from the
  [official download page](https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver)
  for the registered Evergreen WebView2 runtime. Microsoft's
  [matching rule](https://learn.microsoft.com/en-us/microsoft-edge/webdriver-chromium/)
  requires the first three version components to match. The helper downloads the
  x64 archive, records its URL and SHA-256, and records the extracted executable
  SHA-256 in the per-run manifest. The smoke rechecks those bytes and versions,
  then confirms the packaged app starts the registered WebView2 runtime. Microsoft
  software terms apply to the driver; bundled third-party notices remain in the
  extracted directory and are not relabeled MIT.

The release runner checks driver archive and executable hashes before execution
and records the app hash and runtime version. No tool downloads occur inside a
smoke run.

The separate `sreerevanth/td11-ci-portability` branch retains the failed CI
comparison: two diagnostic smoke runs compare a new WebView2
user-data folder with no additional browser arguments against another new folder
with only `--disable-gpu`. Both use the same app and driver closure, capabilities,
assertions and 20-second request budget. The `release-smoke-comparison` artifact
labels each run and contains only the existing sanitized result and driver log.
These runs do not change the primary failure or establish final acceptance; a
passing fresh-profile baseline would also leave GPU causality unresolved.

On failure, a read-only helper observes token elevation for each owned app process,
checking its creation timestamp on the same process handle before reading its token.
Inspection failure is `unknown`, never an unelevated result. The WebView diagnostic
also records command count and booleans for `--disable-gpu` and an exact requested
profile-folder match, without exporting command lines, process IDs or folder paths.
Requested environment overrides alone do not prove uptake:
[Microsoft documents that elevated hosts ignore WebView2 environment overrides](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags).
These observations do not change launch settings or establish the failure's cause.

That portability branch also retains a **Documentation quality** token-observation
job for manual dispatch. This native harness branch does not add those workflow
jobs. The helper can run
with `-Details` and records elevation type (1 default/no linked
token, 2 full, 3 limited) and linked-token handle availability, then closes that
handle. It never uses the token to launch a process or changes runner policy.
These runner-process facts are prerequisites for evaluating a limited-token
launch, not proof that such a launch works or that the packaged smoke passes.

Self-check the fail-closed readiness assertions:

```powershell
node --test tests/bootstrap/release-smoke.test.mjs
node --test tests/bootstrap/hydrate-pinned-model-data.test.mjs
```

The embedded route uses the build owner's WebdriverIO/service/test-plugin pins
and separate Cargo `e2e` feature. Both embedded and external smoke must run on the
same final native candidate; unit assertions do not qualify packaged behavior.
This harness change adds no automation permissions or release capabilities.
