// TD-45 — scheduler planning: definitions, time zones, occurrences, and the
// no-duplicate / no-burst / default-deny rules from capability-map.md.
// Pure module; no clock, store or network.

import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeMissed,
  describeJobs,
  isoWeekday,
  DEFAULT_GRACE_MS,
  JobError,
  MIN_INTERVAL_MS,
  nextOccurrence,
  completeOccurrence,
  pauseJob,
  planTick,
  resumeJob,
  resolveWallTime,
  scanOccurrences,
  validateJob,
  wallTimeAt,
  zoneOffsetMs,
} from "../packages/splyce-pi/dist/jobs.js";

const HOUR = 3_600_000;

const daily = (over = {}) => ({
  jobId: "job-a",
  revision: "r1",
  schedule: { kind: "daily", localTime: "09:00" },
  timeZone: "UTC",
  catchUp: "skip",
  ...over,
});
const interval = (over = {}) => ({
  jobId: "job-i",
  revision: "r1",
  schedule: { kind: "interval", everyMs: HOUR, anchorUtcMs: 0 },
  timeZone: "UTC",
  catchUp: "skip",
  ...over,
});

const rejects = (fn, code) =>
  assert.throws(fn, (e) => e instanceof JobError && e.code === code);

test("valid definitions are accepted and frozen", () => {
  const job = validateJob(
    daily({
      schedule: { kind: "daily", localTime: "23:59", weekdays: [5, 1] },
      timeZone: "Asia/Kolkata",
    }),
  );
  assert.ok(Object.isFrozen(job));
  assert.ok(Object.isFrozen(job.schedule));
  assert.deepEqual(job.schedule.weekdays, [1, 5]);
  assert.ok(Object.isFrozen(job.schedule.weekdays));
  assert.deepEqual(validateJob(interval()).schedule, {
    kind: "interval",
    everyMs: HOUR,
    anchorUtcMs: 0,
  });
});

test("validation copies the input, so later caller mutation has no effect", () => {
  const input = daily();
  const job = validateJob(input);
  input.schedule.localTime = "10:00";
  input.jobId = "other";
  assert.equal(job.schedule.localTime, "09:00");
  assert.equal(job.jobId, "job-a");
});

test("invalid identifiers, policies and shapes are rejected", () => {
  for (const bad of [
    null,
    "job",
    daily({ jobId: "" }),
    daily({ jobId: "has space" }),
    daily({ revision: 7 }),
    daily({ catchUp: "all" }),
    daily({ catchUp: undefined }),
  ]) {
    rejects(() => validateJob(bad), "INVALID_JOB");
  }
});

test("schedules outside the supported shapes are rejected", () => {
  for (const schedule of [
    undefined,
    { kind: "cron", expr: "* * * * *" },
    { kind: "daily", localTime: "24:00" },
    { kind: "daily", localTime: "9:00" },
    { kind: "daily", localTime: "09:00", weekdays: [] },
    { kind: "daily", localTime: "09:00", weekdays: [0] },
    { kind: "daily", localTime: "09:00", weekdays: [1, 1] },
    { kind: "interval", everyMs: MIN_INTERVAL_MS - 1, anchorUtcMs: 0 },
    { kind: "interval", everyMs: 1.5 * HOUR + 0.5, anchorUtcMs: 0 },
    { kind: "interval", everyMs: HOUR, anchorUtcMs: "0" },
  ]) {
    rejects(() => validateJob(daily({ schedule })), "INVALID_SCHEDULE");
  }
});

test("unknown time zones are rejected", () => {
  for (const timeZone of ["", "Mars/Olympus", 5, undefined]) {
    rejects(() => validateJob(daily({ timeZone })), "INVALID_TIME_ZONE");
  }
  assert.equal(
    validateJob(daily({ timeZone: "America/New_York" })).timeZone,
    "America/New_York",
  );
});

const wall = (year, month, day, hour, minute) => ({
  year,
  month,
  day,
  hour,
  minute,
});
const iso = (ms) => new Date(ms).toISOString();

