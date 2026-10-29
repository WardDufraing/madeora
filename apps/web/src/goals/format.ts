/** Client-safe helpers of goals (S30). */

/** The goals of a context: the Personal space (`null`) or a Home; or one goal's page. */
export function goalsPath(homeId: string | null, goalId?: string): string {
  const base = homeId ? `/homes/${encodeURIComponent(homeId)}/goals` : "/goals";
  return goalId ? `${base}/${encodeURIComponent(goalId)}` : base;
}

/** A recurring series' page, in its context. */
export function goalSeriesPath(homeId: string | null, seriesId: string): string {
  return `${goalsPath(homeId)}/series/${encodeURIComponent(seriesId)}`;
}

/** TanStack Query keys: everything under `all`, so one invalidation refreshes every goal view. */
export const goalKeys = {
  all: ["goals"] as const,
  list: (homeId: string | null, view: string) => ["goals", "list", homeId, view] as const,
  detail: (goalId: string) => ["goals", "detail", goalId] as const,
  entries: (goalId: string) => ["goals", "entries", goalId] as const,
  events: (goalId: string) => ["goals", "events", goalId] as const,
  series: (seriesId: string) => ["goals", "series", seriesId] as const,
  seriesPeriods: (seriesId: string) => ["goals", "series-periods", seriesId] as const,
};

/** A new client id for a goal or entry, so a retry never makes two. */
export function newId(): string {
  return crypto.randomUUID();
}
