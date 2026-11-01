# Expo demo smoke runbook (V1)

**Status: presenter checklist, updated 2026-10-28 for the expo demo build. Base runbook from `origin/staging` at `44bca6b` (PR #167, written against `d0cecc6`); full-feature-path steps re-verified against demo-build source; packaged-app runtime evidence for this build n=0.** It is a presenter checklist, not a contract: it freezes no schema, command name or copy and authorizes no operation. Copy quoted below was read from `apps/desktop/src` at the commit named beside each claim: demo sources are `Itachi-1824/demo-tools@be41a02` (tool dispatch, workspace tools, approvals, provider form), `Itachi-1824/demo-memory@ef3e45b` (code index, cited memory), `Itachi-1824/agent-context-tools@bfd305b` (`code_search`, `memory_search`) and `Itachi-1824/provider-save-fix@57f5cd6` (provider-save failure copy). The pre-setup strings (header `Splyce`, nav labels, `Workspace tools unavailable`) were observed on the installed 3058 build by the backend lead, not by me; the project-line copy below was re-read from the demo source (`Itachi-1824/demo-v3@9f21210`), because that build predates it. Steps absent from `staging` are marked `(demo build only)`; if the packaged build does not show a step, fall back to the honest unavailable state and say so. Never simulate a port, a response or an approval.

## What staging actually has

The renderer, typed bridge and fixtures exist (`apps/desktop/src`, `packages/splyce-pi/src`). There is no `src-tauri` shell, native folder dialog, native credential writer, engine process or generation adapter on this commit. Therefore:

- The composer is wired to a stub: it reads "Sending is not available yet" once generation is reported ready, and `generationReady` is not reported at all yet ("Generation readiness has not been reported yet. Sending stays blocked.").
- The provider form is disabled ("The native credential writer is not available yet. Nothing can be saved.") and the Providers view says "Provider connections are unavailable: no profile service is connected."
- Approval controls are not mounted in the transcript (`showApprovalControls={false}`); a pending card reads "Approval controls are not available in this view."
- There is no `provider.configure`, workspace-choose, memory/code search or restart UI op in `CommandPayloads` (`session.*`, `approval.respond`, `workspace.select`, `config.set_profile`, `lease.*`, `engine.restart`).

On a staging-only build, only step 1 and the unavailable states of steps 2, 3 and 6 can be shown honestly. The expo build is expected to cut from the demo branches below; re-grep every quoted string against the packaged exe before the expo — a source string is not runtime evidence.

## What the demo build adds (expo 2026-10-28)

The packaged demo build installs in place over 3058 and is expected to add the full feature path exercised by the demo script below. Source-verified at the commits in the status line; runtime evidence n=0 until each step is re-run on the exe:

- **Tool dispatch bound** — `fs.read`, `fs.write`, `fs.edit` and `shell.run` wired into real sessions through the native policy (every effect gated by grants and approvals). Tool cards label the action `Read`, `Write`, `Edit` or `Run shell`; an unknown capability reads `Tool action` (`apps/desktop/src/tool-view.ts`).
- **Code search** — `code_search`, `code_outline`, `code_related`, `code_dependencies`, `code_dependents`, `code_symbol` over the workspace index.
- **Cited memory** — `memory_search` returns observations captured from earlier turns of this workspace, each listing the source event ids it cites; read-only.
- **Provider save** - the form is headed `Connect a provider` (accessible name `Provider setup`) with Endpoint URL, API family, Model ID, Context window (tokens), Max output tokens, optional `Reasoning model` / `Accepts image input`, and API key (password), submitted with `Save provider` (`Saving…` while pending).
- **Still off in 3058** — the installed build showed `Workspace tools unavailable` above the composer with tools OFF. That banner reports the current tool-port readiness; it does not establish whether the tools were included in the build. If the freshly packaged build shows it, record those steps (5 to 8 and 11) as unavailable and diagnose readiness, workspace admission and the tool bind separately — never conclude from the banner alone that the build lacks the tool code.

Everything in "What staging actually has" still applies to any build cut from `staging`.

## Build the installer (not on the demo host)

The cut needs a machine with a Windows native toolchain. The demo host has **no** `rustc`/`cargo`, **no** MSVC `link.exe` (no Visual Studio Build Tools) and **no** NSIS, so it cannot produce an installer at all. The recipe below was read from the tree at `1039b24`; it has **not** been executed end to end on any machine yet (n=0 for the build itself), so treat the first real run as the one that proves it.

Prerequisites on the build machine:

- Windows 10/11 x64 with the WebView2 runtime present. `runtime-pins.json` names the minimum (`155.0.4283.45`, `qualified: false` — read it, do not assume an older runtime is fine).
- Node `24.22.1`: `runtime-pins.json` pins the exact build and its SHA-256, `package.json` pins `engines.node` to `>=24.22.1 <25` and `packageManager` to `npm@11.19.1`. The first stage of `build:desktop` (`prepare:runtime`) downloads that exact runtime and verifies the digest, so any Node new enough to run `npm` will do — but do not pass an unverified `node.exe` to a bundle.
- Rust `1.99.1` for `x86_64-pc-windows-msvc`. It is pinned in `runtime-pins.json` and in the repo-root `rust-toolchain.toml` (`channel`, `components`, `targets`), so `rustup toolchain install 1.99.1 --profile minimal --target x86_64-pc-windows-msvc` plus a plain `cargo` is enough — `rustup` selects the pinned channel on its own. Do not substitute a distro Rust or a different stable; `.github/workflows/staging-gate.yml` installs the same toolchain and sets `RUSTUP_TOOLCHAIN=1.99.1`.
- Visual Studio Build Tools with the "Desktop development with C++" workload, so `link.exe` exists. Check before starting with `vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`; without it the build fails at link time, not at startup.
- NSIS: Tauri fetches its NSIS tooling on the first bundle; on a machine that cannot reach it, install NSIS and put `makensis` on `PATH`.

Recipe, from a clean checkout of the exact commit that will be shown:

1. `git rev-parse HEAD` — record `branch@sha`. Every later claim (screenshots, hashes, gate result) must name this identity.
2. `npm ci`
3. `npm run build:desktop`

Step 3 runs three things in order: `build:engine` (contracts, memory and index packages, the vendored Pi build, the bundled engine and its `resources/engine/manifest.json`), the renderer build (`vite build` into `apps/desktop/dist`), then `node scripts/build-tauri.mjs`. That script refuses to bundle unless the engine manifest is `schemaVersion: 1`, `piRevision: d5b3de22d0e24a3e9c38a9410d3329b099717283`, and every listed file exists with a matching SHA-256; it passes the manifest digest to Tauri as `SPLYCE_ENGINE_MANIFEST_SHA256`. A digest failure is a broken engine payload, not a bundling problem — rebuild the engine, never edit the manifest to make it pass.

`apps/desktop/src-tauri/tauri.conf.json` fixes the shipped identity: product `Splyce`, version `0.1.0`, bundle target `nsis`, `resources/engine/` mapped to `engine/`. The installer lands in `apps/desktop/src-tauri/target/release/bundle/nsis/` as `Splyce_0.1.0_x64-setup.exe`. Hash it (`Get-FileHash -Algorithm SHA256`) and install that file on the demo machine — not `vite dev`, and never a build from a commit other than the one recorded in step 1. `npm run build:desktop:e2e` is the WebDriver harness (`--no-bundle`) and produces no installer.

**CI is not a shortcut today.** On this lineage `.github/workflows/staging-gate.yml` does run `npm run build:desktop` and `cargo test` on `windows-latest` with the pinned Rust toolchain, so the app is genuinely built there — but it uploads no artifact, so the `.exe` it produced is not retrievable. On `staging` itself the same workflow has no app build at all. Until an artifact upload exists, a machine with the prerequisites above is the only way to obtain the installer.

## How to read each step

Each step lists **Action**, **Expected UI**, **Pass / Fail** and **If a port is unavailable**. A step passes only when the visible state matches and the evidence in step 12 exists. A model's narration, or a screenshot alone, never proves an effect; check the file, hash or log.

## Demo script: pre-written prompts

Type these verbatim, in order. Each names its step and the state to watch. If a step's port is unavailable, say so out loud and move to the next prompt — never paste a canned reply or hand-build a card.

| #   | Prompt (type verbatim)                           | Proves                   | Watch for                                                                                                                                                           |
| --- | ------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Say hello in one sentence.`                     | Step 4, chat streams     | Text arrives incrementally, turn ends without error                                                                                                                 |
| 2   | `Read README.txt and tell me what it says.`      | Step 5, read             | Card `Read`: Running → `OK`, answer `demo`; no approval for an in-workspace read                                                                                    |
| 3   | `Create notes.txt containing hello.` (run twice) | Step 6, write + approval | First run: `Approval required` → `Deny` → card `Denied`, file absent. Second run → `Approve once` → card `OK`, `notes.txt` contains `hello`; a third run asks again |
| 4   | `Run echo hi in the workspace.`                  | Step 7, shell approval   | `Approval required`, then card `Run shell` with `Exit code 0` and `Output preview`                                                                                  |
| 5   | `read ../secret.txt`                             | Step 8, escape denied    | Card `Denied`, `Blocked: the target is outside the admitted workspace.` (`WORKSPACE_ESCAPE`); the marker text never appears                                         |
| 6   | `Find where hello appears in the project.`       | Step 11, code search     | Read-only card, no approval, results from the workspace index                                                                                                       |
| 7   | `Search memory for demo.`                        | Step 11, memory          | Read-only card; results cite source event ids. If it returns nothing, say memory has not captured anything yet — do not improvise a result                          |

If a reply goes off-track, re-run prompt 2 (the most reliable step) rather than typing something new on stage. If Send disables mid-demo, read the composer's own status line aloud — it states the exact reason — instead of retrying blindly.

## 0. Preflight

- **Action:** install the packaged Windows build (not `vite dev`). Confirm Windows Credential Manager is reachable (open it from Start). Have a test API key for an OpenAI-compatible endpoint (revocable, low limit, never a production key), plus its endpoint URL, API family (for the expo: `openai-completions`), chat model id, context window and max output tokens from the vendor's page — all are explicit form fields, and a custom model needs both token limits (the form never guesses them; cost reads unknown for custom models). Create an empty demo folder outside any repository, seeded with nothing but a `README.txt` (content: `demo`) and a `..\secret.txt` one level above it containing a harmless marker. Confirm network to the endpoint, or run a loopback OpenAI-compatible server on `http://127.0.0.1:<port>`.
- **Do not demo:** modules/catalog install, usage view ("unavailable"), fork/export, any plugin/MCP, any cloud sync, anything this runbook marks planned that the build still shows as unavailable.
- **Expected UI:** none yet.
- **Pass / Fail:** pass when every item above exists and the key is in a password manager, not on screen or in a file in the demo folder. Fail if any item is missing; fix before going on stage.
- **If a port is unavailable:** no network means present only step 1 and say the hosted-model steps need connectivity.

## 1. Launch and readiness

- **Action:** start the packaged app on a clean profile.
- **Expected UI:** with `ports.provider`, `ports.workspace` and `ports.generation` all `false` (or unreported) the composer's Send button is disabled and the status line shows the reason: "Engine is not connected." / "Engine is unavailable." / "No session is selected." / "Generation unconfigured. Connect a provider and select a model." (engine proves generation false) / "Generation readiness has not been reported yet. Sending stays blocked." (readiness not reported; a distinct state, not "unconfigured"). Setup offers "Continue with base only", "Choose optional modules" and "Skip setup"; Setup and Modules show the label "Generation unconfigured" with its reason. App's engine notice carries the demo build's copy: "Engine Unavailable" with "The native engine is unavailable. Open the desktop app to connect your project and provider."; "Generation unconfigured" with "Generation requires a configured provider and workspace." once the engine is ready; and "Engine stopped" with "The native engine exited. Reconnect to resume or restart the app; the last transcript may be incomplete." plus a "Retry" button after a crash. On staging the same card instead reads "Engine unavailable" with "Required engine services are unavailable. Task execution is disabled."
- **Pass / Fail:** pass when Send is disabled and a reason is visible; navigation and history stay usable. Fail if Send is enabled with generation false or unreported, or if the reason is missing or wrong.
- **If a port is unavailable:** this step is the honest-unavailable demonstration. Say: "No engine is attached to this build, so it will not let me send." Do not enable anything by editing state.
- `(planned, not on staging yet)`: the engine's `readiness.ports.*` parser (noted in `App.svelte`), so the `false` versus unreported distinction cannot be shown from a real engine yet.

## 2. Provider save (`demo build only`; the staging form differs)

- **Order:** on the expo build run step 3 (Choose project) first — `Use this profile` is disabled until a project is selected.
- **Action:** open Providers, then the `Connect a provider` form (accessible name `Provider setup`). Enter Endpoint URL (`https`, or `http` only for loopback; for the expo: `https://gen.pollinations.ai/v1`), API family (`openai-completions`), Model ID (`openai/gpt-oss-20b`), Context window (`131072`), Max output tokens (`4096`), and the API key (password field); leave `Reasoning model` and `Accepts image input` unchecked. The limits note reads: "Token limits: leave both blank only for a known catalog model. A custom model needs both from your provider; Splyce never guesses them. Cost is shown as unknown for custom models." Submit with `Save provider` (`Saving…` while pending).
- **Expected UI:** success reads "Provider saved. The key went to the engine and the renderer kept nothing." and the key field is cleared. Failures read "Could not confirm the provider save. Check the provider configuration before trying again. The key was discarded from this form.", "The engine refused this provider setup. Nothing was saved and the key was discarded.", "The provider changed since this form was opened. Nothing was saved; reload and try again." or "The project changed. Select it again before configuring a provider." The key is never shown again. Then press `Use this profile` on the saved card (disabled status: "Choose a project before selecting a profile.").
- **Pass / Fail:** pass when the save succeeds, the profile card shows, `Use this profile` selects it, a Windows Credential Manager entry exists (check with `cmdkey /list`; the target name is native, do not paste the secret), and a text search of the app window and logs for the key finds nothing. Fail on any key echo, any path or query string in the UI, a profile selected without a project, or the P0 failure "Could not confirm the provider save" repeating — that is the known provider-save bug, fix it before the expo, do not work around it by pasting the key elsewhere.
- **If a port is unavailable:** the form is blocked with "The native provider setup route is not available yet. Nothing can be saved." or the save fails with one of the copies above. Show it, say setup is not working in this build, and skip steps 4 to 11. Never paste the key anywhere to work around it.
- `(staging)` — a staging-only build has the older three-field form (Name, Base URL, API key; button "Save credential") and the PR #167 copy. If the exe shows that form, use its fields instead and mark steps 2 accordingly.

## 3. Choose project (label verified on the demo build; `planned` on staging)

- **Action:** press the `Choose project` button (`Choosing…` while the dialog is open) and select the empty demo folder in the native Windows dialog. On the expo build do this before step 2's `Use this profile`.
- **Expected UI:** the project line reads `Choose project` until chosen, then the folder's display name only; the full path never appears in the renderer (title bar, tooltip or error text). The engine receives `workspace.select` with a `selectionRef`, never a path from the UI. On a staging-only build neither the `Choose project` button nor the project line exists; both come from the demo build (`apps/desktop/src/components/shell/Workbench.svelte` and `apps/desktop/src/components/Composer.svelte`).
- **Pass / Fail:** pass when the workspace is admitted and only `displayName` is visible. Fail if the absolute path, drive letter or user profile appears anywhere (title bar, tooltip, error text).
- **If a port is unavailable:** show the workspace view's step 1 state; do not type a path into any field. Say "project selection is a native dialog not in this build". The staging-only line "Ready for workspace execution." is not in the demo build — `Itachi-1824/demo-final3` asserts its absence — so never quote it as the demo state.

## 4. First chat turn streams (`demo build only`)

- **Action:** with provider, workspace and generation all ready, send "Say hello in one sentence."
- **Expected UI:** Send enables only once the three ports are true. Assistant text streams into the transcript and the turn then completes; `Esc` cancels a busy turn ("A turn is running. Press Esc to cancel it.").
- **Pass / Fail:** pass when text arrives incrementally and the turn ends without error. Fail on a non-streamed single dump presented as streaming, a hung turn, or a provider error with no honest copy.
- **If a port is unavailable:** Send stays disabled with the step 1 reason. On stage today the composer would say "Sending is not available yet". Say that; do not paste a canned reply.

## 5. fs.read inside the workspace (`demo build only`)

- **Action:** send "Read README.txt and tell me what it says."
- **Expected UI:** a tool card with action "Read", capability id, "Target" showing the workspace-relative target, state "Running" (with "Evidence: Pending - not executed") then "OK". Reads inside the admitted workspace need no approval.
- **Pass / Fail:** pass when the card ends "OK" and the answer is `demo`. Fail if an approval is requested for an in-workspace read or the card never leaves "Running".
- **If a port is unavailable:** the card renders only from engine events; with no engine there is no card. Say so; do not hand-build one.

## 6. fs.write and fs.edit approvals (`demo build only`)

- **Action:** send "Create notes.txt containing hello." Run it twice: deny first, then allow.
- **Expected UI:** card state "Waiting for approval" with the approval dialog "Approval required" (Capability, Target, Scope, Run / action, Request). The shipped dialog button is **Approve once** (not "Allow once"), with **Deny** and **Cancel**; the inline card uses **Approve** and **Deny**. Escape only dismisses, it never approves. After a decision: "Decision submitted for action ... Nothing is shown as executed until the engine reports the outcome."
- **Deny path:** card shows "Denied"; `notes.txt` does not exist (check Explorer or `Test-Path`).
- **Allow path:** card reaches "OK"; `notes.txt` contains `hello`. The grant is one-time: asking again shows "Waiting for approval" again. A reused grant reads "That approval was already used. Request the action again." (`GRANT_CONSUMED`); an action without approval reads "This action needs a one-time approval for its exact target." (`GRANT_REQUIRED`). For fs.edit a missing match reads "The text to replace was not found."
- **Pass / Fail:** pass when the filesystem agrees with the card in both paths and the second write asks again. Fail on a file written after Deny, a second write without a prompt, or a card "OK" with no file.
- **If a port is unavailable:** if the composer shows `Workspace tools unavailable`, record this step unavailable and diagnose the tool port (engine ready from step 1, workspace admitted from step 3, tool bind reported) before saying anything about the build — the banner reports readiness, not whether the tools were included. On a staging-only build the approval controls are not mounted (`Approval controls are not available in this view.`). Do not click through a fixture and call it the product.

### Mode selector (`demo build only`)

- **Source:** copy below was read from `apps/desktop/src/App.svelte`, `apps/desktop/src/components/PermissionModeSelect.svelte` and `apps/desktop/src/stores/permission-mode.ts` at `Itachi-1824/demo-final3@59a5427`.
- **Action:** find the "Supervisor" card or the compact control above the composer (label "Permission mode"), then choose "Bypass (unsafe) — needs confirmation".
- **Expected UI:** the three options are "Manual", "Auto" and "Bypass (unsafe) — needs confirmation", above a line reading "Effective: **Manual**" (only the mode name is bold). The Supervisor card carries the note "Saved for this workspace and used by new chats." Choosing bypass opens the dialog "Enable Bypass (unsafe)?" with the body "Bypass (unsafe) removes approval prompts for this session. This is a separate, explicit choice and it applies to this session only. The safe choice keeps Manual.", **Keep Manual** focused and **Enable Bypass (unsafe)** beside it. Escape, or Keep Manual, changes nothing. A requested mode reads "<mode> (pending engine) — not effective until the engine acknowledges it."; a rejection keeps the previous mode and says "The previous mode is still effective."
- **What the modes do:** Auto and Bypass auto-approve workspace file writes only. Shell runs without an approval only for the literal diagnostics `pwd` (bash) and `Get-Location` (powershell); every other command still asks. The mode is read again when the call executes, so switching back to Manual while a call is waiting denies it.
- **Pitfall:** a new chat starts in the workspace's last mode, because the note says so. Put the demo back on Manual before step 6, or say out loud which mode is active.
- **Pass / Fail:** pass when the safe button holds focus, Escape keeps the mode, "Effective" matches the engine after acknowledgement, and a non-diagnostic command still asks under Auto and under Bypass. Fail if bypass applies without the dialog, or a shell command runs without approval.
- **If a port is unavailable:** with no engine the select is disabled and the card shows "Engine unavailable; the mode cannot be changed." Say the mode selector needs the engine.

## 7. shell.run

- **Action:** send "Run `echo hi` in the workspace", then "Run a command that sleeps longer than the timeout".
- **Expected UI:** card action "Run shell", approval for the exact command, then a summary line "Exit code 0", duration in ms, bytes, "Truncated" when output is cut, and an "Output preview" block (secret-shaped text shown as `[redacted]`). Timeout reads "The command timed out and was stopped." (`SHELL_TIMEOUT`). Large output must show "Truncated" or compaction, never the full dump.
- **Pass / Fail:** pass when the exit code matches reality, truncation is flagged, and the timed-out process is gone (check Task Manager). Fail on a missing exit code, an unflagged cut, or a surviving child process.
- **If a port is unavailable:** if `Workspace tools unavailable` shows above the composer, record this step unavailable and diagnose readiness and the tool bind; the banner is not evidence about the build's contents. The denial copy is wired in `apps/desktop/src/tool-view.ts` on the demo build but needs live engine events — do not fabricate the card. Remember the shell is not OS-confined (see Known limits); never run anything destructive on stage.

## 8. Path escape is denied

- **Action:** send "read ../secret.txt".
- **Expected UI:** the card reads "Denied" with "Blocked: the target is outside the admitted workspace." and code `WORKSPACE_ESCAPE`. No content of `secret.txt` appears.
- **Pass / Fail:** pass when the card is "Denied" and the marker text never appears in the transcript, preview or logs. Fail if any part of the file is returned or an approval is offered that would allow it.
- **If a port is unavailable:** on the demo build the denial copy is wired (`WORKSPACE_ESCAPE` in `tool-view.ts`) but renders only from engine events; with tools OFF there is no card. Say so. Do not fabricate the card.

## 9. Secret hygiene

- **Action:** send one prompt containing an inert marker shaped like a secret: "remember this: sk-demo-inert-0000000000". The marker is not a credential and authorizes nothing; never paste a working provider key into a prompt. End the session, then search the persisted session JSONL and the app log folder for the marker and its first 12 characters (for example `Select-String -Path <session dir>\*.jsonl -Pattern sk-demo-inert -SimpleMatch`).
- **Expected UI:** the renderer redacts secret-shaped text (`sk-...`, bearer tokens, `api_key=...`) in tool text as `[redacted]`. Persisted transcripts must contain neither the marker nor its prefix.
- **Pass / Fail:** pass when the search finds nothing in the transcript, logs, crash dumps and `%APPDATA%` app data. Fail on any hit: stop the demo and file a security issue, because the same path would have persisted a real key; there is nothing to rotate, since the marker is inert, so a hit is a defect to record, not a leak to clean up. Note: renderer-side redaction is defence in depth only; persistence redaction is `(planned, not on staging yet)`, so a hit on the unredacted prompt text is a known gap to record, not hide.
- **If a port is unavailable:** skip, say so, and do not claim hygiene is proven.

## 10. Crash and restart recovery (`planned, not on staging yet`)

- **Action:** start a long turn, then end the engine process in Task Manager mid-turn.
- **Expected UI:** the run reads "The engine stopped unexpectedly." (`ENGINE_CRASH`), in-flight actions show "Uncertain" or "Canceled" (an unconfirmed effect reads "The effect could not be confirmed. Check the target before doing anything else."), the transcript marks "Stale", and a restart offer appears (`engine.restart` exists in the contract; no restart UI is on staging). After restart the stream resyncs from the durable cursor.
- **Pass / Fail:** pass when no duplicate file or command effect exists after restart (compare `notes.txt` and process list) and no action is shown "OK" without an outcome. Fail on a duplicate effect, a silently resumed write, or a UI frozen on "Running".
- **If a port is unavailable:** do not kill anything. Say the recovery path is not exercised end to end in this build; point to the state labels, not a live run.

## 11. memory_search and code_search (`demo build only`; tools wired on the demo branches)

- **Action:** ask "Find where `hello` appears in the project." (code_search), then "Search memory for demo." (memory_search).
- **Expected UI:** read-only tool cards (no approval). `code_search` searches the workspace index (camelCase/snake_case aware; exact phrase in double quotes; `pathGlob` filters). `memory_search` returns observations captured from earlier turns, each citing its source event ids.
- **Pass / Fail:** pass when results come from the real index with a card per call and nothing written. Fail on a write, an approval for a read, or results invented by the model. If `memory_search` returns nothing, say memory has not captured anything yet — an empty result is honest, a made-up one is not.
- **If a port is unavailable:** if `Workspace tools unavailable` shows or the tools are not bound, record this step unavailable and diagnose readiness and the bind; do not say the build lacks the search tools on the banner's word alone. Skip the step; an honest gap beats a fabricated result.

## 12. Shutdown, cleanup and evidence

- **Collect before deleting anything:** screenshots for each passed step (window title bar visible, no key), `Get-FileHash -Algorithm SHA256` of the installer, of `notes.txt` (hash it while the folder still exists) and of the engine manifest the build printed (`ENGINE_MANIFEST_SHA256` from `npm run build:engine`), the installed version string, the exact `branch@sha` the installer was built from (`git rev-parse <branch>`, plus the gate PR's head if the cut included one — a bare `origin/staging` ref does not identify a demo-branch build), the session JSONL hash, the step 9 search output, and the pass/fail row for each step.
- **Action after collecting:** close the app; confirm no engine child process remains. Delete the demo folder and remove the recorded credential in Credential Manager. Revoke the test key used in step 2 at the provider.
- **Pass / Fail:** pass when no process, credential or file remains and the evidence set is complete, with provenance that names the packaged commit. Fail if a process survives, the credential remains, or the only revision recorded is a ref that does not name the built commit.
- **If a port is unavailable:** record "step N unavailable (port: name)" in the evidence set. An honest gap is acceptable; a missing record is not.

## Known limits

- One workspace at a time; profile scope equals `workspaceId`. Switching workspaces is not demoed.
- No fork and no export in V1 (the `session.fork` op exists in the contract but is not a demo path).
- The shell is not OS-confined: protection is exact-command approval only. Treat any approved command as running with your user rights.
- Providers: OpenAI-compatible endpoints only. No automatic provider or model fallback.
- Credentials live in the native store; the renderer never holds them.
- Usage, modules install and the memory export are not demo paths.

## Go / No-go

| Check                                                | Go                                                            | No-go                                               |
| ---------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| Packaged build, Credential Manager, key, demo folder | All present                                                   | Any missing                                         |
| Tools bound in the packaged build                    | No `Workspace tools unavailable` bar; prompt 2 returns `demo` | Banner present while steps 5-8, 11 are claimed live |
| Step 1 readiness (Send disabled with reason)         | Reason visible                                                | Send enabled while a port is false                  |
| Steps 2, 3 (credential store, project dialog)        | Native, no key or path in UI                                  | Any echo of key, path or `credentialRef`            |
| Steps 6, 8 (approvals, path escape)                  | Filesystem matches the card                                   | File written after Deny, or escape read             |
| Step 9 secret hygiene                                | Zero hits                                                     | Any hit                                             |
| Step 10 recovery                                     | No duplicate effect                                           | Duplicate effect or frozen "Running"                |
| Any step whose port is unavailable                   | Shown as honest unavailable, not live                         | Faked, mocked or narrated as working                |

If steps 2 to 7 cannot run live, the decision is to demo step 1, the project and provider setup (steps 2, 3) and the unavailable states only, then say plainly that the end-to-end loop is not in this build; drop the matching prompts from the demo script rather than typing them and waiting. Do not present fixtures, the prototype under `apps/desktop/prototype` or recorded output as the product.