test("wall time and offset follow the zone, including half-hour zones", () => {
  const t = Date.UTC(2026, 0, 15, 12, 0);
  assert.deepEqual(wallTimeAt(t, "Asia/Kolkata"), wall(2026, 1, 15, 17, 30));
  assert.equal(zoneOffsetMs(t, "Asia/Kolkata"), 5.5 * HOUR);
  assert.equal(zoneOffsetMs(t, "America/New_York"), -5 * HOUR);
  assert.equal(
    zoneOffsetMs(Date.UTC(2026, 6, 1), "America/New_York"),
    -4 * HOUR,
  );
  assert.equal(zoneOffsetMs(t, "UTC"), 0);
});

test("an ordinary wall time resolves exactly", () => {
  assert.deepEqual(
    resolveWallTime(wall(2026, 7, 4, 9, 0), "America/New_York"),
    {
      utcMs: Date.UTC(2026, 6, 4, 13, 0),
      resolution: "exact",
    },
  );
  assert.deepEqual(resolveWallTime(wall(2026, 1, 1, 0, 0), "Asia/Kolkata"), {
    utcMs: Date.UTC(2025, 11, 31, 18, 30),
    resolution: "exact",
  });
});

test("a wall time inside the spring-forward gap runs once, just past the gap", () => {
  // New York 2026-03-08: 02:00 EST jumps to 03:00 EDT; 02:30 never happens.
  const r = resolveWallTime(wall(2026, 3, 8, 2, 30), "America/New_York");
  assert.equal(r.resolution, "gap");
  assert.equal(iso(r.utcMs), "2026-03-08T07:30:00.000Z");
  assert.deepEqual(
    wallTimeAt(r.utcMs, "America/New_York"),
    wall(2026, 3, 8, 3, 30),
  );
});

test("a wall time repeated by fall-back resolves to its first occurrence only", () => {
  // New York 2026-11-01: 02:00 EDT falls back to 01:00 EST; 01:30 happens twice.
  const r = resolveWallTime(wall(2026, 11, 1, 1, 30), "America/New_York");
  assert.equal(r.resolution, "ambiguous");
  assert.equal(iso(r.utcMs), "2026-11-01T05:30:00.000Z");
  assert.deepEqual(
    wallTimeAt(r.utcMs + HOUR, "America/New_York"),
    wall(2026, 11, 1, 1, 30),
  );
});

test("transition handling also holds for a southern-hemisphere zone", () => {
  // Sydney 2026-04-05: 03:00 AEDT falls back to 02:00 AEST; 2026-10-04: 02:00 jumps to 03:00.
  assert.equal(
    resolveWallTime(wall(2026, 4, 5, 2, 30), "Australia/Sydney").resolution,
    "ambiguous",
  );
  assert.equal(
    resolveWallTime(wall(2026, 10, 4, 2, 30), "Australia/Sydney").resolution,
    "gap",
  );
});

test("ISO weekdays run Monday 1 to Sunday 7", () => {
  assert.equal(isoWeekday(2026, 11, 2), 1);
  assert.equal(isoWeekday(2026, 11, 1), 7);
  assert.equal(isoWeekday(2024, 2, 29), 4);
});

// Brute-force reference: walk every local date and keep slots in the window.
function bruteForceDaily(job, after, until) {
  const [hour, minute] = job.schedule.localTime.split(":").map(Number);
  const days = new Set(job.schedule.weekdays ?? [1, 2, 3, 4, 5, 6, 7]);
  const out = [];
  const start = wallTimeAt(after, job.timeZone);
  for (let i = -1; ; i += 1) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const date = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
    };
    if (Date.UTC(date.year, date.month - 1, date.day) > until + 2 * 86_400_000)
      break;
    if (!days.has(isoWeekday(date.year, date.month, date.day))) continue;
    const { utcMs } = resolveWallTime({ ...date, hour, minute }, job.timeZone);
    if (utcMs > after && utcMs <= until) out.push(utcMs);
  }
  return out;
}

