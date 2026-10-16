import { z } from "zod";

import { taskQuerySchema, type TaskQuery } from "./schema";

type SearchParams = Readonly<Record<string, string | string[] | undefined>>;

const uuid = z.uuid();

/** The default filters: open tasks, any timing, future-start tasks hidden, by due date. */
export const defaultTaskQuery: TaskQuery = taskQuerySchema.parse({});

/**
 * The task page's filters from its address. The filter form sends `hideFuture=0` and, when ticked,
 * `hideFuture=1` too; it sends a member's id as `assignee`. A value the page does not understand is
 * dropped (the defaults apply) rather than failing the page.
 */
export function parseTaskQuery(params: SearchParams): TaskQuery {
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) raw[key] = value;
  }
  const hide = raw.hideFuture;
  if (Array.isArray(hide)) raw.hideFuture = hide.includes("1") ? "1" : "0";
  const assignee = raw.assignee;
  if (typeof assignee === "string" && uuid.safeParse(assignee).success) {
    raw.assignee = "member";
    raw.member = assignee;
  }
  delete raw.offset;
  const parsed = taskQuerySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Keep what is valid field by field.
  const shape = taskQuerySchema.shape;
  const kept: Record<string, unknown> = {};
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    if (!(key in raw)) continue;
    if (shape[key].safeParse(raw[key]).success) kept[key] = raw[key];
  }
  return taskQuerySchema.safeParse(kept).data ?? defaultTaskQuery;
}

/** Whether any filter differs from the defaults (the list choice is not a filter). */
export function hasTaskFilters(query: TaskQuery): boolean {
  return (
    query.status !== defaultTaskQuery.status ||
    query.when !== defaultTaskQuery.when ||
    query.hideFuture !== defaultTaskQuery.hideFuture ||
    query.priority.length > 0 ||
    query.label.length > 0 ||
    query.assignee !== defaultTaskQuery.assignee ||
    query.sort !== defaultTaskQuery.sort
  );
}

/** The query as a query string (without offset), as the listing endpoint takes it. */
export function taskQueryString(query: TaskQuery): string {
  const params = new URLSearchParams();
  if (query.list) params.set("list", query.list);
  params.set("status", query.status);
  params.set("when", query.when);
  params.set("hideFuture", query.hideFuture);
  for (const priority of query.priority) params.append("priority", priority);
  for (const label of query.label) params.append("label", label);
  params.set("assignee", query.assignee);
  if (query.member) params.set("member", query.member);
  params.set("sort", query.sort);
  return params.toString();
}
