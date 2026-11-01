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

/** One scheduled slot of one job revision. */
export interface Occurrence {
  readonly jobId: string;
  readonly revision: string;
  /**
   * Stable identity of the slot: the interval index, or the local calendar
   * date for daily jobs. A fall-back day still has one daily slot, and the same
   * slot always gets the same id, which is what dedupes duplicate triggers.
   */
  readonly occurrenceId: string;
  readonly scheduledUtcMs: number;
}

/** Occurrences in a window `(afterUtcMs, untilUtcMs]`, summarised without enumerating them all. */
export interface OccurrenceScan {
  readonly count: number;
  readonly first?: Occurrence;
  readonly latest?: Occurrence;
}

interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) -
      Date.UTC(from.year, from.month - 1, from.day)) /
      86_400_000,
  );
}

function dateKey(date: CalendarDate): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

function occurrence(
  job: JobDefinition,
  slot: string,
  scheduledUtcMs: number,
): Occurrence {
  return Object.freeze({
    jobId: job.jobId,
    revision: job.revision,
    occurrenceId: `${job.jobId}@${job.revision}#${slot}`,
    scheduledUtcMs,
  });
}

function scanInterval(
  job: JobDefinition,
  schedule: IntervalSchedule,
  afterUtcMs: number,
  untilUtcMs: number,
): OccurrenceScan {
  const { everyMs, anchorUtcMs } = schedule;
  const firstIndex = Math.max(
    0,
    Math.floor((afterUtcMs - anchorUtcMs) / everyMs) + 1,
  );
  const lastIndex = Math.floor((untilUtcMs - anchorUtcMs) / everyMs);
  if (lastIndex < firstIndex) return { count: 0 };
  const at = (index: number) =>
    occurrence(job, String(index), anchorUtcMs + index * everyMs);
  return {
    count: lastIndex - firstIndex + 1,
    first: at(firstIndex),
    latest: at(lastIndex),
  };
}

function scanDaily(
  job: JobDefinition,
  schedule: DailySchedule,
  afterUtcMs: number,
  untilUtcMs: number,
): OccurrenceScan {
  const [hour, minute] = schedule.localTime.split(":").map(Number) as [
    number,
    number,
  ];
  const weekdays = new Set(schedule.weekdays ?? [1, 2, 3, 4, 5, 6, 7]);
  const runsOn = (date: CalendarDate) =>
    weekdays.has(isoWeekday(date.year, date.month, date.day));
  // The slot of a date, if it falls inside the window.
  const slotOn = (date: CalendarDate): Occurrence | undefined => {
    if (!runsOn(date)) return undefined;
    const { utcMs } = resolveWallTime({ ...date, hour, minute }, job.timeZone);
    if (utcMs <= afterUtcMs || utcMs > untilUtcMs) return undefined;
    return occurrence(job, dateKey(date), utcMs);
  };
  // A slot resolves within its own local date, so only the two boundary dates
  // can be partly outside the window; every date strictly between is inside.
  const start = wallTimeAt(afterUtcMs, job.timeZone);
  const end = wallTimeAt(untilUtcMs, job.timeZone);
  const span = daysBetween(start, end);
  if (span < 0) return { count: 0 };

  let count = 0;
  const startSlot = slotOn(start);
  if (startSlot) count += 1;
  const endSlot = span > 0 ? slotOn(end) : undefined;
  if (endSlot) count += 1;
  const interior = Math.max(0, span - 1);
  count += Math.floor(interior / 7) * weekdays.size;
  for (let i = 1; i <= interior % 7; i += 1) {
    if (runsOn(addDays(start, i))) count += 1;
  }
  if (count === 0) return { count: 0 };

  // Matching weekdays recur within a week, so 8 dates either way suffice.
  let first: Occurrence | undefined;
  for (let i = 0; i <= Math.min(span, 7) && !first; i += 1) {
    first = slotOn(addDays(start, i));
  }
  let latest: Occurrence | undefined;
  for (let i = 0; i <= Math.min(span, 7) && !latest; i += 1) {
    latest = slotOn(addDays(end, -i));
  }
  return {
    count,
    ...(first ? { first } : {}),
    ...(latest ? { latest } : {}),
  };
}