test("interval scans count by arithmetic and honour the anchor", () => {
  const job = validateJob(
    interval({
      schedule: { kind: "interval", everyMs: HOUR, anchorUtcMs: 10 * HOUR },
    }),
  );
  assert.deepEqual(scanOccurrences(job, 0, 10 * HOUR - 1), { count: 0 });
  const scan = scanOccurrences(job, 10 * HOUR, 13 * HOUR);
  assert.equal(scan.count, 3);
  assert.equal(scan.first.scheduledUtcMs, 11 * HOUR);
  assert.equal(scan.first.occurrenceId, "job-i@r1#1");
  assert.equal(scan.latest.scheduledUtcMs, 13 * HOUR);
  assert.equal(
    scanOccurrences(job, 0, 10 * HOUR).first.occurrenceId,
    "job-i@r1#0",
  );
  const year = scanOccurrences(job, 10 * HOUR, 10 * HOUR + 365 * 24 * HOUR);
  assert.equal(year.count, 365 * 24);
});

test("windows are half-open: (after, until]", () => {
  const job = validateJob(interval());
  assert.equal(scanOccurrences(job, HOUR, 2 * HOUR).count, 1);
  assert.equal(
    scanOccurrences(job, HOUR, 2 * HOUR).first.scheduledUtcMs,
    2 * HOUR,
  );
  assert.equal(scanOccurrences(job, 2 * HOUR, 2 * HOUR).count, 0);
  assert.equal(scanOccurrences(job, 3 * HOUR, 2 * HOUR).count, 0);
});

test("daily scans match a brute-force walk across zones, weekdays and DST", () => {
  const jobs = [
    daily(),
    daily({
      timeZone: "America/New_York",
      schedule: { kind: "daily", localTime: "02:30" },
    }),
    daily({
      timeZone: "America/New_York",
      schedule: { kind: "daily", localTime: "01:30", weekdays: [7] },
    }),
    daily({
      timeZone: "Asia/Kolkata",
      schedule: { kind: "daily", localTime: "00:15", weekdays: [1, 3, 5] },
    }),
    daily({
      timeZone: "Australia/Sydney",
      schedule: { kind: "daily", localTime: "23:45", weekdays: [6, 7] },
    }),
  ].map(validateJob);
  const windows = [
    [Date.UTC(2026, 2, 1), Date.UTC(2026, 2, 20)],
    [Date.UTC(2026, 9, 25, 7), Date.UTC(2026, 10, 9, 13, 17)],
    [Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31, 23, 59)],
    [Date.UTC(2026, 5, 1, 13, 30), Date.UTC(2026, 5, 1, 13, 30) + 1],
    [Date.UTC(2026, 5, 3, 9), Date.UTC(2026, 5, 3, 9)],
  ];
  for (const job of jobs) {
    for (const [after, until] of windows) {
      const expected = bruteForceDaily(job, after, until);
      const scan = scanOccurrences(job, after, until);
      const label = `${job.timeZone} ${job.schedule.localTime} ${iso(after)}..${iso(until)}`;
      assert.equal(scan.count, expected.length, label);
      assert.equal(scan.first?.scheduledUtcMs, expected[0], label);
      assert.equal(scan.latest?.scheduledUtcMs, expected.at(-1), label);
    }
  }
});

test("a fall-back day has one daily slot with one id", () => {
  const job = validateJob(
    daily({
      timeZone: "America/New_York",
      schedule: { kind: "daily", localTime: "01:30" },
    }),
  );
  const scan = scanOccurrences(
    job,
    Date.UTC(2026, 10, 1, 4),
    Date.UTC(2026, 10, 1, 8),
  );
  assert.equal(scan.count, 1);
  assert.equal(scan.first.occurrenceId, "job-a@r1#2026-11-01");
  assert.equal(iso(scan.first.scheduledUtcMs), "2026-11-01T05:30:00.000Z");
});

