/** Client-safe helpers of habits (S28). */

/** The habits of a context: the Personal space (`null`) or a Home; or one habit's page. */
export function habitsPath(homeId: string | null, habitId?: string): string {
  const base = homeId ? `/homes/${encodeURIComponent(homeId)}/habits` : "/habits";
  return habitId ? `${base}/${encodeURIComponent(habitId)}` : base;
}

/** TanStack Query keys: everything under `all`, so one invalidation refreshes every habit view. */
export const habitKeys = {
  all: ["habits"] as const,
  insights: (habitId: string, days: number) => ["habits", "insights", habitId, days] as const,
  calendar: (habitId: string, month: string) => ["habits", "calendar", habitId, month] as const,
  history: (habitId: string, kind: "checkins" | "events") =>
    ["habits", "history", habitId, kind] as const,
  vacation: (vacationId: string) => ["habits", "vacation", vacationId] as const,
};

/** A calendar date in the viewer's language, never converted through their timezone. */
export function formatHabitDate(
  date: string,
  locale: string,
  style: "long" | "short" | "weekday" | "month" = "long",
): string {
  const options: Intl.DateTimeFormatOptions =
    style === "weekday"
      ? { weekday: "short", timeZone: "UTC" }
      : style === "short"
        ? { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }
        : style === "month"
          ? { month: "long", year: "numeric", timeZone: "UTC" }
          : { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" };
  return new Intl.DateTimeFormat(locale, options).format(new Date(`${date}T00:00:00Z`));
}

/** An ISO weekday's short name in the viewer's language. */
export function formatWeekday(weekday: number, locale: string, style: "short" | "long" = "short") {
  // 2024-01-01 was a Monday.
  const day = String(weekday).padStart(2, "0");
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(
    new Date(`2024-01-${day}T00:00:00Z`),
  );
}

/** A completion rate as a whole percentage, or null when nothing was eligible. */
export function completionRate(completed: number, eligible: number): number | null {
  return eligible === 0 ? null : Math.round((completed / eligible) * 100);
}

/** A new client id for a habit or check-in, so a retry never makes two. */
export function newId(): string {
  return crypto.randomUUID();
}