/**
 * Summarises the job's occurrences in `(afterUtcMs, untilUtcMs]`: how many,
 * the earliest and the latest. Cost does not grow with the window, so a long
 * disabled period can be reported without enumerating every missed slot.
 */
export function scanOccurrences(
  job: JobDefinition,
  afterUtcMs: number,
  untilUtcMs: number,
): OccurrenceScan {
  if (untilUtcMs <= afterUtcMs) return { count: 0 };
  return job.schedule.kind === "interval"
    ? scanInterval(job, job.schedule, afterUtcMs, untilUtcMs)
    : scanDaily(job, job.schedule, afterUtcMs, untilUtcMs);
}

/** The first occurrence strictly after `afterUtcMs`. */
export function nextOccurrence(
  job: JobDefinition,
  afterUtcMs: number,
): Occurrence {
  // A daily job's next slot is within 8 days (weekdays recur weekly); an
  // interval's is within one period of `afterUtcMs` or of a future anchor.
  const horizon =
    job.schedule.kind === "interval"
      ? afterUtcMs +
        job.schedule.everyMs +
        Math.max(0, job.schedule.anchorUtcMs - afterUtcMs)
      : afterUtcMs + 8 * 86_400_000;
  const scan = scanOccurrences(job, afterUtcMs, horizon);
  if (!scan.first) throw new JobError("NO_OCCURRENCE", job.jobId);
  return scan.first;
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

/** Why an occurrence was not dispatched. Every skipped slot is reported, never silently dropped. */
export type MissedReason =
  "scheduler_disabled" | "paused" | "overlap" | "late" | "superseded";

/** Cumulative record of slots that were decided without dispatch, until acknowledged. */
export interface MissedSummary {
  readonly count: number;
  readonly firstUtcMs?: number;
  readonly latestUtcMs?: number;
  readonly byReason: Readonly<Partial<Record<MissedReason, number>>>;
}

/** Durable per-job planner state; persisted by the caller between ticks. */
export interface JobState {
  readonly jobId: string;
  /** Definition revision this cursor belongs to. */
  readonly revision: string;
  /** Every slot at or before this instant has been decided. Never moves backwards. */
  readonly cursorUtcMs: number;
  /** Whether the scheduler was enabled at the last tick that saw this job. */
  readonly enabledAtLastTick: boolean;
  readonly lastDispatchedId?: string;
  /** Set while a dispatched occurrence has not been completed; no slot starts meanwhile. */
  readonly running?: {
    readonly occurrenceId: string;
    readonly startedUtcMs: number;
  };
  readonly lastOutcome?: {
    readonly occurrenceId: string;
    readonly outcome: OccurrenceOutcome;
  };
  /** A durably paused job keeps its definition and reports each slot it skips. */
  readonly paused?: { readonly reason: string; readonly sinceUtcMs: number };
  readonly missed: MissedSummary;
}

/** How a dispatched occurrence ended; `uncertain` is for an effect whose outcome was not observed. */
export type OccurrenceOutcome =
  "succeeded" | "failed" | "cancelled" | "uncertain";

export interface TickInput {
  readonly nowUtcMs: number;
  /** Only the literal `true` enables dispatch; anything else is disabled (default deny). */
  readonly schedulingEnabled: unknown;
  readonly jobs: readonly JobDefinition[];
  readonly states: readonly JobState[];
  /** How long after its scheduled instant a slot still counts as on time (default DEFAULT_GRACE_MS). */
  readonly graceMs?: number;
}

/** A tick that runs within five minutes of a slot still runs it on time. */
export const DEFAULT_GRACE_MS = 5 * 60_000;

/** A planned occurrence; `catchUp` marks one run under the job's `latest` policy after it was late. */
export interface Dispatch extends Occurrence {
  readonly catchUp: boolean;
}

/** One planning decision for a job in this tick. */
export interface MissedReport {
  readonly jobId: string;
  readonly reason: MissedReason;
  readonly count: number;
  readonly firstUtcMs: number;
  readonly latestUtcMs: number;
}

export interface TickPlan {
  /** At most one occurrence per job; each still needs native admission before any effect. */
  readonly dispatch: readonly Dispatch[];
  readonly missed: readonly MissedReport[];
  /** Next states for every input state and every new job, in job order then retained states. */
  readonly states: readonly JobState[];
  /**
   * Jobs whose decided cursor is ahead of `nowUtcMs` (the clock moved back).
   * Their cursor does not move back, so nothing already decided runs again.
   */
  readonly clockRegressed: readonly string[];
}

const NO_MISSED: MissedSummary = Object.freeze({
  count: 0,
  byReason: Object.freeze({}),
});

function addMissed(
  summary: MissedSummary,
  reason: MissedReason,
  scan: OccurrenceScan,
): MissedSummary {
  if (scan.count === 0 || !scan.first || !scan.latest) return summary;
  return Object.freeze({
    count: summary.count + scan.count,
    firstUtcMs: summary.firstUtcMs ?? scan.first.scheduledUtcMs,
    latestUtcMs: scan.latest.scheduledUtcMs,
    byReason: Object.freeze({
      ...summary.byReason,
      [reason]: (summary.byReason[reason] ?? 0) + scan.count,
    }),
  });
}

function assertInstant(field: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new JobError("INVALID_TICK", `${field} must be an integer instant`);
  }
}

