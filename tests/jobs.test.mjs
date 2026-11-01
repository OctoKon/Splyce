// TD-45 — scheduler planning: definitions, time zones, occurrences, and the
// no-duplicate / no-burst / default-deny rules from capability-map.md.
// Pure module; no clock, store or network.

import assert from "node:assert/strict";
import test from "node:test";
import {
  JobError,
  MIN_INTERVAL_MS,
  validateJob,
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
