# Store qualification

**Status: proposed, unrun — runtime evidence n=0.** TD-03 (owner `lapsecoder`) selects the J0 store direction and freezes the experiment that TD-09 must run before C1/C2 depend on it. Nothing here is a measured durability, latency or throughput result, and the recommended store is not qualified until `J0_store_contract` passes on the pinned Windows artifact. Authority stays with the [storage and provider qualification](implementation-contracts.md#storage-and-provider-qualification) contract and the [Q-STORE record](qualification-register.md#initial-decisions).

## What J0 has to prove

One store is authoritative for operational receipts; memory indexes and caches are rebuildable projections ([record contract](implementation-contracts.md#record-contract)). J0 therefore owes observable behaviour, not a feature list:

- **Durable acknowledgement.** A commit that returns success has reached durable state; a failure returns an error and acknowledges nothing. "Probably written" is not an option.
- **Ordered receipt commits.** `decision → intent → outcome` for one action is committed in the order the port issues it, so a crash cannot leave an intent without a decision or an outcome without an intent.
- **Fail-closed schema.** A record whose required `schemaVersion` is unknown is rejected on read, not coerced.
- **Reopen and crash recovery.** An acknowledged record survives a forced process kill. A commit interrupted before its acknowledgement may be committed or absent, so its outcome stays uncertain and is reconciled before retry; neither result is half-written.
- **Explicit contention.** A second process on the same store fails with a visible error instead of interleaving writes. Silent lost updates are a blocked result. This proves SQLite transaction contention only; canonical-workspace writer fencing remains a separate TD-09/TD-13 contract.
- **Consistent backup and restore.** A snapshot is taken through the store's own consistent path, and restore never promotes stale bytes over newer deletion state (C3 extends this; J0 only has to keep the path open).
- **Local filesystem only.** The store lives on the user's disk, not a network share or sync folder.

## Candidates

| Candidate               | Pin and license                                                                              | What the sources state                                                                                                                                                                                       | Cost if selected                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in `node:sqlite`  | Node 24 line, documented at Stability 1.2 - Release candidate (`SQ-01`); Node is MIT         | Synchronous `DatabaseSync`/`StatementSync`, `readOnly`, `timeout`, defensive mode, module-level `backup()`, no transaction helper (`SQ-01`); SQLite's own durability semantics then apply (`SQ-04`, `SQ-05`) | Zero extra artifact and one runtime to pin, but the module is a release candidate whose class names already changed across lines, so the exact Node minor becomes a compatibility pin for the store |
| `better-sqlite3` 13.0.3 | Exact version 13.0.3, MIT, Node >=22, `node-addon-api` ^8, no install/build script (`SQ-03`) | `transaction()` with deferred/immediate/exclusive and savepoints, `pragma()`, `backup()`, documented rollback caveats (`SQ-02`); same SQLite semantics (`SQ-04`, `SQ-05`)                                    | A native binary package has to enter the selected dependency closure with integrity and license records, and its Windows x64 load has to be proven rather than assumed (`SQ-03`)                    |
| Rust support sidecar    | Not pinned; a new process and store format                                                   | [Contract](implementation-contracts.md#storage-and-provider-qualification) allows it only for a measured need                                                                                                | IPC, a second process lifetime, failure reconciliation and an expensive-to-reverse store format; a sidecar cannot become a second authority                                                         |

**Rejected without a trial.** An append-only JSONL file with our own `fsync` would make us build the journal, multi-record atomic commit and schema fail-closed check that J0 is supposed to qualify, so it is a reimplementation of the candidate rather than a smaller one. A whole database server (PostgreSQL and similar) contradicts the [barebones installation](modular-installation.md) contract by adding an external service to a local single-user app. The sidecar stays out unless a measured need appears.

## Local observation, 2026-10-26

Run on this workstation: Node v24.20.0, win32 x64. It records API and pragma availability only; it is not a crash, durability or timing result.

| Observation               | Value                                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| `node:sqlite` exports     | `DatabaseSync`, `StatementSync`, `Session`, `constants`, `backup`               |
| Bundled SQLite version    | 3.53.4                                                                          |
| Defaults on a new file    | `journal_mode=delete`, `synchronous=2` (FULL), `foreign_keys=1`                 |
| `PRAGMA journal_mode=WAL` | returns `wal`, survives close and reopen                                        |
| Corrupt file              | open rejected with `ERR_SQLITE_ERROR`, `errcode 26` (`SQLITE_NOTADB`)           |
| `backup()`                | present as a module-level function                                              |
| Transactions              | `BEGIN`/`COMMIT`/`ROLLBACK` via `exec`, `isTransaction` reflects the open state |

## Pilot observation, 2026-10-26 (not the preregistered experiment)

A throwaway harness outside this repository ran one trial of every case in the table below against both candidates on Node v24.20.0, win32 x64, with `journal_mode=WAL`, `synchronous=FULL` and foreign keys on. One trial each is a smoke check of the design, not the 30-trial CI protocol, and it qualifies nothing.

| Result                                                                   | Built-in `node:sqlite`                                                     | `better-sqlite3` 13.0.3                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------- |
| S1-S8 (S2 split into killed-before/killed-after, S6 into fail-fast/wait) | 10/10 pass                                                                 | 10/10 pass                              |
| Forced kill before commit                                                | 0 rows, readable                                                           | 0 rows, readable                        |
| Forced kill after acknowledged commit                                    | row present                                                                | row present                             |
| Truncated `-wal` beside a copy                                           | reopened, 0 rows                                                           | reopened, 0 rows                        |
| Read-only write                                                          | generic `ERR_SQLITE_ERROR`, message "attempt to write a readonly database" | typed `SQLITE_READONLY`                 |
| Second writer, no timeout                                                | `SQLITE_BUSY` immediately (default `timeout: 0`)                           | `SQLITE_BUSY` after the 5000 ms default |
| Second writer with a busy timeout                                        | waited, both commits kept                                                  | waited, both commits kept               |
| Install on Windows x64                                                   | already present                                                            | 2 packages, ~3 s, no compiler           |

What this does and does not change:

- **No selection change.** Both meet the J0 behaviours in a single trial, so the closure argument for the built-in stays the reason to prefer it, and the fallback stays available. Power-loss durability is still untested for both, and they bundle the same SQLite 3.53.4, so neither can inherit a durability advantage from this run.
- **Error discrimination is a TD-09 requirement, not a preference.** `node:sqlite` reports a read-only write as a generic `ERR_SQLITE_ERROR` and surfaces the specific cause through `errcode`, so failure handling must branch on the SQLite result code rather than the JavaScript error class.
- **Contention defaults differ and must be set explicitly.** `node:sqlite` defaults to a zero busy timeout, which turns a normal concurrent write into an immediate failure; any shared path has to set `timeout`/`busy_timeout` deliberately.
- **The Windows packaging gap in `SQ-03` is closed for 13.0.3.** The published package installed prebuilt on this machine without a compiler, so the native-package cost is a closure and integrity question, not a toolchain one.

## Selection, proposed

1. **Primary: built-in `node:sqlite`, pinned to the exact Node 24 minor shipped by R1.** It wins on closure, not on speed or durability: a barebones install should not carry a native SQLite artifact when the pinned runtime already contains one, and there is one fewer binary to sign, ship and verify. The price is paying attention to a release-candidate API and pinning the minor instead of a range.
2. **Fallback: `better-sqlite3` 13.0.3, exact version.** Triggered only by a failed J0 case or an RC API change that blocks the engine, and recorded as a decision in the qualification register rather than swapped in silently. Its mature transaction wrapper is a real advantage for the receipt ordering in TD-15, but that is convenience, not measured necessity.
3. **Never both.** Two stores are two authorities and would let C2 inject failures into something that is not the store C1 reads. A sidecar needs a measured blocking or isolation need first.

This is a preference ordering for a comparison that has not been run. If the experiment contradicts it, the experiment wins.

## Preregistered experiment (unrun)

TD-09 builds `tests/integration/store.ts` against one narrow adapter and runs the identical fixtures for both candidates. Fixed before any run: Windows 11 x64 workstation plus a Windows CI runner, exact Node version, fresh temporary directory per trial, forced termination through a child process kill, 30 trials per case per candidate, and recorded command, exit status and artifact path for every trial. Latency is recorded but never used to pick a winner. The stopping rule is blunt: one policy failure ends the candidate, and an unrun case is reported as n=0 rather than as a pass.

| Case                           | Fixture                                            | Required observation                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 fresh commit and reopen     | Empty store, commit one receipt, close, reopen     | Record present with the same `seq` and `schemaVersion`; no repair step needed                                                                                                                |
| S2 forced kill mid-transaction | Child commits, parent kills it at a recorded point | Reopen yields the committed record or nothing, never a partial record. A kill before acknowledgement leaves an uncertain result for reconciliation; an acknowledged commit is always present |
| S3 unwritable target           | Read-only directory or read-only file              | Explicit error before any acknowledgement; no silent fallback to memory                                                                                                                      |
| S4 corrupt or truncated file   | Garbage bytes and a truncated WAL                  | Fail closed with a visible error; no partial read and no invented data                                                                                                                       |
| S5 unknown required schema     | Record with a higher `schemaVersion`               | Rejected on read; the rest of the store stays readable                                                                                                                                       |
| S6 second writer               | Two processes against one store                    | One commits, the other gets a busy/timeout error; no lost update and no interleaved record. This does not qualify canonical-workspace ownership or writer handoff                            |
| S7 backup and restore          | Consistent backup, mutate, restore, reopen         | Restored state matches the snapshot; `-wal`/`-shm` handling leaves a readable store                                                                                                          |
| S8 export and import           | Export to JSONL, import into a fresh store         | IDs, ordering and `schemaVersion` survive the round trip                                                                                                                                     |

**What this experiment cannot prove.** A process kill exercises application-crash recovery, not power-loss durability. `FlushFileBuffers` and drive cache behaviour on Windows need a physical power cut or a cache-disabled disk, which the test runner cannot supply. Until such a run exists, the honest claim is "process-crash durable, power-loss unverified", and no user-facing wording may imply otherwise. WAL on a network share is out of scope by contract (`SQ-04`).

**Selection rule.** Built-in passes S1–S8 → select it. Built-in fails a case and `better-sqlite3` passes S1–S8 → select 13.0.3 with the failure recorded. Neither passes → blocked, and J0 stays unqualified until a candidate does.

## Migration boundary

- Every durable record carries an integer `schemaVersion` and an opaque `recordId` ([record contract](implementation-contracts.md#record-contract)); the store never guesses a version.
- The database file is private implementation state. The supported interchange format is the JSONL export produced by S8, so a store change is an export/import, never an in-place file rewrite.
- Before the first release that holds real user data the store is free to change. After release, a change needs the S8 round trip, a reopen check, a crash case and a documented downgrade or an explicit forward-only statement.
- Backups go through the store's consistent path (`SQ-05`, `EF-06`), never a raw copy while a transaction is open, and a `-wal` file always travels with its database (`SQ-04`).
- Restore is subordinate to deletion: a backup taken before a tombstone stays quarantined until current deletion state is applied (C3/M2 own the proof; J0 must not make that impossible).

## Disposition and recheck

- **Disposition:** proposed — built-in `node:sqlite` first, `better-sqlite3` 13.0.3 fallback; single-trial pilot run, preregistered experiment unrun.
- **Ownership:** TD-03 stops at this document; TD-09 implements the store and owns `J0_store_contract`; TD-51 later extends the crash matrix and TD-15 consumes the receipt ordering. A store-only result cannot certify native dispatch ordering.
- **Reopen when:** the pinned Node minor or major changes, SQLite changes, `better-sqlite3` ships a new major, the advertised Windows platforms change, the store moves onto a network or synced path, or any acknowledged commit is later observed missing.

## Sources

`SQ-01`–`SQ-05` in the [store qualification ledger](../evidence/store-qualification-sources.json); `EF-05`/`EF-06` cover the WAL and backup behaviour cited above. Access dates describe this snapshot and pin no release.