/**
 * Decides one scheduler tick. Pure: the caller supplies the clock, the
 * enablement flag and the persisted states, and persists the returned states
 * before acting on `dispatch`, so a crash after persisting can never replay a
 * dispatched slot (its id is recorded and the cursor has passed it).
 */
export function planTick(input: TickInput): TickPlan {
  assertInstant("nowUtcMs", input.nowUtcMs);
  const now = input.nowUtcMs;
  const enabled = input.schedulingEnabled === true;
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new JobError(
      "INVALID_TICK",
      "graceMs must be a non-negative integer",
    );
  }
  const jobs = input.jobs.map(validateJob);
  const ids = new Set<string>();
  for (const job of jobs) {
    if (ids.has(job.jobId)) throw new JobError("DUPLICATE_JOB", job.jobId);
    ids.add(job.jobId);
  }
  const previous = new Map<string, JobState>();
  for (const state of input.states) {
    if (previous.has(state.jobId)) {
      throw new JobError("DUPLICATE_STATE", state.jobId);
    }
    assertInstant("cursorUtcMs", state.cursorUtcMs);
    previous.set(state.jobId, state);
  }

  const dispatch: Dispatch[] = [];
  const clockRegressed: string[] = [];
  const missed: MissedReport[] = [];
  const states: JobState[] = [];
  const report = (
    jobId: string,
    reason: MissedReason,
    scan: OccurrenceScan,
  ) => {
    if (scan.count === 0 || !scan.first || !scan.latest) return;
    missed.push(
      Object.freeze({
        jobId,
        reason,
        count: scan.count,
        firstUtcMs: scan.first.scheduledUtcMs,
        latestUtcMs: scan.latest.scheduledUtcMs,
      }),
    );
  };

  for (const job of jobs) {
    const state = previous.get(job.jobId);
    previous.delete(job.jobId);
    if (!state) {
      // A new job starts at the current instant: it never backfills slots
      // that were scheduled before it existed.
      states.push(
        Object.freeze({
          jobId: job.jobId,
          revision: job.revision,
          cursorUtcMs: now,
          enabledAtLastTick: enabled,
          missed: NO_MISSED,
        }),
      );
      continue;
    }
    const window = scanOccurrences(job, state.cursorUtcMs, now);
    const cursorUtcMs = Math.max(state.cursorUtcMs, now);
    let summary = state.missed;
    let lastDispatchedId = state.lastDispatchedId;
    let running = state.running;
    if (now < state.cursorUtcMs) clockRegressed.push(job.jobId);
    if (state.revision !== job.revision) {
      // A changed definition starts at the current instant, like a new job:
      // slots are never run under a revision they were not scheduled by. The
      // old schedule is no longer known, so the gap is counted under the new
      // one and reported as superseded. A running occurrence stays recorded.
      report(job.jobId, "superseded", window);
      summary = addMissed(summary, "superseded", window);
    } else if (!enabled || !state.enabledAtLastTick) {
      // The first enabled tick after a disabled one only re-arms the job: the
      // whole window belongs to the disabled period, so re-enabling never runs
      // a slot implicitly, not even one catch-up (capability-map.md retention).
      report(job.jobId, "scheduler_disabled", window);
      summary = addMissed(summary, "scheduler_disabled", window);
    } else if (state.paused) {
      report(job.jobId, "paused", window);
      summary = addMissed(summary, "paused", window);
    } else if (running) {
      // A slot never starts while the previous occurrence is unfinished.
      report(job.jobId, "overlap", window);
      summary = addMissed(summary, "overlap", window);
    } else if (window.latest) {
      // At most one dispatch per job per tick, and only the latest slot:
      // earlier slots in the window are reported, never run as a burst. A
      // latest slot past the grace period runs only under the `latest`
      // catch-up policy; under `skip` it is reported too.
      const latest = window.latest;
      const onTime = now - latest.scheduledUtcMs <= graceMs;
      const alreadyDispatched = latest.occurrenceId === lastDispatchedId;
      const runs = !alreadyDispatched && (onTime || job.catchUp === "latest");
      const lateUntil =
        runs || alreadyDispatched ? latest.scheduledUtcMs - 1 : now;
      const late = scanOccurrences(job, state.cursorUtcMs, lateUntil);
      report(job.jobId, "late", late);
      summary = addMissed(summary, "late", late);
      if (runs) {
        dispatch.push(Object.freeze({ ...latest, catchUp: !onTime }));
        lastDispatchedId = latest.occurrenceId;
        running = Object.freeze({
          occurrenceId: latest.occurrenceId,
          startedUtcMs: now,
        });
      }
    }
    states.push(
      Object.freeze({
        ...state,
        revision: job.revision,
        cursorUtcMs,
        enabledAtLastTick: enabled,
        ...(lastDispatchedId !== undefined ? { lastDispatchedId } : {}),
        ...(running ? { running } : {}),
        missed: summary,
      }),
    );
  }
  // States whose definition is gone are retained unchanged and stay inspectable.
  for (const state of previous.values()) states.push(state);
  return Object.freeze({
    dispatch: Object.freeze(dispatch),
    missed: Object.freeze(missed),
    states: Object.freeze(states),
    clockRegressed: Object.freeze(clockRegressed),
  });
}