test("the next occurrence is found for both schedule kinds", () => {
  const weekly = validateJob(
    daily({ schedule: { kind: "daily", localTime: "09:00", weekdays: [1] } }),
  );
  // 2026-11-01 is a Sunday; the next Monday 09:00 UTC is 2026-11-02.
  assert.equal(
    iso(nextOccurrence(weekly, Date.UTC(2026, 10, 1, 12)).scheduledUtcMs),
    "2026-11-02T09:00:00.000Z",
  );
  assert.equal(
    iso(nextOccurrence(weekly, Date.UTC(2026, 10, 2, 9)).scheduledUtcMs),
    "2026-11-09T09:00:00.000Z",
  );
  const later = validateJob(
    interval({
      schedule: { kind: "interval", everyMs: HOUR, anchorUtcMs: 50 * HOUR },
    }),
  );
  assert.equal(nextOccurrence(later, 0).scheduledUtcMs, 50 * HOUR);
  assert.equal(nextOccurrence(later, 50 * HOUR).scheduledUtcMs, 51 * HOUR);
});

// Runs ticks in order, threading persisted state like the caller would.
function run(jobs, ticks, { states = [], enabled = true } = {}) {
  const plans = [];
  for (const tick of ticks) {
    const t = typeof tick === "number" ? { now: tick } : tick;
    const plan = planTick({
      nowUtcMs: t.now,
      schedulingEnabled: t.enabled ?? enabled,
      jobs: t.jobs ?? jobs,
      states,
    });
    states = plan.states;
    plans.push(plan);
  }
  return { plans, states };
}
const ids = (plan) => plan.dispatch.map((o) => o.occurrenceId);

test("a new job starts at the current instant and never backfills", () => {
  const job = interval();
  const { plans, states } = run([job], [10 * HOUR + 5]);
  assert.deepEqual(ids(plans[0]), []);
  assert.deepEqual(plans[0].missed, []);
  assert.equal(states[0].cursorUtcMs, 10 * HOUR + 5);
  assert.equal(states[0].revision, "r1");
});

test("a due slot dispatches once, and a duplicate tick does not dispatch it again", () => {
  const { plans } = run([interval()], [HOUR - 1, HOUR, HOUR, HOUR + 30_000]);
  assert.deepEqual(plans.map(ids), [[], ["job-i@r1#1"], [], []]);
});

test("replaying the same persisted state yields the same single decision", () => {
  const first = run([interval()], [HOUR - 1]).states;
  const a = planTick({
    nowUtcMs: HOUR,
    schedulingEnabled: true,
    jobs: [interval()],
    states: first,
  });
  const b = planTick({
    nowUtcMs: HOUR,
    schedulingEnabled: true,
    jobs: [interval()],
    states: first,
  });
  assert.deepEqual(ids(a), ["job-i@r1#1"]);
  assert.deepEqual(b, a);
  assert.deepEqual(
    ids(
      planTick({
        nowUtcMs: HOUR,
        schedulingEnabled: true,
        jobs: [interval()],
        states: a.states,
      }),
    ),
    [],
  );
});

test("at most one dispatch per job per tick; earlier slots are reported, not burst", () => {
  const { plans, states } = run([interval()], [HOUR - 1, 5 * HOUR]);
  assert.deepEqual(ids(plans[1]), ["job-i@r1#5"]);
  assert.deepEqual(plans[1].missed, [
    {
      jobId: "job-i",
      reason: "late",
      count: 4,
      firstUtcMs: HOUR,
      latestUtcMs: 4 * HOUR,
    },
  ]);
  assert.deepEqual(states[0].missed, {
    count: 4,
    firstUtcMs: HOUR,
    latestUtcMs: 4 * HOUR,
    byReason: { late: 4 },
  });
});

test("scheduling is denied unless enablement is the literal true", () => {
  const states = run([interval()], [HOUR - 1]).states;
  for (const flag of [undefined, null, 1, "true", {}, false]) {
    const plan = planTick({
      nowUtcMs: HOUR,
      schedulingEnabled: flag,
      jobs: [interval()],
      states,
    });
    assert.deepEqual(ids(plan), [], String(flag));
    assert.equal(plan.missed[0].reason, "scheduler_disabled");
  }
});

