import type { Database } from "@madeora/database";
import { z } from "zod";

import { nextDay, startOfDayInZone } from "@/trash/filters";

import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_OUTCOMES,
  ALL_ACTIVITY_KINDS,
  type ActivityCategory,
  type ActivityKind,
  type ActivityOutcome,
} from "./catalogue";

/**
 * The activity pages' filters as they appear in the address (`?category=&outcome=&from=&to=&home=
 * &q=&before=&beforeId=`), and their conversion to `list_my_activity`'s arguments. Dates are
 * calendar days in the viewer's own timezone. Anything malformed is dropped, never passed on.
 * Client-safe.
 */
export interface ActivityFilters {
  readonly category: ActivityCategory | "";
  readonly outcome: ActivityOutcome | "";
  readonly from: string;
  readonly to: string;
  readonly home: string;
  readonly q: string;
}

export interface ActivityCursor {
  readonly createdAt: string;
  readonly id: string;
}

export const MAX_QUERY_LENGTH = 100;

const dateOnly = z.iso.date();
const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });

type Params = Readonly<Record<string, string | string[] | undefined>>;

function one(params: Params, name: string): string {
  const value = params[name];
  return typeof value === "string" ? value : "";
}

export function parseActivityFilters(params: Params): ActivityFilters {
  const category = one(params, "category");
  const outcome = one(params, "outcome");
  const date = (name: string) =>
    dateOnly.safeParse(one(params, name)).success ? one(params, name) : "";
  const home = one(params, "home");
  return {
    category: (ACTIVITY_CATEGORIES as readonly string[]).includes(category)
      ? (category as ActivityCategory)
      : "",
    outcome: (ACTIVITY_OUTCOMES as readonly string[]).includes(outcome)
      ? (outcome as ActivityOutcome)
      : "",
    from: date("from"),
    to: date("to"),
    home: uuid.safeParse(home).success ? home : "",
    q: one(params, "q").trim().slice(0, MAX_QUERY_LENGTH),
  };
}

export function parseActivityCursor(params: Params): ActivityCursor | null {
  const createdAt = one(params, "before");
  const id = one(params, "beforeId");
  if (!instant.safeParse(createdAt).success || !uuid.safeParse(id).success) return null;
  return { createdAt, id };
}

export function hasActivityFilters(filters: ActivityFilters): boolean {
  return Boolean(
    filters.category || filters.outcome || filters.from || filters.to || filters.home || filters.q,
  );
}

/** Lower case without accents, so "verwijderd" finds "Verwijderd" and "e" finds "é". */
export function normalizeForSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("und");
}

/**
 * The event codes whose label (in the reader's language) contains the query. Only Madeora's own
 * labels are searched this way; the Home-name snapshot is matched by the database.
 */
export function matchingKinds(
  query: string,
  labelOf: (kind: ActivityKind) => string,
): ActivityKind[] {
  const needle = normalizeForSearch(query.trim());
  if (needle === "") return [];
  return ALL_ACTIVITY_KINDS.filter((kind) => normalizeForSearch(labelOf(kind)).includes(needle));
}

/** `list_my_activity`'s arguments, as the generated database types name them. */
export type ActivityQueryArgs = Database["public"]["Functions"]["list_my_activity"]["Args"];

/** The `list_my_activity` arguments. `scope` fixes the category (the Security activity page). */
export function activityQuery(input: {
  readonly filters: ActivityFilters;
  readonly cursor: ActivityCursor | null;
  readonly timeZone: string;
  readonly labelOf: (kind: ActivityKind) => string;
  readonly scope?: ActivityCategory;
  readonly limit: number;
}): ActivityQueryArgs {
  const { filters, cursor, timeZone, scope } = input;
  const category = scope ?? filters.category;
  return {
    ...(category ? { p_categories: [category] } : {}),
    ...(filters.outcome ? { p_outcomes: [filters.outcome] } : {}),
    ...(filters.from ? { p_from: startOfDayInZone(filters.from, timeZone).toISOString() } : {}),
    ...(filters.to ? { p_to: startOfDayInZone(nextDay(filters.to), timeZone).toISOString() } : {}),
    ...(filters.home && !scope ? { p_home_id: filters.home } : {}),
    ...(filters.q ? { p_kinds: matchingKinds(filters.q, input.labelOf), p_text: filters.q } : {}),
    ...(cursor ? { p_before_created_at: cursor.createdAt, p_before_id: cursor.id } : {}),
    p_limit: input.limit,
  };
}

/** The address of the next (older) page with the same filters. */
export function olderPageHref(
  path: string,
  filters: ActivityFilters,
  cursor: ActivityCursor,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  params.set("before", cursor.createdAt);
  params.set("beforeId", cursor.id);
  return `${path}?${params.toString()}`;
}

/** The address of the newest page with the same filters. */
export function newestPageHref(path: string, filters: ActivityFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
