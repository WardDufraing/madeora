/** Typed TanStack Query keys, always scoped by account (architecture.md §9). */
export const choreKeys = {
  all: ["chores"] as const,
  history: (userId: string, choreId: string, filter: string, loadedAt: string) =>
    ["chores", userId, "history", choreId, filter, loadedAt] as const,
  homeHistory: (userId: string, homeId: string, search: string, loadedAt: string) =>
    ["chores", userId, "home-history", homeId, search, loadedAt] as const,
};

/** Where a Home's chore pages live. */
export function choresPath(homeId: string): string {
  return `/homes/${homeId}/chores`;
}

/** The wall-clock date and time of an instant in `zone` ("2026-10-21", "18:05"). */
export function zonedParts(instant: string, zone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "00";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

/**
 * The instant a wall-clock `date` and `time` name in `zone` (an ISO string), never guessing: a time
 * that does not exist that day (a daylight-saving gap) is null; a time that happens twice (the
 * clocks going back) is the first of the two.
 */
export function instantFromZoned(date: string, time: string, zone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const clock = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !clock) return null;
  const local = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(clock[1]),
    Number(clock[2]),
  );
  if (Number.isNaN(local)) return null;
  const offsetAt = (ms: number) => {
    const wall = zonedParts(new Date(ms).toISOString(), zone);
    const [y, m, d] = wall.date.split("-").map(Number);
    const [h, mi] = wall.time.split(":").map(Number);
    return (
      Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0) - Math.floor(ms / 60_000) * 60_000
    );
  };
  const hours12 = 12 * 3_600_000;
  const candidates = [...new Set([offsetAt(local - hours12), offsetAt(local + hours12)])]
    .map((offset) => local - offset)
    .filter((instant) => {
      const wall = zonedParts(new Date(instant).toISOString(), zone);
      return wall.date === date && wall.time === time;
    })
    .sort((a, b) => a - b);
  const first = candidates[0];
  return first === undefined ? null : new Date(first).toISOString();
}
