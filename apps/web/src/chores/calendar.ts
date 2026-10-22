import { z } from "zod";

import { dateOnlySchema } from "@/tasks/schema";

import type { ChoreAgendaItem } from "./api";

/**
 * The Chores calendar and the schedule widget (S21). Client-safe and pure: the calendar's address
 * (`view`, `date`, `day`, `member`, `category`), the filters applied to a schedule read, and which
 * items a chore manager may move. Dates are calendar dates in the Home's timezone; "today" comes from
 * the database.
 */

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

export const choreCalendarViews = ["week", "month"] as const;
export type ChoreCalendarView = (typeof choreCalendarViews)[number];

export interface ChoreCalendarQuery {
  readonly view: ChoreCalendarView;
  readonly date: string | null;
  readonly day: string | null;
  /** A membership id, "unassigned", or null for anyone. */
  readonly member: string | null;
  /** A category id, "none" (uncategorized), or null for any. */
  readonly category: string | null;
}

const uuid = z.uuid();

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The calendar's settings from its address; anything it does not understand is dropped. */
export function parseChoreCalendarQuery(params: SearchParams): ChoreCalendarQuery {
  const view = one(params.view);
  const date = one(params.date);
  const day = one(params.day);
  const member = one(params.member);
  const category = one(params.category);
  return {
    view: view === "month" ? "month" : "week",
    date: date && dateOnlySchema.safeParse(date).success ? date : null,
    day: day && dateOnlySchema.safeParse(day).success ? day : null,
    member: member === "unassigned" || (member && uuid.safeParse(member).success) ? member : null,
    category:
      category === "none" || (category && uuid.safeParse(category).success) ? category : null,
  };
}

/** The calendar's address with some settings changed; defaults are left out. */
export function choreCalendarQueryString(
  query: ChoreCalendarQuery,
  changes: Partial<ChoreCalendarQuery> = {},
): string {
  const next = { ...query, ...changes };
  const params = new URLSearchParams();
  if (next.view !== "week") params.set("view", next.view);
  if (next.date) params.set("date", next.date);
  if (next.day) params.set("day", next.day);
  if (next.member) params.set("member", next.member);
  if (next.category) params.set("category", next.category);
  return params.toString();
}

/** The items that match the member and category filters. */
export function filterAgenda(
  items: readonly ChoreAgendaItem[],
  filter: Pick<ChoreCalendarQuery, "member" | "category">,
): ChoreAgendaItem[] {
  return items.filter((item) => {
    if (filter.member === "unassigned" && item.assigneeIds.length > 0) return false;
    if (
      filter.member &&
      filter.member !== "unassigned" &&
      !item.assigneeIds.includes(filter.member)
    ) {
      return false;
    }
    if (filter.category === "none" && item.category !== null) return false;
    if (filter.category && filter.category !== "none" && item.category?.id !== filter.category) {
      return false;
    }
    return true;
  });
}

/**
 * Whether a chore manager may move an item to another date or member (spec "Confirmed chore
 * calendar and rescheduling"): an existing open occurrence that is not waiting for approval, not in
 * rework and not closed. A projected date has no occurrence yet. The database checks again.
 */
export function isMovable(item: ChoreAgendaItem): boolean {
  return (
    !item.projected &&
    item.id !== null &&
    item.revision !== null &&
    item.status === "open" &&
    !item.inRework
  );
}

/** The items by date, in the order the schedule answered them. */
export function byDate(items: readonly ChoreAgendaItem[]): Map<string, ChoreAgendaItem[]> {
  const map = new Map<string, ChoreAgendaItem[]>();
  for (const item of items) map.set(item.date, [...(map.get(item.date) ?? []), item]);
  return map;
}

/** The state words an item needs beyond its title (never colour alone). */
export type ChoreItemState =
  | "overdue"
  | "pending"
  | "rework"
  | "completed"
  | "skipped"
  | "expired"
  | "paused"
  | "review"
  | "awaiting"
  | "planned";

export function itemStates(item: ChoreAgendaItem): ChoreItemState[] {
  const states: ChoreItemState[] = [];
  if (item.projected) states.push("planned");
  if (item.status === "pending_approval") states.push("pending");
  if (item.status === "completed") states.push("completed");
  if (item.status === "skipped") states.push("skipped");
  if (item.status === "expired") states.push("expired");
  if (item.status === "paused") states.push("paused");
  if (item.status === "open" && item.inRework) states.push("rework");
  if (item.overdue) states.push("overdue");
  if (item.awaitingVolunteer) states.push("awaiting");
  else if (item.status === "open" && item.needsReassignment && item.assigneeIds.length === 0) {
    states.push("review");
  }
  return states;
}
