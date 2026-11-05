/**
 * Times and repeat rules for writing to Google (S34). Pure, `Intl` only.
 *
 * - Timed events go to Google as a local wall-clock time plus an IANA zone, so a repeating event keeps its
 *   time across daylight-saving changes; `wallClock` and `instantOf` convert between instants and local times.
 * - Madeora's repeat rule (the S19/S32 shape) becomes one RRULE line: daily, weekly on weekdays, monthly with
 *   the last-day fallback for the 29th to 31st (`BYMONTHDAY=28,…,d;BYSETPOS=-1`), yearly with 29 February
 *   falling back to 28 February, every n, until a local date or n times.
 * - A series split ("this and following") ends the old series just before the occurrence: `UNTIL` in UTC for a
 *   timed series (RFC 5545 requires UTC when the start has a zone), the day before for an all-day one.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The local wall-clock time of an instant in a zone, as `YYYY-MM-DDTHH:mm:ss`. */
export function wallClock(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US-u-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

function offsetAt(instant: number, timeZone: string): number {
  const second = Math.floor(instant / 1000) * 1000;
  return Date.parse(`${wallClock(second, timeZone)}Z`) - second;
}

/**
 * The instant shown as `local` (`YYYY-MM-DDTHH:mm[:ss]`) in a zone. In a fall-back overlap the later one
 * (standard time, as PostgreSQL and the native calendar resolve it); in a spring-forward gap the time moves
 * forward by the gap. Null for a malformed value.
 */
export function instantOf(local: string, timeZone: string): number | null {
  const normalized = local.length === 16 ? `${local}:00` : local;
  const wall = Date.parse(`${normalized}Z`);
  if (Number.isNaN(wall)) return null;
  const offsets = [
    ...new Set([offsetAt(wall - 12 * HOUR, timeZone), offsetAt(wall + 12 * HOUR, timeZone)]),
  ];
  const matches = offsets
    .map((offset) => wall - offset)
    .filter((instant) => wallClock(instant, timeZone) === normalized)
    .sort((a, b) => a - b);
  if (matches.length > 0) return matches[matches.length - 1] ?? null;
  // A gap: the earlier offset (before the change) moves the time forward by the gap.
  const before = offsetAt(wall - 12 * HOUR, timeZone);
  return wall - before;
}

export function addDays(day: string, days: number): string {
  const value = new Date(`${day}T00:00:00Z`);
  return new Date(value.getTime() + days * DAY).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

const compact = (iso: string) => iso.replace(/[-:]/g, "");

/** An instant as an RFC 5545 UTC date-time (`YYYYMMDDTHHMMSSZ`). */
export function utcStamp(instant: number): string {
  return `${compact(new Date(instant).toISOString().slice(0, 19))}Z`;
}

export const repeatFrequencies = ["daily", "weekly", "monthly", "yearly"] as const;

/** Madeora's repeat rule (apps/web/src/calendar/schema.ts eventRepeatSchema). */
export interface RepeatRule {
  readonly frequency: (typeof repeatFrequencies)[number];
  readonly interval: number;
  /** ISO weekdays 1 (Monday) to 7 (Sunday); weekly only. */
  readonly weekdays: readonly number[] | null;
  /** The last local date an occurrence may start on (inclusive). */
  readonly endsOn: string | null;
  readonly count: number | null;
}

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/**
 * The RRULE line for a rule starting on `startsOn`. `timeZone` is the event's zone for a timed event (the
 * until date then means up to the end of that local day) and null for an all-day one.
 */
export function rruleFor(rule: RepeatRule, startsOn: string, timeZone: string | null): string {
  const parts = [`FREQ=${rule.frequency.toUpperCase()}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${String(rule.interval)}`);
  if (rule.frequency === "weekly" && rule.weekdays && rule.weekdays.length > 0) {
    parts.push(
      `BYDAY=${[...rule.weekdays]
        .sort((a, b) => a - b)
        .map((day) => WEEKDAYS[day - 1] ?? "MO")
        .join(",")}`,
    );
  }
  const day = Number(startsOn.slice(8, 10));
  if (rule.frequency === "monthly" && day > 28) {
    const days = Array.from({ length: day - 27 }, (_, index) => String(28 + index));
    parts.push(`BYMONTHDAY=${days.join(",")}`, "BYSETPOS=-1");
  }
  if (rule.frequency === "yearly" && startsOn.slice(5) === "02-29") {
    parts.push("BYMONTH=2", "BYMONTHDAY=28,29", "BYSETPOS=-1");
  }
  if (rule.endsOn !== null) {
    if (timeZone === null) {
      parts.push(`UNTIL=${compact(rule.endsOn)}`);
    } else {
      const endOfDay = instantOf(`${addDays(rule.endsOn, 1)}T00:00:00`, timeZone);
      parts.push(`UNTIL=${utcStamp((endOfDay ?? Date.parse(`${rule.endsOn}T23:59:59Z`)) - 1000)}`);
    }
  } else if (rule.count !== null) {
    parts.push(`COUNT=${String(rule.count)}`);
  }
  return `RRULE:${parts.join(";")}`;
}

/** A Google series that Madeora cannot change safely (a counted or date-listed series for a split). */
export class SeriesLimitError extends Error {
  constructor(readonly code: "count" | "rdate" | "no_rule") {
    super(`series cannot be changed safely: ${code}`);
    this.name = "SeriesLimitError";
  }
}

/** The `UNTIL` value that ends a series just before an occurrence's original start. */
export function untilBefore(originalStart: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(originalStart)) return compact(addDays(originalStart, -1));
  return utcStamp(Date.parse(originalStart) - 1000);
}

/**
 * A series' recurrence lines ended at `until` (from `untilBefore`): `COUNT` and any later `UNTIL` give way.
 * Exception dates stay. Refused for a series with extra dates (`RDATE`), which `UNTIL` does not end.
 */
export function endRecurrence(lines: readonly string[], until: string): string[] {
  if (!lines.some((line) => line.startsWith("RRULE:"))) throw new SeriesLimitError("no_rule");
  if (lines.some((line) => line.startsWith("RDATE"))) throw new SeriesLimitError("rdate");
  return lines.map((line) => {
    if (!line.startsWith("RRULE:")) return line;
    const parts = line
      .slice(6)
      .split(";")
      .filter((part) => part !== "");
    const existing = parts.find((part) => part.startsWith("UNTIL="))?.slice(6);
    const kept = parts.filter((part) => !part.startsWith("UNTIL=") && !part.startsWith("COUNT="));
    // An earlier end stays (compared on the date, then the time).
    const end =
      existing !== undefined && existing.slice(0, 8) < until.slice(0, 8) ? existing : until;
    return `RRULE:${[...kept, `UNTIL=${end}`].join(";")}`;
  });
}

/**
 * The recurrence lines a new series ("this and following") continues with: the old rule as it was. Refused
 * for a counted series (Google cannot keep the remaining count safely) or one with extra dates.
 */
export function continueRecurrence(lines: readonly string[]): string[] {
  if (!lines.some((line) => line.startsWith("RRULE:"))) throw new SeriesLimitError("no_rule");
  if (lines.some((line) => line.startsWith("RDATE"))) throw new SeriesLimitError("rdate");
  if (lines.some((line) => line.startsWith("RRULE:") && /(^|;)COUNT=/.test(line.slice(6)))) {
    throw new SeriesLimitError("count");
  }
  return [...lines];
}
