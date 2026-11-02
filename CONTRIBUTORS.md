# Contributors

The GitHub contribution graph under-counts several members. PRs are squash-merged, and some members' work reached `staging` through PRs opened by someone else when their agent had no GitHub credentials, so the merge is credited to the opener. This page records who did the work. It covers only facts that can be checked against branch names, PRs and review threads; corrections go through a normal PR.

Last updated: 2026-10-28.

## Work merged under another member's name

These PRs were opened by one member for a branch written by another. The branch prefix shows the author.

| Author                                                     | PRs opened on their behalf                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [@syed-sufiyaan1207](https://github.com/syed-sufiyaan1207) | #123, #130, #132, #134 (opened by @Itachi-1824); #140, #141, #142, #143, #144, #145, #148, #149, #150, #151 (opened by @dnarsh) |
| [@ShlokShah01](https://github.com/ShlokShah01)             | #127, #135, #146, #156 (opened by @Itachi-1824)                                                                                 |

## Contributions by member

Each member works with AI coding agents; work is credited to the member whose agent did it.

### [@Itachi-1824](https://github.com/Itachi-1824) — backend and logic lead

- Integration of the bootstrap branch: native host, Store, event ledger, policy and receipts.
- Workspace admission and grant records with single-use grant consumption, and native policy wiring.
- Memory (lexical, entity-graph and dense retrieval) and the code index.
- Worktree manager for subagents and the atomic provider setup commit.
- Backend contract decisions and security-tier reviews across the backend PRs.

### [@MdSiddiqx](https://github.com/MdSiddiqx) — UI/UX lead

- Design authority for the desktop app; client and fixture contracts (TD-02, TD-06) in #29 and #30.
- Frontend entry scaffold, engine store and approval card (#32, #33).
- TD-34 GUI fixtures (#147), brand assets (#158) and composer readiness wiring (TD-71, with @ShlokShah01).
- Frontend reviews and design direction for the other UI work.

### [@dnarsh](https://github.com/dnarsh)

- TD-19 OpenAI-compatible native chat consumer with credential and redaction hardening.
- TD-26 provider profiles, including the `modelId` binding and its control-character validation.
- Workspace file and shell tools for the agent (#155, closed and carried into the open #161), the read-path CodeQL fix and receipt redaction.
- Credential-lease hardening for the Anthropic, Google and Mistral adapters (#113, #116; open, targeting the bootstrap branch).
- Shell output compaction (prototype, not merged) and the provider setup design note.
- Tier-1 and Tier-2 reviews of the native bootstrap, memory, code index, TD-19, TD-25 and #147.

### [@lapsecoder](https://github.com/lapsecoder)

- TD-15 desktop bridge ledger and resync work (#152, closed; continued in the open #159).
- TD-25 recovery fail-closed corrections (#157, open, in review).
- TD-22 Bedrock and Azure adapters (branch, in review).
- Independent reviews of the code index, grants store and workspace tools.

### [@syed-sufiyaan1207](https://github.com/syed-sufiyaan1207)

- Approval UI (TD-30), navigation actions (TD-33), setup and app wiring (TD-29).
- Provider view hardening and credential form (TD-17, TD-16), optional-state help (TD-68) and UI state coverage (TD-76).
- Fourteen of these merged through PRs opened by other members (see above).

### [@ShlokShah01](https://github.com/ShlokShah01)

- Tool activity cards (#156), approval prompt (#160), contrast and theme (#127), specialist model UI (#135) and accessibility gate (#146).
- The TD-34 fixture fixes that unblocked #147, and the subagent merge-back review UI.
- Frontend reviews across the UI PRs.

### [@sreerevanth](https://github.com/sreerevanth)

- TD-11 CI portability investigation (#77), including the elevated-runner diagnosis.
- Independent review of the native Store bootstrap guards and the installed-app UI test matrix.

### [@dhanushbs10](https://github.com/dhanushbs10)

- The original Splyce UI/UX prototype (#4).
- GUI work in #40, #51 and #53, the TD-55 prototype-key guard (#162) and the UI styling update (#163).

## Keeping this accurate

- When you open or merge a PR for someone else, add `Co-authored-by:` trailers for every real author so GitHub credits them.
- Each member's agent should open PRs under that member's own account.
- Add missing contributions here with a link to the branch, PR or review.
