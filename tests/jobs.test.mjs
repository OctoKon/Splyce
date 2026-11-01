// TD-45 — scheduler planning: definitions, time zones, occurrences, and the
// no-duplicate / no-burst / default-deny rules from capability-map.md.
// Pure module; no clock, store or network.

import assert from "node:assert/strict";
import test from "node:test";
import {
  isoWeekday,
  JobError,
  MIN_INTERVAL_MS,
  nextOccurrence,
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