test("states and jobs are validated before planning", () => {
  rejects(
    () =>
      planTick({
        nowUtcMs: 1.5,
        schedulingEnabled: true,
        jobs: [],
        states: [],
      }),
    "INVALID_TICK",
  );
  rejects(
    () =>
      planTick({
        nowUtcMs: 0,
        schedulingEnabled: true,
        jobs: [interval(), interval()],
        states: [],
      }),
    "DUPLICATE_JOB",
  );
  const state = run([interval()], [0]).states[0];
  rejects(
    () =>
      planTick({
        nowUtcMs: 0,
        schedulingEnabled: true,
        jobs: [],
        states: [state, state],
      }),
    "DUPLICATE_STATE",
  );
  rejects(
    () =>
      planTick({
        nowUtcMs: 0,
        schedulingEnabled: true,
        jobs: [interval({ timeZone: "Nowhere/X" })],
        states: [],
      }),
    "INVALID_TIME_ZONE",
  );
});

test("a state whose job definition is gone is retained unchanged", () => {
  const { states } = run([interval()], [0]);
  const plan = planTick({
    nowUtcMs: 5 * HOUR,
    schedulingEnabled: true,
    jobs: [],
    states,
  });
  assert.deepEqual(plan.states, states);
  assert.deepEqual(plan.dispatch, []);
});

test("planner outputs are frozen", () => {
  const { plans } = run([interval()], [HOUR - 1, HOUR]);
  assert.ok(Object.isFrozen(plans[1]));
  assert.ok(Object.isFrozen(plans[1].dispatch));
  assert.ok(Object.isFrozen(plans[1].dispatch[0]));
  assert.ok(Object.isFrozen(plans[1].states[0]));
});

test("a tick within the grace period runs the slot on time", () => {
  const { plans } = run([interval()], [HOUR - 1, HOUR + DEFAULT_GRACE_MS]);
  assert.deepEqual(plans[1].dispatch, [
    {
      jobId: "job-i",
      revision: "r1",
      occurrenceId: "job-i@r1#1",
      scheduledUtcMs: HOUR,
      catchUp: false,
    },
  ]);
});

test("skip policy: a slot past the grace period is reported, not run", () => {
  const { plans, states } = run(
    [interval()],
    [HOUR - 1, HOUR + DEFAULT_GRACE_MS + 1],
  );
  assert.deepEqual(ids(plans[1]), []);
  assert.deepEqual(plans[1].missed, [
    {
      jobId: "job-i",
      reason: "late",
      count: 1,
      firstUtcMs: HOUR,
      latestUtcMs: HOUR,
    },
  ]);
  assert.equal(states[0].lastDispatchedId, undefined);
  // The cursor passed the slot, so a later tick does not resurrect it.
  assert.deepEqual(
    ids(run([interval()], [HOUR + 2 * DEFAULT_GRACE_MS], { states }).plans[0]),
    [],
  );
});

test("latest policy: after downtime exactly one catch-up run, marked as such", () => {
  const job = interval({ catchUp: "latest" });
  const { plans } = run(
    [job],
    [HOUR - 1, 10 * HOUR + 30 * 60_000, 10 * HOUR + 31 * 60_000],
  );
  assert.deepEqual(
    plans[1].dispatch.map((d) => [d.occurrenceId, d.catchUp]),
    [["job-i@r1#10", true]],
  );
  assert.deepEqual(plans[1].missed, [
    {
      jobId: "job-i",
      reason: "late",
      count: 9,
      firstUtcMs: HOUR,
      latestUtcMs: 9 * HOUR,
    },
  ]);
  assert.deepEqual(ids(plans[2]), []);
});

test("daily catch-up after a multi-day outage runs one slot at most", () => {
  const job = daily({ catchUp: "latest", timeZone: "Asia/Kolkata" });
  const start = Date.UTC(2026, 10, 1);
  const { plans, states } = run([job], [start, start + 6 * 24 * HOUR]);
  assert.equal(plans[1].dispatch.length, 1);
  assert.equal(plans[1].dispatch[0].occurrenceId, "job-a@r1#2026-11-06");
  assert.equal(plans[1].dispatch[0].catchUp, true);
  // 09:00 IST slots on Nov 1-6 fall in the window: one runs, five are late.
  assert.equal(states[0].missed.byReason.late, 5);
});

