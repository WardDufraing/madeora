import "server-only";

import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { isoDate } from "@/preferences/regional";
import { getEffectiveTimeZone } from "@/preferences/server";

import type { CommentPage, TaskDetail, TaskLabel, TaskListSummary, TaskPage, TaskRow } from "./api";
import { logTasks } from "./log";
import { isLabelColor, TASK_LIMITS, taskPriorities, type TaskQuery } from "./schema";

/**
 * Server reads of tasks (S18), always with the signed-in person's own Supabase session: the database
 * answers only what they may see now, so a Home they left or a task that is not theirs is simply not
 * there. Nothing here is cached across requests (personalized data, architecture.md §9).
 */

export type Read<T> =
  | { readonly status: "ok"; readonly value: T }
  /** Not a Home the person belongs to (or none such), or not theirs to see. */
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/** Widens a value to include null, because the generated database types do not. */
function nullable<T>(value: T): T | null {
  return value;
}

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501") return { status: "not-found" };
  logTasks(event, error.code);
  return { status: "unavailable" };
}

const homeArg = (homeId: string | null) => (homeId ? { p_home_id: homeId } : {});

/** The person's "today" for their Personal space, in their effective timezone (a Home uses its own). */
export async function personalToday(): Promise<string> {
  const zone = await getEffectiveTimeZone();
  return isoDate(new Date(), zone.timeZone);
}

export interface TaskContextInfo {
  readonly canManage: boolean;
  readonly today: string;
}

export async function getTaskContext(homeId: string | null): Promise<Read<TaskContextInfo>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_task_context", {
    ...homeArg(homeId),
    p_today: await personalToday(),
  });
  if (error) return failed("tasks.context_failed", error);
  const row = data[0];
  if (!row) return { status: "unavailable" };
  return { status: "ok", value: { canManage: row.can_manage, today: row.today } };
}

export async function listTaskLists(
  homeId: string | null,
  includeArchived: boolean,
): Promise<Read<readonly TaskListSummary[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_task_lists", {
    ...homeArg(homeId),
    p_include_archived: includeArchived,
  });
  if (error) return failed("tasks.lists_failed", error);
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      name: row.name,
      position: row.position,
      archived: row.archived,
      revision: row.revision,
      openTasks: row.open_tasks,
      activeTasks: row.active_tasks,
    })),
  };
}

const colorOf = (value: string | null): TaskLabel["color"] => (isLabelColor(value) ? value : null);
const priorityOf = (value: string | null) =>
  (taskPriorities as readonly string[]).includes(value ?? "")
    ? (value as TaskRow["priority"])
    : null;

export async function listTaskLabels(homeId: string | null): Promise<Read<readonly TaskLabel[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_task_labels", homeArg(homeId));
  if (error) return failed("tasks.labels_failed", error);
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      name: row.name,
      color: colorOf(nullable(row.color)),
      revision: row.revision,
      taskCount: row.task_count,
    })),
  };
}

/** One page of tasks for the filters; `pageSize` at most 50. */
export async function listTasks(
  homeId: string | null,
  query: TaskQuery,
  pageSize: number = TASK_LIMITS.page,
): Promise<Read<TaskPage>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_tasks", {
    ...homeArg(homeId),
    ...(query.list ? { p_list_id: query.list } : {}),
    p_today: await personalToday(),
    p_status: query.status,
    p_when: query.when,
    p_hide_future: query.hideFuture === "1",
    ...(query.priority.length > 0 ? { p_priorities: query.priority } : {}),
    ...(query.label.length > 0 ? { p_label_ids: query.label } : {}),
    p_assignee: query.assignee === "member" && !query.member ? "any" : query.assignee,
    ...(query.assignee === "member" && query.member ? { p_assignee_member: query.member } : {}),
    p_sort: query.sort,
    p_limit: pageSize,
    p_offset: query.offset,
  });
  if (error) {
    // A filter naming something malformed reads as "nothing matches", not as a failure; it is
    // still logged, so a defect in how the page builds filters does not go unnoticed.
    if (error.code === "22023") {
      logTasks("tasks.list_invalid_filter", error.code);
      return { status: "ok", value: { tasks: [], total: 0 } };
    }
    return failed("tasks.list_failed", error);
  }
  return {
    status: "ok",
    value: {
      total: data[0]?.total_count ?? 0,
      tasks: data.map((row): TaskRow => ({
        id: row.id,
        listId: row.list_id,
        listName: row.list_name,
        title: row.title,
        startDate: nullable(row.start_date),
        dueDate: nullable(row.due_date),
        priority: priorityOf(nullable(row.priority)),
        completed: nullable(row.completed_at) !== null,
        needsReassignment: row.needs_reassignment,
        overdue: row.overdue,
        upcoming: row.upcoming,
        subtasksDone: row.subtasks_done,
        subtasksTotal: row.subtasks_total,
        commentCount: row.comment_count,
        labelIds: row.label_ids,
        assigneeIds: row.assignee_member_ids,
        assignedToMe: row.assigned_to_me,
        canComplete: row.can_complete,
        revision: row.revision,
      })),
    },
  };
}