function stateWithout<K extends keyof JobState>(
  state: JobState,
  key: K,
): JobState {
  const { [key]: _removed, ...rest } = state;
  return rest as JobState;
}

/**
 * Records how the running occurrence ended and frees the job for its next
 * slot. Completing anything other than the running occurrence is refused, so
 * a late or duplicate completion cannot free a newer run.
 */
export function completeOccurrence(
  state: JobState,
  occurrenceId: string,
  outcome: OccurrenceOutcome,
): JobState {
  if (!state.running || state.running.occurrenceId !== occurrenceId) {
    throw new JobError("NOT_RUNNING", occurrenceId);
  }
  if (!["succeeded", "failed", "cancelled", "uncertain"].includes(outcome)) {
    throw new JobError("INVALID_OUTCOME", String(outcome));
  }
  return Object.freeze({
    ...stateWithout(state, "running"),
    lastOutcome: Object.freeze({ occurrenceId, outcome }),
  });
}

/** Durably pauses a job with a reason; it keeps its definition and reports each skipped slot. */
export function pauseJob(
  state: JobState,
  reason: string,
  nowUtcMs: number,
): JobState {
  assertInstant("nowUtcMs", nowUtcMs);
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new JobError("INVALID_PAUSE", "a pause needs a reason");
  }
  if (state.paused) return state;
  return Object.freeze({
    ...state,
    paused: Object.freeze({ reason, sinceUtcMs: nowUtcMs }),
  });
}

/**
 * Resumes a paused job from now on. Slots since its last decided instant are
 * reported as paused rather than replayed, even if no tick ran in between.
 */
export function resumeJob(
  job: JobDefinition,
  state: JobState,
  nowUtcMs: number,
): JobState {
  assertInstant("nowUtcMs", nowUtcMs);
  if (!state.paused) return state;
  const checked = validateJob(job);
  if (checked.jobId !== state.jobId) {
    throw new JobError("INVALID_JOB", "definition does not match the state");
  }
  const skipped = scanOccurrences(checked, state.cursorUtcMs, nowUtcMs);
  return Object.freeze({
    ...stateWithout(state, "paused"),
    cursorUtcMs: Math.max(state.cursorUtcMs, nowUtcMs),
    missed: addMissed(state.missed, "paused", skipped),
  });
}