test("grace must be a non-negative integer", () => {
  for (const graceMs of [-1, 0.5, Number.NaN]) {
    rejects(
      () =>
        planTick({
          nowUtcMs: 0,
          schedulingEnabled: true,
          jobs: [],
          states: [],
          graceMs,
        }),
      "INVALID_TICK",
    );
  }
  const { plans } = run(
    [interval()],
    [HOUR - 1, { now: HOUR + 1, jobs: undefined }],
  );
  assert.deepEqual(ids(plans[1]), ["job-i@r1#1"]);
  const strict = planTick({
    nowUtcMs: HOUR + 1,
    schedulingEnabled: true,
    jobs: [interval()],
    states: run([interval()], [HOUR - 1]).states,
    graceMs: 0,
  });
  assert.deepEqual(ids(strict), []);
});

test("disabled ticks retain the job and report each missed slot", () => {
  const job = interval({ catchUp: "latest" });
  const { plans, states } = run(
    [job],
    [
      HOUR - 1,
      { now: 3 * HOUR, enabled: false },
      { now: 5 * HOUR, enabled: false },
    ],
  );
  assert.deepEqual(plans.flatMap(ids), []);
  assert.deepEqual(
    plans.slice(1).map((p) => p.missed.map((m) => [m.reason, m.count])),
    [[["scheduler_disabled", 3]], [["scheduler_disabled", 2]]],
  );
  assert.deepEqual(states[0].missed.byReason, { scheduler_disabled: 5 });
  assert.equal(states[0].enabledAtLastTick, false);
});

test("re-enable never launches a burst or an implicit catch-up", () => {
  const job = interval({ catchUp: "latest" });
  // Disabled, then the process is off for days, then it comes back enabled.
  const { plans, states } = run(
    [job],
    [
      HOUR - 1,
      { now: 2 * HOUR, enabled: false },
      { now: 100 * HOUR, enabled: true },
    ],
  );
  assert.deepEqual(ids(plans[2]), []);
  assert.deepEqual(
    plans[2].missed.map((m) => [m.reason, m.count]),
    [["scheduler_disabled", 98]],
  );
  // After re-arming, the next slot runs normally.
  const next = run([job], [101 * HOUR], { states }).plans[0];
  assert.deepEqual(
    next.dispatch.map((d) => [d.occurrenceId, d.catchUp]),
    [["job-i@r1#101", false]],
  );
});

test("a job created while disabled starts disarmed and re-arms on the first enabled tick", () => {
  const job = interval();
  const { plans } = run([job], [{ now: 0, enabled: false }, HOUR, 2 * HOUR]);
  assert.deepEqual(plans.map(ids), [[], [], ["job-i@r1#2"]]);
  assert.equal(plans[1].missed[0].reason, "scheduler_disabled");
});

test("a slot never starts while the previous occurrence is running", () => {
  const { plans, states } = run(
    [interval()],
    [HOUR - 1, HOUR, 2 * HOUR, 3 * HOUR],
  );
  assert.deepEqual(plans.map(ids), [[], ["job-i@r1#1"], [], []]);
  assert.deepEqual(
    plans.slice(2).map((p) => p.missed.map((m) => m.reason)),
    [["overlap"], ["overlap"]],
  );
  assert.equal(states[0].running.occurrenceId, "job-i@r1#1");
  assert.equal(states[0].running.startedUtcMs, HOUR);
});

test("completion frees the job for its next slot and records the outcome", () => {
  let { states } = run([interval()], [HOUR - 1, HOUR]);
  states = [completeOccurrence(states[0], "job-i@r1#1", "uncertain")];
  assert.equal(states[0].running, undefined);
  assert.deepEqual(states[0].lastOutcome, {
    occurrenceId: "job-i@r1#1",
    outcome: "uncertain",
  });
  assert.deepEqual(ids(run([interval()], [2 * HOUR], { states }).plans[0]), [
    "job-i@r1#2",
  ]);
});

