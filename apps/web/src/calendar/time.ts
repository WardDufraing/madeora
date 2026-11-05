/**
 * Local wall-clock times in an IANA timezone (S32), for the event form's daylight-saving notes. The
 * database decides again (`nonexistent_time`); this only lets the form say why and offer the next
 * time that exists. Client-safe, `Intl` only.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function wallClockOf(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US-u-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  const local = wallClockOf(instant, timeZone);
  return Date.parse(`${local}:00Z`) - Math.floor(instant / MINUTE) * MINUTE;
}

/**
 * The instants that show as `date` `time` in `timeZone`: none in a spring-forward gap, two in a
 * fall-back overlap (earliest first), else one.
 */
export function instantsOf(date: string, time: string, timeZone: string): number[] {
  const wall = Date.parse(`${date}T${time}:00Z`);
  if (Number.isNaN(wall)) return [];
  const offsets = new Set([
    offsetAt(wall - 12 * HOUR, timeZone),
    offsetAt(wall + 12 * HOUR, timeZone),
  ]);
  const found = new Set<number>();
  for (const offset of offsets) {
    const instant = wall - offset;
    if (wallClockOf(instant, timeZone) === `${date}T${time}`) found.add(instant);
  }
  return [...found].sort((a, b) => a - b);
}

export type LocalTimeKind = "exists" | "nonexistent" | "ambiguous";

export function localTimeKind(date: string, time: string, timeZone: string): LocalTimeKind {
  const count = instantsOf(date, time, timeZone).length;
  return count === 0 ? "nonexistent" : count > 1 ? "ambiguous" : "exists";
}

/** The first time on `date` after a nonexistent `time` that does exist ("02:30" → "03:00"). */
export function nextValidTime(date: string, time: string, timeZone: string): string | null {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  for (let total = hours * 60 + minutes + 1; total < 24 * 60; total += 1) {
    const candidate = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    if (instantsOf(date, candidate, timeZone).length > 0) return candidate;
  }
  return null;
}
