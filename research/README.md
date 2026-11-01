# Splyce research

[TD-11 build preparation](docs/foundations/td11-build-preparation.md) collects dated runtime, Windows/WebView, build and license inputs; it is a proposal, not a qualified build.

The evidence base for a Windows desktop Pi-derived coding-agent application: OSS, barebones modular installation, local application/state and user-selected local/cloud inference. Snapshot: **2026-10-26**. Sources describe mechanisms, not implemented Splyce behavior. [Desktop stack](docs/foundations/desktop-stack-decision.md), [module installation](docs/design/modular-installation.md), [profiles](docs/design/providers-profiles-and-sessions.md), [core fusion](docs/design/core-fusion.md), [desktop application](docs/design/desktop-application.md) and the [delivery plan](docs/design/team-delivery-plan.md) connect the catalog to ownership, tests and unresolved gates.

| Start here                                   | Contents                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Complete document map](docs/README.md)      | Every research chapter in one compact table                                                                     |
| [Frontend dossier](docs/frontend/README.md)  | Codex-led workbench, Claude interaction patterns, components, Windows accessibility and rendering qualification |
| [Agents and products](docs/agents/README.md) | Terminal CLIs, IDE agents, hosted products, forks and chained gap sweeps                                        |
| [Foundations](docs/foundations/README.md)    | Pi, the Windows desktop stack, harnesses, frameworks and workflow scaffolds                                     |
| [Capabilities](docs/capabilities/README.md)  | LSP, graphs, cross-session memory, retrieval, inference, protocols and evaluation                               |
| [Design](docs/design/README.md)              | Desktop/core contracts, delivery plan, qualification and audit                                                  |
| [Governance](docs/governance/README.md)      | Repository controls, fleet management and policy boundaries                                                     |
| [Supplied imports](imports/README.md)        | Original PDF, provenance and claim review                                                                       |
| [Web compendium](site/README.md)             | Supplied HTML and deployment scope                                                                              |
| [Evidence](docs/evidence/README.md)          | Machine-readable public primary-source ledgers                                                                  |

[Methodology](docs/methodology.md) explains evidence depth and coverage limits. [Candidate catalog](docs/catalog.md) maps names to layers. The root [master plan](../MASTER-PLAN.md) translates the findings into contracts, implementation phases and acceptance gates.

The [runtime lineage review](docs/foundations/additional-runtimes-and-lineage.md#open-interpreter-current-rust-fork-and-legacy-identity) now separates current Rust Open Interpreter from its legacy Python lineage and evaluates its Workstation client as a source-level comparator; neither changes the selected engine or frontend stack.

The [composition contract](docs/design/core-fusion.md#composition-acceptance) links donor mechanisms to one native authority, selected-configuration interaction/sequence coverage, retention and whole-task contribution trials. Components are not assumed to compose safely or profitably.

Discovery remains open when a sweep finds another eligible candidate. See the dated [gap journal](docs/agents/gap-sweep-candidates.md); no global-exhaustiveness claim is made. Runtime, retrieval and inference qualification still require actual tests.

The [TD-04 provider proposal](docs/design/provider-matrix-proposal.json) inventories all ten chat, four classifier and one image API at the pinned Pi revision. Its [21-source verification ledger](docs/evidence/td04-provider-source-verification.json) separates observed request/result/usage/cancel behavior from Splyce admission requirements and unrun provider qualification.