test("a stale, duplicate or unknown completion is refused", () => {
  const { states } = run([interval()], [HOUR - 1, HOUR]);
  rejects(
    () => completeOccurrence(states[0], "job-i@r1#0", "succeeded"),
    "NOT_RUNNING",
  );
  rejects(
    () => completeOccurrence(states[0], "job-i@r1#1", "done"),
    "INVALID_OUTCOME",
  );
  const done = completeOccurrence(states[0], "job-i@r1#1", "succeeded");
  rejects(
    () => completeOccurrence(done, "job-i@r1#1", "succeeded"),
    "NOT_RUNNING",
  );
});

test("a paused job keeps its state and reports every skipped slot", () => {
  let { states } = run([interval()], [HOUR - 1]);
  states = [pauseJob(states[0], "user paused", HOUR - 1)];
  assert.deepEqual(states[0].paused, {
    reason: "user paused",
    sinceUtcMs: HOUR - 1,
  });
  const { plans, states: after } = run([interval()], [HOUR, 3 * HOUR], {
    states,
  });
  assert.deepEqual(plans.flatMap(ids), []);
  assert.deepEqual(after[0].missed.byReason, { paused: 3 });
  assert.equal(pauseJob(after[0], "again", 3 * HOUR), after[0]);
  rejects(() => pauseJob(after[0], "  ", 3 * HOUR), "INVALID_PAUSE");
});

test("resume continues from now and reports, not replays, the paused gap", () => {
  const job = interval({ catchUp: "latest" });
  let { states } = run([job], [HOUR - 1]);
  states = [pauseJob(states[0], "maintenance", HOUR - 1)];
  // No tick runs while paused (the app was closed); resume ten hours later.
  const resumed = resumeJob(job, states[0], 10 * HOUR + 1);
  assert.equal(resumed.paused, undefined);
  assert.equal(resumed.cursorUtcMs, 10 * HOUR + 1);
  assert.deepEqual(resumed.missed.byReason, { paused: 10 });
  const { plans } = run([job], [10 * HOUR + 2, 11 * HOUR], {
    states: [resumed],
  });
  assert.deepEqual(plans.map(ids), [[], ["job-i@r1#11"]]);
  assert.equal(resumeJob(job, resumed, 12 * HOUR), resumed);
  rejects(
    () => resumeJob(interval({ jobId: "other" }), states[0], HOUR),
    "INVALID_JOB",
  );
});

test("a clock moved backwards replays nothing and is signalled", () => {
  const { plans, states } = run(
    [interval()],
    [HOUR - 1, 3 * HOUR, HOUR - 1, 2 * HOUR, 3 * HOUR],
  );
  assert.deepEqual(plans.map(ids), [[], ["job-i@r1#3"], [], [], []]);
  assert.deepEqual(plans[2].clockRegressed, ["job-i"]);
  assert.deepEqual(plans[3].clockRegressed, ["job-i"]);
  assert.deepEqual(plans[4].clockRegressed, []);
  assert.equal(states[0].cursorUtcMs, 3 * HOUR);
});

test("a clock jumping forward is a late window: one run at most", () => {
  const { plans } = run(
    [interval({ catchUp: "latest" })],
    [HOUR - 1, 48 * HOUR + 7],
  );
  assert.equal(plans[1].dispatch.length, 1);
  assert.deepEqual(
    plans[1].missed.map((m) => [m.reason, m.count]),
    [["late", 47]],
  );
});

test("daily jobs across a DST weekend dispatch each local day exactly once", () => {
  const job = daily({
    timeZone: "America/New_York",
    schedule: { kind: "daily", localTime: "01:30" },
  });
  const ticks = [];
  for (
    let t = Date.UTC(2026, 9, 30);
    t <= Date.UTC(2026, 10, 3);
    t += 15 * 60_000
  )
    ticks.push(t);
  let states = [];
  const dispatched = [];
  for (const now of ticks) {
    const plan = planTick({
      nowUtcMs: now,
      schedulingEnabled: true,
      jobs: [job],
      states,
    });
    states = plan.states;
    for (const d of plan.dispatch) {
      dispatched.push(d.occurrenceId);
      states = [completeOccurrence(states[0], d.occurrenceId, "succeeded")];
    }
  }
  assert.deepEqual(dispatched, [
    "job-a@r1#2026-10-30",
    "job-a@r1#2026-10-31",
    "job-a@r1#2026-11-01",
    "job-a@r1#2026-11-02",
  ]);
});

