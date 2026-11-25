import { z } from "zod";

import { defaultTaskQuery } from "./filters";
import { tasksPath } from "./format";
import type { TaskQuery } from "./schema";

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

/** The Tasks workspace's views (redesign decision 46); the Calendar is its own page. */
export const taskViews = ["today", "upcoming", "all", "lists"] as const;
export type TaskView = (typeof taskViews)[number];

/** Parameters that only the All and Lists views understand. */
const filterKeys = [
  "status",
  "when",
  "hideFuture",
  "priority",
  "label",
  "assignee",
  "member",
  "sort",
] as const;

/**
 * The view an address asks for. Today is the starting point. Addresses from before the views
 * existed keep working: a list means the Lists view, any filter means the All view.
 */
export function parseTaskView(params: SearchParams): TaskView {
  const asked = params.view;
  const value = Array.isArray(asked) ? asked[0] : asked;
  const parsed = z.enum(taskViews).safeParse(value);
  if (parsed.success) return parsed.data;
  if (typeof params.list === "string") return "lists";
  if (filterKeys.some((key) => params[key] !== undefined)) return "all";
  return "today";
}

/** The open tasks of a Today / Upcoming group: one timing filter, default order. */
export function groupQuery(when: TaskQuery["when"]): TaskQuery {
  return { ...defaultTaskQuery, status: "open", when };
}

export type TaskGroupId = "overdue" | "today" | "undated" | "week" | "later";

export const viewGroups: Readonly<
  Record<"today" | "upcoming", readonly { id: TaskGroupId; when: TaskQuery["when"] }[]>
> = {
  today: [
    { id: "overdue", when: "overdue" },
    { id: "today", when: "due_today" },
    { id: "undated", when: "undated" },
  ],
  upcoming: [
    { id: "week", when: "due_week" },
    { id: "later", when: "upcoming" },
  ],
};

/** An address inside the workspace, keeping the parts that belong to the current place. */
export function viewHref(
  homeId: string | null,
  view: TaskView,
  options: { readonly list?: string | undefined; readonly task?: string | undefined } = {},
): string {
  const params = new URLSearchParams({ view });
  if (options.list && view === "lists") params.set("list", options.list);
  if (options.task) params.set("task", options.task);
  return `${tasksPath(homeId)}?${params.toString()}`;
}

/** Whole days an open task is past its due date (both calendar dates in the context's zone). */
export function daysOverdue(dueDate: string, today: string): number {
  const day = 86_400_000;
  const diff = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`);
  return Math.max(0, Math.round(diff / day));
}

/** An overdue task this late (days) also gets a quiet warm tint and a warning mark (decision 53). */
export const SIGNIFICANTLY_OVERDUE_DAYS = 7;
