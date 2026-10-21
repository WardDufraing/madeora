import type { ChorePoolRow } from "./api";

/**
 * The pool's filters and sort (S21; spec "unassigned chore pool filtering and sorting"). Client-safe
 * and pure: they only choose what this person sees. Claiming always re-checks everything in the
 * database, so a filter can never make a chore claimable. Points (filter and sort) come with S23.
 */
export const poolDurations = ["any", "none", "15", "30", "60", "more"] as const;
export type PoolDuration = (typeof poolDurations)[number];

export interface PoolFilter {
  /** "any", "none" (Uncategorized) or a category id. */
  readonly category: string;
  /** Due between these dates (inclusive); empty for no bound. */
  readonly from: string;
  readonly to: string;
  readonly duration: PoolDuration;
  readonly sort: "asc" | "desc";
  readonly onlyClaimable: boolean;
}

export const defaultPoolFilter: PoolFilter = {
  category: "any",
  from: "",
  to: "",
  duration: "any",
  sort: "asc",
  onlyClaimable: false,
};

export function isDefaultPoolFilter(filter: PoolFilter): boolean {
  return (
    filter.category === "any" &&
    filter.from === "" &&
    filter.to === "" &&
    filter.duration === "any" &&
    filter.sort === "asc" &&
    !filter.onlyClaimable
  );
}

function durationMatches(minutes: number | null, duration: PoolDuration): boolean {
  switch (duration) {
    case "any":
      return true;
    case "none":
      return minutes === null;
    case "more":
      return minutes !== null && minutes > 60;
    default:
      return minutes !== null && minutes <= Number(duration);
  }
}

/** The rows that match, in due-date order (either direction), ties by title then id. */
export function filterPool(
  rows: readonly ChorePoolRow[],
  filter: PoolFilter,
  collator: Intl.Collator,
): ChorePoolRow[] {
  const direction = filter.sort === "desc" ? -1 : 1;
  return rows
    .filter(
      (row) =>
        (filter.category === "any" ||
          (filter.category === "none"
            ? row.category === null
            : row.category?.id === filter.category)) &&
        (filter.from === "" || row.dueDate >= filter.from) &&
        (filter.to === "" || row.dueDate <= filter.to) &&
        durationMatches(row.minutes, filter.duration) &&
        (!filter.onlyClaimable || row.eligible),
    )
    .sort(
      (a, b) =>
        direction * a.dueDate.localeCompare(b.dueDate) ||
        collator.compare(a.title, b.title) ||
        a.id.localeCompare(b.id),
    );
}
