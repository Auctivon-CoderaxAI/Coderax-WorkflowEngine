import type { ScheduleCondition, ScheduleTiming } from '@coderax/contracts';
import type { ScheduleRecord } from '../domain.js';

/**
 * Recurrence math without a scheduler dependency.
 *
 * A calendar schedule is a wall-clock rule in an IANA zone, so the engine
 * resolves it through `Intl` rather than by adding a fixed offset. That is what
 * keeps a 09:00 schedule at 09:00 across a daylight-saving transition instead of
 * drifting an hour. The functions here are pure and deterministic: a tick can be
 * replayed, and two replicas compute the same occurrence key from the same
 * record.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

const partFormats = new Map<string, Intl.DateTimeFormat>();
const weekdayFormats = new Map<string, Intl.DateTimeFormat>();

function partFormat(timeZone: string): Intl.DateTimeFormat {
  const existing = partFormats.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  partFormats.set(timeZone, created);
  return created;
}

function weekdayFormat(timeZone: string): Intl.DateTimeFormat {
  const existing = weekdayFormats.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
  weekdayFormats.set(timeZone, created);
  return created;
}

export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = partFormat(timeZone).formatToParts(at);
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : Number.NaN;
  };
  const weekdayName = weekdayFormat(timeZone)
    .formatToParts(at)
    .find((part) => part.type === 'weekday')?.value;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    weekday: Math.max(0, WEEKDAYS.indexOf((weekdayName ?? 'Sun') as (typeof WEEKDAYS)[number])),
  };
}

/**
 * Resolves a wall-clock time in a zone to an instant.
 *
 * The offset is discovered by comparing the zone's local reading of a candidate
 * instant with the desired reading and correcting twice. A wall time that does
 * not exist (the spring-forward gap) is advanced to the first existing wall time
 * at or after it, so a schedule never silently disappears for a day.
 */
export function zonedWallTimeToInstant(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date | null {
  const desired = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = localParts(new Date(guess), timeZone);
    const actual = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0,
    );
    if (actual === desired) return new Date(guess);
    guess += desired - actual;
  }

  let candidate = guess;
  for (let step = 0; step < 8; step += 1) {
    const parts = localParts(new Date(candidate), timeZone);
    const actual = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0,
    );
    if (actual >= desired && actual - desired <= 3 * 3_600_000) return new Date(candidate);
    candidate += 15 * 60_000;
  }
  return null;
}

function nextCalendar(timing: Extract<ScheduleTiming, { kind: 'calendar' }>, after: Date): Date | null {
  const start = localParts(after, timing.timeZone);
  const localMidnight = Date.UTC(start.year, start.month - 1, start.day);
  // Nine days covers a once-a-week rule whose time has already passed today,
  // plus the daylight-saving edge where today's wall time does not exist.
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = new Date(localMidnight + offset * DAY_MS);
    const weekday = day.getUTCDay();
    if (timing.daysOfWeek && !timing.daysOfWeek.includes(weekday)) continue;
    const instant = zonedWallTimeToInstant(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: timing.hour,
        minute: timing.minute,
      },
      timing.timeZone,
    );
    if (instant && instant.getTime() > after.getTime()) return instant;
  }
  return null;
}

/** The first occurrence strictly after `after`, or null when there is none. */
export function nextOccurrence(
  timing: ScheduleTiming,
  after: Date,
  createdAt: Date,
): Date | null {
  switch (timing.kind) {
    case 'once': {
      const at = new Date(timing.at);
      return at.getTime() > after.getTime() ? at : null;
    }
    case 'interval': {
      const every = timing.everySeconds * 1_000;
      const anchor = new Date(timing.anchor ?? createdAt.toISOString()).getTime();
      if (after.getTime() < anchor) return new Date(anchor);
      const steps = Math.floor((after.getTime() - anchor) / every) + 1;
      return new Date(anchor + steps * every);
    }
    case 'calendar':
      return nextCalendar(timing, after);
    case 'event':
      return null;
  }
}

/** The next occurrence in the schedule's own recurrence, from `after`. */
export function nextScheduleRun(schedule: ScheduleRecord, after: Date): Date | null {
  return nextOccurrence(schedule.timing, after, new Date(schedule.createdAt));
}

export function evaluateCondition(
  condition: ScheduleCondition,
  summary: string,
): 'met' | 'unmet' {
  const haystack = summary.toLocaleLowerCase();
  switch (condition.kind) {
    case 'always':
      return 'met';
    case 'result_contains':
      return haystack.includes(condition.text.toLocaleLowerCase()) ? 'met' : 'unmet';
    case 'result_absent':
      return haystack.includes(condition.text.toLocaleLowerCase()) ? 'unmet' : 'met';
  }
}

export type DueDecision =
  | { kind: 'run'; dueAt: Date; lateMs: number }
  | { kind: 'missed'; dueAt: Date; lateMs: number }
  | { kind: 'none' };

/**
 * Whether a stored next run is due, late enough to count as missed, or not yet.
 *
 * A late occurrence is never fired more than once: the caller advances the
 * schedule to the next occurrence after `now`, so a long outage produces one
 * receipt (and optionally one catch-up run), not a backlog storm.
 */
export function decideDue(input: {
  schedule: Pick<ScheduleRecord, 'state' | 'nextRunAt'>;
  now: Date;
  missedGraceMs: number;
}): DueDecision {
  if (input.schedule.state !== 'active' || input.schedule.nextRunAt === null) {
    return { kind: 'none' };
  }
  const dueAt = new Date(input.schedule.nextRunAt);
  const lateMs = input.now.getTime() - dueAt.getTime();
  if (lateMs < 0) return { kind: 'none' };
  return lateMs <= input.missedGraceMs
    ? { kind: 'run', dueAt, lateMs }
    : { kind: 'missed', dueAt, lateMs };
}

export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function nextUtcDayStart(at: Date): Date {
  return new Date(utcDayStart(at).getTime() + DAY_MS);
}

export function utcDayKey(at: Date): string {
  return utcDayStart(at).toISOString().slice(0, 10);
}
