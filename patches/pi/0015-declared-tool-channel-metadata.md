# Declared tool channel metadata

Donor: Pi `d5b3de22d0e24a3e9c38a9410d3329b099717283`, AI package 1.4.0.
Candidate base: Splyce `135d4c3a523af63352af99ab51617deef1334e79`.

`api/openai-completions.ts` finalizes streamed tool names by removing the exact
Harmony commentary suffix only when the remaining name matches a declared tool.
Unknown names and other suffixes retain their identity and remain subject to
normal native tool admission. Arguments and approval requirements are unchanged.

The real-provider demo exposed this compatibility case before write approval.
`tests/native-openai-chat.test.mjs` reproduces the response with the real adapter:
the declared-name case failed before the patch; it and both unknown-name/suffix
cases pass after it. This fixture proves parsing, not live provider support.
`tests/native-demo-e2e.test.mjs` is the opt-in live qualification entrypoint.

On donor upgrade, replay patch 0015 after the existing patches and rerun the
adapter cases, native session/approval suites and opt-in live demo. Preserve the
previous source and engine artifact for rollback; no persisted schema changes.
