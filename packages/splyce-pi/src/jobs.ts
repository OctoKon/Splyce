// TD-45 / E1 — optional local scheduler: pure planning logic.
//
// Policy (capability-map.md, `scheduling.enabled`): the scheduler starts only
// while explicitly enabled, retains job definitions while disabled, reports
// missed triggers under the job's declared catch-up policy, and re-enable never
// launches a burst implicitly. A duplicate, missed or clock-change trigger must
// not duplicate an effect.
//
// This module decides *what* is due; it performs no I/O and holds no authority.
// Each planned occurrence still goes through native admission (TD-13/14) before
// any effect, and durable job state is persisted by the caller (TD-25).

/** Errors raised for invalid definitions or state; `code` is stable. */
export class JobError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "JobError";
    this.code = code;
  }
}

/** Every `everyMs` from `anchorUtcMs` (UTC, unaffected by time zones). */
export interface IntervalSchedule {
  readonly kind: "interval";
  readonly everyMs: number;
  readonly anchorUtcMs: number;
}

/** A wall-clock time in the job's time zone, on the listed ISO weekdays (1 = Monday). */
export interface DailySchedule {
  readonly kind: "daily";
  readonly localTime: string;
  readonly weekdays?: readonly number[];
}

export type Schedule = IntervalSchedule | DailySchedule;

/**
 * `skip`: occurrences missed while the scheduler was down are reported, never run.
 * `latest`: run at most the single latest missed occurrence, never a burst.
 */
export type CatchUpPolicy = "skip" | "latest";

export interface JobDefinition {
  readonly jobId: string;
  /** Changes whenever the definition changes; occurrences bind to it. */
  readonly revision: string;
  readonly schedule: Schedule;
  /** IANA time zone used by daily schedules. */
  readonly timeZone: string;
  readonly catchUp: CatchUpPolicy;
}

/** Shortest interval accepted; anything tighter is a busy loop, not a schedule. */
export const MIN_INTERVAL_MS = 60_000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function assertId(field: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new JobError("INVALID_JOB", `${field} must be a short identifier`);
  }
}

/** Throws JobError("INVALID_TIME_ZONE") unless `timeZone` is an IANA zone this runtime knows. */
export function assertTimeZone(timeZone: unknown): asserts timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0) {
    throw new JobError("INVALID_TIME_ZONE");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new JobError("INVALID_TIME_ZONE", timeZone);
  }
}

function assertSchedule(schedule: unknown): asserts schedule is Schedule {
  if (typeof schedule !== "object" || schedule === null) {
    throw new JobError("INVALID_SCHEDULE");
  }
  const s = schedule as Record<string, unknown>;
  if (s.kind === "interval") {
    const { everyMs, anchorUtcMs } = s;
    if (
      typeof everyMs !== "number" ||
      !Number.isSafeInteger(everyMs) ||
      everyMs < MIN_INTERVAL_MS
    ) {
      throw new JobError(
        "INVALID_SCHEDULE",
        `everyMs must be an integer >= ${MIN_INTERVAL_MS}`,
      );
    }
    if (typeof anchorUtcMs !== "number" || !Number.isSafeInteger(anchorUtcMs)) {
      throw new JobError("INVALID_SCHEDULE", "anchorUtcMs must be an integer");
    }
    return;
  }
  if (s.kind === "daily") {
    if (typeof s.localTime !== "string" || !LOCAL_TIME.test(s.localTime)) {
      throw new JobError("INVALID_SCHEDULE", "localTime must be HH:MM");
    }
    if (s.weekdays !== undefined) {
      const days = s.weekdays;
      if (
        !Array.isArray(days) ||
        days.length === 0 ||
        days.some((d) => !Number.isInteger(d) || d < 1 || d > 7) ||
        new Set(days).size !== days.length
      ) {
        throw new JobError(
          "INVALID_SCHEDULE",
          "weekdays must be distinct ISO weekdays 1-7",
        );
      }
    }
    return;
  }
  throw new JobError("INVALID_SCHEDULE", "unknown schedule kind");
}

/**
 * Validates a definition and returns a frozen copy, so a caller cannot change a
 * schedule after it was checked.
 */
export function validateJob(job: unknown): JobDefinition {
  if (typeof job !== "object" || job === null) {
    throw new JobError("INVALID_JOB");
  }
  const j = job as Record<string, unknown>;
  assertId("jobId", j.jobId);
  assertId("revision", j.revision);
  assertSchedule(j.schedule);
  assertTimeZone(j.timeZone);
  if (j.catchUp !== "skip" && j.catchUp !== "latest") {
    throw new JobError("INVALID_JOB", "catchUp must be skip or latest");
  }
  const schedule: Schedule =
    j.schedule.kind === "interval"
      ? Object.freeze({
          kind: "interval",
          everyMs: j.schedule.everyMs,
          anchorUtcMs: j.schedule.anchorUtcMs,
        })
      : Object.freeze({
          kind: "daily",
          localTime: j.schedule.localTime,
          ...(j.schedule.weekdays
            ? {
                weekdays: Object.freeze(
                  [...j.schedule.weekdays].sort((a, b) => a - b),
                ),
              }
            : {}),
        });
  return Object.freeze({
    jobId: j.jobId,
    revision: j.revision,
    schedule,
    timeZone: j.timeZone,
    catchUp: j.catchUp,
  });
}