test("a changed revision starts fresh and never runs old slots", () => {
  const v1 = interval({ catchUp: "latest" });
  const v2 = interval({
    revision: "r2",
    catchUp: "latest",
    schedule: { kind: "interval", everyMs: 2 * HOUR, anchorUtcMs: 0 },
  });
  let { states } = run([v1], [HOUR - 1, HOUR]);
  states = [completeOccurrence(states[0], "job-i@r1#1", "succeeded")];
  const { plans, states: after } = run([v2], [5 * HOUR, 6 * HOUR], { states });
  assert.deepEqual(plans.map(ids), [[], ["job-i@r2#3"]]);
  assert.deepEqual(
    plans[0].missed.map((m) => [m.reason, m.count]),
    [["superseded", 2]],
  );
  assert.equal(after[0].revision, "r2");
});

test("a revision change keeps a running occurrence recorded", () => {
  const { states } = run([interval()], [HOUR - 1, HOUR]);
  const plan = planTick({
    nowUtcMs: 2 * HOUR,
    schedulingEnabled: true,
    jobs: [interval({ revision: "r2" })],
    states,
  });
  assert.equal(plan.states[0].running.occurrenceId, "job-i@r1#1");
  assert.deepEqual(ids(plan), []);
});

test("inspection shows each job's status, next slot and missed work", () => {
  const a = interval({ jobId: "a" });
  const b = interval({ jobId: "b" });
  const c = daily({ jobId: "c" });
  let { states } = run([a, b, c], [HOUR - 1, HOUR]);
  states = states.map((s) =>
    s.jobId === "b" ? pauseJob(s, "user paused", HOUR) : s,
  );
  const views = describeJobs({
    schedulingEnabled: true,
    jobs: [a, b, c],
    states,
  });
  assert.deepEqual(
    views.map((v) => [v.jobId, v.status]),
    [
      ["a", "running"],
      ["b", "paused"],
      ["c", "scheduled"],
    ],
  );
  assert.equal(views[0].runningOccurrenceId, "a@r1#1");
  assert.equal(views[1].pausedReason, "user paused");
  assert.equal(views[0].nextUtcMs, 2 * HOUR);
  assert.equal(iso(views[2].nextUtcMs), "1970-01-01T09:00:00.000Z");
  assert.ok(Object.isFrozen(views) && Object.isFrozen(views[0]));
});

test("disabled and orphaned jobs remain inspectable", () => {
  const job = interval({ catchUp: "latest" });
  const { states } = run([job], [HOUR - 1, { now: 4 * HOUR, enabled: false }]);
  const disabled = describeJobs({
    schedulingEnabled: false,
    jobs: [job],
    states,
  });
  assert.equal(disabled[0].status, "scheduler_disabled");
  assert.deepEqual(disabled[0].missed.byReason, { scheduler_disabled: 4 });
  const orphaned = describeJobs({ schedulingEnabled: true, jobs: [], states });
  assert.deepEqual(
    orphaned.map((v) => [v.jobId, v.status, v.revision, v.nextUtcMs]),
    [["job-i", "orphaned", "r1", undefined]],
  );
});

test("acknowledging missed work clears the summary but keeps the cursor", () => {
  const { states } = run(
    [interval()],
    [HOUR - 1, { now: 4 * HOUR, enabled: false }],
  );
  const acked = acknowledgeMissed(states[0]);
  assert.deepEqual(acked.missed, { count: 0, byReason: {} });
  assert.equal(acked.cursorUtcMs, states[0].cursorUtcMs);
  assert.equal(acknowledgeMissed(acked), acked);
  // Acknowledged slots #1-4 never run; only the next new slot does.
  const later = run([interval()], [4 * HOUR + 1, 5 * HOUR], {
    states: [acked],
  });
  assert.deepEqual(later.plans.map(ids), [[], ["job-i@r1#5"]]);
});
