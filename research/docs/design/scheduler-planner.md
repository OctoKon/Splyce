# Scheduler planner (TD-45)

Refs [issue 114](https://github.com/OctoKon/Splyce/issues/114). Policy source: `scheduling.enabled` in the
[capability map](capability-map.md). Code: `packages/splyce-pi/src/jobs.ts`, exported as `@splyce/pi/jobs`; tests:
`tests/jobs.test.mjs` (`npm run test:jobs`, part of the release gate).

The planner is pure. It decides which scheduled slots are due and which were missed; it holds no authority and does
no I/O. Each dispatched occurrence still needs native admission (TD-13/14) before any effect, and the caller persists
job state (TD-25 recovery) before acting on a plan. Scheduling stays denied by default until that integration lands.

## Model

- **Definition.** `jobId`, `revision`, an interval schedule (UTC, anchored, at least one minute) or a daily wall-clock
  schedule with optional ISO weekdays, an IANA time zone and a catch-up policy (`skip` or `latest`). `validateJob`
  returns a frozen copy.
- **Occurrence identity.** `job@revision#slot`, where the slot is the interval index or the local calendar date. The
  same slot always has the same id; a fall-back day has exactly one daily slot.
- **State.** Per job: the decided cursor (never moves back), whether the scheduler was enabled at the last tick, the
  last dispatched id, the running occurrence, the last outcome, a durable pause with reason, and a cumulative missed
  summary by reason until acknowledged.

## Rules

| Situation                                   | Decision                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Enablement not the literal `true`           | Nothing dispatches; every slot is reported `scheduler_disabled`           |
| First enabled tick after a disabled one     | Re-arms only; the window is reported `scheduler_disabled`, no catch-up    |
| New job or changed revision                 | Starts at the current instant; a revision gap is reported `superseded`    |
| Several slots due in one window             | At most the latest runs; earlier slots are reported `late`, never burst   |
| Latest slot past the grace period (5 min)   | Runs once marked `catchUp` under `latest`; reported `late` under `skip`   |
| Previous occurrence still running           | No slot starts; slots are reported `overlap`                              |
| Paused job, or resume after a tickless gap  | Slots are reported `paused`, never replayed                               |
| Duplicate tick or replay of persisted state | The dispatched id and cursor are already recorded, so nothing runs again  |
| Clock moved backwards                       | Empty window, cursor unchanged, job listed in `clockRegressed`            |
| Spring-forward gap / fall-back overlap      | The slot runs once just past the gap / at the first of the repeated times |
| Definition removed                          | State retained unchanged and listed as `orphaned` by `describeJobs`       |

`describeJobs` gives a read-only status view of every job, including disabled and orphaned ones.
`completeOccurrence` records `succeeded`, `failed`, `cancelled` or `uncertain` for the running occurrence only.

## Limits

Missed windows are summarised arithmetically (count, first, latest), so a long disabled period costs the same as a
short one. A revision change counts its gap under the new schedule because the old one is no longer known. Native
admission, durable persistence, recovery of an `uncertain` run and the engine-host trigger loop are not part of this
module.