const person = z.object({ me: z.boolean(), member: z.uuid().nullable() });
const detailSchema = z.object({
  id: z.uuid(),
  homeId: z.uuid().nullable(),
  list: z.object({ id: z.uuid(), name: z.string(), archived: z.boolean() }),
  title: z.string(),
  description: z.string().nullable(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  priority: z.enum(taskPriorities).nullable(),
  revision: z.int(),
  needsReassignment: z.boolean(),
  overdue: z.boolean(),
  upcoming: z.boolean(),
  createdAt: z.string(),
  createdBy: person,
  updatedAt: z.string(),
  updatedBy: person,
  completedAt: z.string().nullable(),
  completedBy: person.nullable(),
  reopenedAt: z.string().nullable(),
  reopenedBy: person.nullable(),
  assignees: z.array(z.uuid()),
  labels: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      color: z
        .string()
        .nullable()
        .transform((value) => (isLabelColor(value) ? value : null)),
    }),
  ),
  subtasks: z.array(
    z.object({ id: z.uuid(), title: z.string(), completed: z.boolean(), revision: z.int() }),
  ),
  commentCount: z.int(),
  can: z.object({
    edit: z.boolean(),
    complete: z.boolean(),
    assign: z.boolean(),
    delete: z.boolean(),
    comment: z.boolean(),
  }),
});

/** One task's details, or not-found when it is missing, deleted or not the person's to see. */
export async function getTask(taskId: string): Promise<Read<TaskDetail>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_task", {
    p_task_id: taskId,
    p_today: await personalToday(),
  });
  if (error) {
    if (error.code === "22023" || error.code === "22P02") return { status: "not-found" };
    return failed("tasks.get_failed", error);
  }
  if (data === null) return { status: "not-found" };
  const parsed = detailSchema.safeParse(data);
  if (!parsed.success) {
    logTasks("tasks.get_unexpected_shape", "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

export async function listTaskComments(taskId: string, offset: number): Promise<Read<CommentPage>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_task_comments", {
    p_task_id: taskId,
    p_offset: offset,
    p_limit: TASK_LIMITS.commentsPage,
  });
  if (error) {
    if (error.code === "22023") return { status: "not-found" };
    return failed("tasks.comments_failed", error);
  }
  return {
    status: "ok",
    value: {
      total: data[0]?.total_count ?? 0,
      comments: data.map((row) => ({
        id: row.id,
        body: row.body,
        createdAt: row.created_at,
        editedAt: nullable(row.edited_at),
        revision: row.revision,
        author: { me: row.author_me, member: nullable(row.author_member) },
      })),
    },
  };
}

export interface TaskMember {
  /** Membership id: how tasks name people (never an account id). */
  readonly id: string;
  readonly name: string | null;
  readonly isSelf: boolean;
}

/** The Home's current members for assignee pickers and names (public.home_directory). */
export async function listTaskMembers(homeId: string): Promise<Read<readonly TaskMember[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("home_directory", { p_home_id: homeId });
  if (error) return failed("tasks.members_failed", error);
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.membership_id,
      name: nullable(row.name),
      isSelf: row.is_self,
    })),
  };
}
