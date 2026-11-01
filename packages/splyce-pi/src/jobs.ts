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

/** A calendar date and wall-clock time in some time zone (month 1-12, ISO weekday 1-7). */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/** How a wall time resolved to an instant across DST transitions. */
export type WallTimeResolution =
  | "exact"
  /** The wall time does not exist (clocks sprang forward); the instant is shifted past the gap. */
  | "gap"
  /** The wall time happens twice (clocks fell back); the first occurrence is used. */
  | "ambiguous";

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall time (to the minute) an instant shows in `timeZone`. */
export function wallTimeAt(utcMs: number, timeZone: string): WallTime {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(utcMs)) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year ?? NaN,
    month: fields.month ?? NaN,
    day: fields.day ?? NaN,
    hour: fields.hour ?? NaN,
    minute: fields.minute ?? NaN,
  };
}

/** UTC offset of `timeZone` at an instant, in ms (local = utc + offset). */
export function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const second = Math.floor(utcMs / 1000) * 1000;
  const w = wallTimeAt(second, timeZone);
  const seconds = new Date(second).getUTCSeconds();
  return (
    Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, seconds) - second
  );
}

function sameWallTime(a: WallTime, b: WallTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

// Real zones differ from UTC by at most 14h, and transitions are rarer than
// daily, so the offsets 14h either side cover both sides of any transition.
const OFFSET_PROBE_MS = 14 * 3_600_000;

/**
 * The instant at which `wall` happens in `timeZone`. A nonexistent wall time
 * (spring-forward gap) maps to the instant the pre-gap offset gives, which is
 * just past the gap; a repeated wall time (fall-back overlap) maps to its first
 * occurrence. Either way exactly one instant is returned, so a daily slot can
 * neither vanish nor run twice on a transition day.
 */
export function resolveWallTime(
  wall: WallTime,
  timeZone: string,
): { readonly utcMs: number; readonly resolution: WallTimeResolution } {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  const before = zoneOffsetMs(naive - OFFSET_PROBE_MS, timeZone);
  const after = zoneOffsetMs(naive + OFFSET_PROBE_MS, timeZone);
  const matches = [...new Set([before, after])]
    .map((offset) => naive - offset)
    .filter((utcMs) => sameWallTime(wallTimeAt(utcMs, timeZone), wall))
    .sort((a, b) => a - b);
  const first = matches[0];
  if (first !== undefined) {
    return {
      utcMs: first,
      resolution: matches.length > 1 ? "ambiguous" : "exact",
    };
  }
  return { utcMs: naive - before, resolution: "gap" };
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date. */
export function isoWeekday(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return d === 0 ? 7 : d;
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
