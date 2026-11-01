# Public-source evidence ledgers

Each JSON file is an array of source records. Required fields: `id`, `tool`, `url`, `title`, `accessed`, `claims`, `verification`, and `notes`. URLs identify public primary documents. Access dates describe this research snapshot; they do not pin a release or prove runtime behavior.

| Ledger                                                 | Coverage                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| [skill-sources.json](skill-sources.json)               | Skill authoring, diagnosis, Rust checks and focused workflow references |
| [stack-sources.json](stack-sources.json)               | Rust host, storage, protocols, context and model-service choices        |
| [terminal-sources.json](terminal-sources.json)         | Terminal agents                                                         |
| [ide-platform-sources.json](ide-platform-sources.json) | Editors and hosted platforms                                            |
| [recursive-sources.json](recursive-sources.json)       | Harness² and DeepSeek Harness                                           |
| [framework-sources.json](framework-sources.json)       | Runtimes and orchestration                                              |
| [workflow-sources.json](workflow-sources.json)         | Spec and delivery scaffolds                                             |
| [context-sources.json](context-sources.json)           | Language/code intelligence and memory                                   |
| [sparse-sources.json](sparse-sources.json)             | Sparse representations and coordination                                 |
| [protocol-sources.json](protocol-sources.json)         | Interoperability, execution and evaluation                              |
| [internals-sources.json](internals-sources.json)       | Additional capabilities and optimizers                                  |
| [gap-sources.json](gap-sources.json)                   | Discovery and identity gap closure                                      |
| [memory-sources.json](memory-sources.json)             | Cross-session memory, model roles and graph-name resolution             |
| [inference-sources.json](inference-sources.json)       | Local/cloud inference runtimes and deployment layers                    |
| [readme-sources.json](readme-sources.json)             | Public README visual/editorial references                               |
| [governance-sources.json](governance-sources.json)     | Governance/fleet candidates, repository roles and fork contribution     |

The validator checks record shape, URL form, dates, claims, and local documentation links. It cannot establish that a paper's conclusion is true, that a vendor implemented its documentation, or that a configuration is safe. Qualification requires a pinned artifact and actual tests.

| Additional chapter / ledger                                            | Coverage                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [pi-sources.json](pi-sources.json)                                     | Pi/OMP foundation documentation and runtime metadata                                 |
| [pi-source-sources.json](pi-source-sources.json)                       | Pinned Pi implementation paths and source-observed semantics                         |
| [lightweight-runtime-sources.json](lightweight-runtime-sources.json)   | Pinned README, manifest, license, provider and seam sources for seven comparators    |
| [lineage-sources.json](lineage-sources.json)                           | Additional major runtime families and license lineage                                |
| [import-closure-sources.json](import-closure-sources.json)             | Selected-source follow-up for imported claims                                        |
| [platform-sources.json](platform-sources.json)                         | Host security and release mechanisms                                                 |
| [workflow-engineering-sources.json](workflow-engineering-sources.json) | Agent evaluation, workflow engineering and constrained interaction/sequence coverage |
| [evidence-efficiency-sources.json](evidence-efficiency-sources.json)   | SCIP, TOON, contradictory notation research and SQLite durability                    |
| [store-qualification-sources.json](store-qualification-sources.json)   | J0 store candidates, Node/better-sqlite3 surface and SQLite durability semantics     |
| [tool-execution-sources.json](tool-execution-sources.json)             | Filesystem, shell, process and remote execution                                      |
| [computer-access-sources.json](computer-access-sources.json)           | Browser, desktop, device and connector implementations                               |
| [competitive-sources.json](competitive-sources.json)                   | Direct competitor mechanism and limitation chains                                    |
| [claude-product-sources.json](claude-product-sources.json)             | Official Claude and Cowork capabilities and boundaries                               |
| [r32-sweep-sources.json](r32-sweep-sources.json)                       | R32 harness lifecycle, agent-technique and combined Codex/Claude UX sources          |
| [memory-review-sources.json](memory-review-sources.json)               | Pinned current memory implementations and counterevidence                            |
| [document-multimodal-sources.json](document-multimodal-sources.json)   | Document, OCR, visual retrieval, audio and rendering tools                           |
| [codex-product-sources.json](codex-product-sources.json)               | Official Codex/OpenAI capability, client and local-provider documentation            |
| [efficiency-sources.json](efficiency-sources.json)                     | Recursive improvement, caching, decoding and host measurement                        |
| [failure-mode-sources.json](failure-mode-sources.json)                 | Primary studies and engineering sources for agent limitations                        |
| [decision-model-sources.json](decision-model-sources.json)             | Laya, D3, pinned implementations/licenses and counterevidence                        |
| [forecasting-sources.json](forecasting-sources.json)                   | Timestral source/weight rights, implementation and alternative models                |
| [desktop-stack-sources.json](desktop-stack-sources.json)               | Windows GUI stack, Tauri/Svelte/Vite/Node and desktop E2E provenance                 |
| [cloud-lifecycle-sources.json](cloud-lifecycle-sources.json)           | Provider profile, egress, cancellation and retention lifecycle sources               |

[pi-package-sources.json](pi-package-sources.json) records PKG-01–PKG-10: pinned Pi package commands, source resolution, resource loading, settings persistence and reload lifecycle. The [package audit](../foundations/pi-package-installation.md) separates source findings from unrun installation/cleanup tests.

[pi-provider-session-sources.json](pi-provider-session-sources.json) records PST-01–PST-14 for pinned Pi provider/session contracts. [provider-api-sources.json](provider-api-sources.json) records PAPI-01–PAPI-12 for official wire-protocol references and the [API conformance matrix](../capabilities/provider-api-conformance.md). Record counts are provenance counts, not supported-provider or runtime-test counts.

[desktop-stack-sources.json](desktop-stack-sources.json) records DESK-01–DESK-23 for the locked Windows GUI stack. [cloud-lifecycle-sources.json](cloud-lifecycle-sources.json) records cloud-profile lifecycle sources. Neither ledger establishes an installed application, provider support, or remote-operation behavior.

[frontend-sources.json](frontend-sources.json) records FUI-01–38 for the dedicated interaction/component/Windows/rendering dossier. [codex-foundation-sources.json](codex-foundation-sources.json) records CFND-01–09 for the source-pinned Codex engine assessment. Counts are provenance records, not supported features or runtime results.

[Main research index](../../README.md) · [Complete document map](../README.md)

[lineage-sources.json](lineage-sources.json) now includes LN-11–17 for separately pinned current Open Interpreter and Interpreter Workstation, their licenses/manifests and provider-wire boundaries. Legacy Python identity, vendor claims, source observations and unrun installed/quality results remain distinct.
[td11-build-sources.json](td11-build-sources.json) records BUILD-01–05 for [TD-11 preparation](../foundations/td11-build-preparation.md): Node schedule/security, Tauri installer/WebDriver and MXC Windows support sources. These are documentation observations, not packaged-runtime results.

[td04-provider-source-verification.json](td04-provider-source-verification.json) records TD04-01–21: immutable Pi adapter and shared-type observations behind the [TD-04 provider proposal](../design/provider-matrix-proposal.json). All 15 API IDs are inventoried; source verification does not establish installed provider support.
