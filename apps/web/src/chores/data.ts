import "server-only";

import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { dateOnlySchema, isLabelColor } from "@/tasks/schema";

import { recurrenceFrequencies } from "@madeora/domain/tasks";

import type {
  ChoreApproval,
  ChoreCategory,
  ChoreCategoryRef,
  ChoreHistoryPage,
  ChoreHistoryStatus,
  ChoreKind,
  ChoreOccurrenceDetail,
  ChoreOccurrencePage,
  ChorePerson,
  ChoreSummary,
  ChoreTemplate,
  HomeHistoryPage,
} from "./api";
import { logChores } from "./log";
import {
  assignmentModes,
  CHORE_LIMITS,
  type HistoryFilter,
  type HomeHistoryQuery,
  type OverviewQuery,
} from "./schema";

/**
 * Server reads of chores (S20), always with the signed-in person's own Supabase session: the
 * database answers only what they may see now, so a Home they left is simply not there. Nothing
 * here is cached across requests (personalized data, architecture.md §9).
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
  if (error.code === "42501" || error.code === "22023") return { status: "not-found" };
  logChores(event, error.code);
  return { status: "unavailable" };
}

const kindOf = (value: string): ChoreKind => (value === "recurring" ? "recurring" : "one_off");

function categoryRef(
  id: string | null,
  name: string | null,
  color: string | null,
): ChoreCategoryRef | null {
  if (id === null || name === null) return null;
  return { id, name, color: isLabelColor(color) ? color : null };
}

function person(me: boolean, member: string | null, present: boolean): ChorePerson | null {
  return present ? { me, member } : null;
}

/**
 * Creates the occurrences of the Home's recurring chores that are due by now: every date up to
 * today plus the next upcoming one. Generation is lazy, so chore pages call this before they read;
 * it is idempotent and safe to run from two page loads at once. A failure is logged and the page
 * still shows what exists.
 */
export async function advanceChores(homeId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("advance_chores", { p_home_id: homeId });
  if (error && error.code !== "42501") logChores("chores.advance_failed", error.code);
}

export interface ChoreContextInfo {
  readonly canManage: boolean;
  readonly canReview: boolean;
  /** Submissions waiting for a reviewer (0 for someone who is not one). */
  readonly pendingCount: number;
  readonly today: string;
}

export async function getChoreContext(homeId: string): Promise<Read<ChoreContextInfo>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_context", { p_home_id: homeId });
  if (error) return failed("chores.context_failed", error);
  const row = data[0];
  if (!row) return { status: "unavailable" };
  return {
    status: "ok",
    value: {
      canManage: row.can_manage,
      canReview: row.can_review,
      pendingCount: row.pending_count,
      today: row.today,
    },
  };
}

export async function listChoreCategories(
  homeId: string,
  includeArchived: boolean,
): Promise<Read<readonly ChoreCategory[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_categories", {
    p_home_id: homeId,
    p_include_archived: includeArchived,
  });
  if (error) return failed("chores.categories_failed", error);
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      name: row.name,
      color: isLabelColor(row.color) ? row.color : null,
      position: row.position,
      archived: row.archived,
      revision: row.revision,
      choreCount: row.chore_count,
    })),
  };
}

export async function listChoreOccurrences(
  homeId: string,
  query: OverviewQuery,
): Promise<Read<ChoreOccurrencePage>> {
  const supabase = await createSupabaseServerClient();
  const category = query.category === "any" || query.category === "none" ? query.category : "one";
  const { data, error } = await supabase.rpc("list_chore_occurrences", {
    p_home_id: homeId,
    p_assignee: query.assignee,
    ...(query.assignee === "member" && query.member ? { p_member: query.member } : {}),
    p_category: category,
    ...(category === "one" ? { p_category_id: query.category } : {}),
    p_limit: CHORE_LIMITS.page,
    p_offset: 0,
  });
  if (error) return failed("chores.occurrences_failed", error);
  return {
    status: "ok",
    value: {
      total: data[0]?.total_count ?? 0,
      occurrences: data.map((row) => ({
        id: row.id,
        choreId: row.chore_id,
        title: row.title,
        kind: kindOf(row.kind),
        category: categoryRef(
          nullable(row.category_id),
          nullable(row.category_name),
          nullable(row.category_color),
        ),
        scheduledDate: row.scheduled_date,
        dueDate: row.due_date,
        overdue: row.overdue,
        dueToday: row.due_today,
        needsReassignment: row.needs_reassignment,
        assigneeIds: row.assignee_member_ids,
        assignedToMe: row.assigned_to_me,
        stepsDone: row.steps_done,
        stepsTotal: row.steps_total,
        mandatoryOpen: row.mandatory_open,
        minutes: nullable(row.minutes),
        status: row.status === "pending_approval" ? "pending_approval" : "open",
        inRework: row.in_rework,
        requiresApproval: row.requires_approval,
        revision: row.revision,
      })),
    },
  };
}

const personSchema = z.object({ me: z.boolean(), member: z.uuid().nullable() }).nullable();
const memberRef = z.uuid().nullable();
const nextSchema = z.array(
  z.object({ date: dateOnlySchema, assignees: z.array(memberRef) }).transform((entry) => ({
    date: entry.date,
    assigneeIds: entry.assignees,
  })),
);
const categorySchema = z
  .object({ id: z.uuid(), name: z.string(), color: z.string().nullable(), archived: z.boolean() })
  .nullable()
  .transform((value) =>
    value === null ? null : { ...value, color: isLabelColor(value.color) ? value.color : null },
  );

/** The shape `public.get_chore_occurrence` answers; checked, so a change there fails loudly here. */
const detailSchema = z.object({
  id: z.uuid(),
  homeId: z.uuid(),
  chore: z.object({
    id: z.uuid(),
    kind: z.enum(["one_off", "recurring"]),
    title: z.string(),
    instructions: z.string().nullable(),
    category: categorySchema,
    requiresApproval: z.boolean(),
    revision: z.int(),
  }),
  scheduledDate: dateOnlySchema,
  dueDate: dateOnlySchema,
  today: dateOnlySchema,
  status: z.enum(["open", "pending_approval", "completed", "skipped"]),
  overdue: z.boolean(),
  inRework: z.boolean(),
  minutes: z.int().nullable(),
  detached: z.boolean(),
  needsReassignment: z.boolean(),
  revision: z.int(),
  assignees: z.array(memberRef),
  assignedToMe: z.boolean(),
  steps: z.array(
    z.object({ id: z.uuid(), label: z.string(), mandatory: z.boolean(), checked: z.boolean() }),
  ),
  completion: z
    .object({
      at: z.string(),
      by: personSchema,
      contributor: personSchema,
      note: z.string().nullable(),
      approvedAt: z.string().nullable(),
      approvedBy: personSchema,
    })
    .nullable(),
  skip: z.object({ at: z.string(), by: personSchema, reason: z.string().nullable() }).nullable(),
  closedTitle: z.string().nullable(),
  closedCategory: z.string().nullable(),
  submissions: z.array(
    z.object({
      id: z.uuid(),
      attempt: z.int(),
      status: z.enum(["pending", "approved", "rejected", "withdrawn"]),
      at: z.string(),
      by: personSchema,
      contributor: personSchema,
      note: z.string().nullable(),
      steps: z.array(z.object({ label: z.string(), mandatory: z.boolean(), checked: z.boolean() })),
      decidedAt: z.string().nullable(),
      decidedBy: personSchema,
      reason: z.string().nullable(),
      selfApproved: z.boolean(),
    }),
  ),
  events: z.array(
    z.object({
      kind: z.enum([
        "completed",
        "skipped",
        "reopened",
        "submitted",
        "approved",
        "rejected",
        "withdrawn",
        "corrected",
      ]),
      at: z.string(),
      by: personSchema,
      contributor: personSchema,
      note: z.string().nullable(),
      reason: z.string().nullable(),
      completedAt: z.string().nullable(),
      previousCompletedAt: z.string().nullable(),
      previousContributor: personSchema,
      previousNote: z.string().nullable(),
    }),
  ),
  schedule: z
    .object({
      revision: z.int(),
      frequency: z.enum(recurrenceFrequencies),
      interval: z.int(),
      weekdays: z
        .array(z.int().min(1).max(7))
        .nullable()
        .transform((days) => days as (1 | 2 | 3 | 4 | 5 | 6 | 7)[] | null),
      startsOn: dateOnlySchema,
      endsOn: dateOnlySchema.nullable(),
      count: z.int().nullable(),
      assignment: z.enum(assignmentModes),
      rotationFrom: dateOnlySchema.nullable(),
      members: z.array(memberRef),
      minutes: z.int().nullable(),
      steps: z.array(z.object({ label: z.string(), mandatory: z.boolean() })),
      paused: z.object({ from: dateOnlySchema, until: dateOnlySchema.nullable() }).nullable(),
      ended: z.boolean(),
      finished: z.boolean(),
      inHead: z.boolean(),
      needsReassignment: z.boolean(),
      next: nextSchema,
    })
    .nullable(),
  can: z.object({
    complete: z.boolean(),
    review: z.boolean(),
    correct: z.boolean(),
    manage: z.boolean(),
  }),
});

/** Parses the impact's next dates (series, pause), the same shape as the detail's. */
export const nextDatesSchema = nextSchema;

export async function getChoreOccurrence(
  occurrenceId: string,
): Promise<Read<ChoreOccurrenceDetail>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_occurrence", {
    p_occurrence_id: occurrenceId,
  });
  if (error) return failed("chores.occurrence_failed", error);
  if (data === null) return { status: "not-found" };
  const parsed = detailSchema.safeParse(data);
  if (!parsed.success) {
    logChores("chores.occurrence_shape", "unexpected_shape");
    return { status: "unavailable" };
  }
  const { assignees, ...detail } = parsed.data;
  return { status: "ok", value: { ...detail, assigneeIds: assignees } };
}

const historyStatuses: readonly ChoreHistoryStatus[] = [
  "completed",
  "skipped",
  "missed",
  "due_today",
  "open",
  "pending_approval",
  "rework",
];

/** The columns a history row shares between a chore's history and the Home's. */
interface HistoryColumns {
  readonly id: string;
  readonly scheduled_date: string;
  readonly due_date: string;
  readonly status: string;
  readonly title: string;
  readonly category: string;
  readonly completed_at: string;
  readonly completed_by_me: boolean;
  readonly completed_by_member: string;
  readonly contributor_me: boolean;
  readonly contributor_member: string;
  readonly note: string;
  readonly skipped_at: string;
  readonly skipped_by_me: boolean;
  readonly skipped_by_member: string;
  readonly skip_reason: string;
  readonly approved_at: string;
  readonly approved_by_me: boolean;
  readonly approved_by_member: string;
  readonly attempts: number;
}

function historyRow(row: HistoryColumns) {
  const completedAt = nullable(row.completed_at);
  const skippedAt = nullable(row.skipped_at);
  const approvedAt = nullable(row.approved_at);
  return {
    id: row.id,
    scheduledDate: row.scheduled_date,
    dueDate: row.due_date,
    status: historyStatuses.includes(row.status as ChoreHistoryStatus)
      ? (row.status as ChoreHistoryStatus)
      : "open",
    title: row.title,
    category: nullable(row.category),
    completedAt,
    completedBy: person(
      row.completed_by_me,
      nullable(row.completed_by_member),
      completedAt !== null,
    ),
    contributor: person(row.contributor_me, nullable(row.contributor_member), completedAt !== null),
    note: nullable(row.note),
    skippedAt,
    skippedBy: person(row.skipped_by_me, nullable(row.skipped_by_member), skippedAt !== null),
    skipReason: nullable(row.skip_reason),
    approvedAt,
    approvedBy: person(row.approved_by_me, nullable(row.approved_by_member), approvedAt !== null),
    attempts: row.attempts,
  };
}

export async function listChoreHistory(
  choreId: string,
  filter: HistoryFilter,
  offset: number,
): Promise<Read<ChoreHistoryPage>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_history", {
    p_chore_id: choreId,
    p_filter: filter,
    p_offset: offset,
    p_limit: CHORE_LIMITS.historyPage,
  });
  if (error) return failed("chores.history_failed", error);
  return {
    status: "ok",
    value: {
      filter,
      offset,
      total: data[0]?.total_count ?? 0,
      rows: data.map(historyRow),
    },
  };
}

export async function listChores(
  homeId: string,
  ended: boolean,
): Promise<Read<readonly ChoreSummary[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chores", { p_home_id: homeId, p_ended: ended });
  if (error) return failed("chores.list_failed", error);
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      title: row.title,
      kind: kindOf(row.kind),
      category: categoryRef(
        nullable(row.category_id),
        nullable(row.category_name),
        nullable(row.category_color),
      ),
      assignment: (assignmentModes as readonly string[]).includes(row.assignment)
        ? (row.assignment as ChoreSummary["assignment"])
        : "none",
      paused: row.paused,
      finished: row.finished,
      openCount: row.open_count,
      nextDue: nullable(row.next_due),
      occurrenceId: nullable(row.occurrence_id),
      revision: row.revision,
    })),
  };
}

/** The Home's review queue (reviewers only; anyone else gets an empty list). */
export async function listChoreApprovals(homeId: string): Promise<Read<readonly ChoreApproval[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_approvals", {
    p_home_id: homeId,
    p_limit: CHORE_LIMITS.approvalsPage,
  });
  if (error) return failed("chores.approvals_failed", error);
  return {
    status: "ok",
    value: data.map((row) => {
      const categoryName = nullable(row.category_name);
      const color = nullable(row.category_color);
      return {
        occurrenceId: row.occurrence_id,
        choreId: row.chore_id,
        title: row.title,
        category:
          categoryName === null
            ? null
            : { name: categoryName, color: isLabelColor(color) ? color : null },
        scheduledDate: row.scheduled_date,
        dueDate: row.due_date,
        late: row.late,
        assigneeIds: row.assignee_member_ids,
        submissionId: row.submission_id,
        attempt: row.attempt,
        submittedAt: row.submitted_at,
        submittedBy: person(row.submitted_by_me, nullable(row.submitted_by_member), true),
        contributor: person(row.contributor_me, nullable(row.contributor_member), true),
        contributorCurrent: row.contributor_current,
        note: nullable(row.note),
        stepsDone: row.steps_done,
        stepsTotal: row.steps_total,
        revision: row.revision,
      };
    }),
  };
}

/**
 * One page of the Home-wide history (every member of the Home; strictly this Home), with the
 * search and filters of `query`, newest first.
 */
export async function listHomeChoreHistory(
  homeId: string,
  query: HomeHistoryQuery,
  offset: number,
): Promise<Read<HomeHistoryPage>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_home_chore_history", {
    p_home_id: homeId,
    ...(query.q !== "" ? { p_search: query.q } : {}),
    ...(query.member ? { p_member: query.member } : {}),
    ...(query.chore ? { p_chore_id: query.chore } : {}),
    ...(query.from ? { p_from: query.from } : {}),
    ...(query.to ? { p_to: query.to } : {}),
    p_basis: query.basis,
    p_state: query.state,
    p_approval: query.approval,
    p_offset: offset,
    p_limit: CHORE_LIMITS.historyPage,
  });
  if (error) return failed("chores.home_history_failed", error);
  return {
    status: "ok",
    value: {
      query,
      offset,
      total: data[0]?.total_count ?? 0,
      rows: data.map((row) => {
        const color = nullable(row.category_color);
        return {
          ...historyRow(row),
          choreId: row.chore_id,
          categoryColor: isLabelColor(color) ? color : null,
          assigneeIds: row.assignee_member_ids,
          rejected: row.rejected,
        };
      }),
    },
  };
}

const templateStepsSchema = z.array(z.object({ label: z.string(), mandatory: z.boolean() }));

/** The Home's templates (chore managers; anyone else gets an empty list). */
export async function listChoreTemplates(
  homeId: string,
  includeRetired: boolean,
): Promise<Read<readonly ChoreTemplate[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_templates", {
    p_home_id: homeId,
    p_include_retired: includeRetired,
  });
  if (error) return failed("chores.templates_failed", error);
  const templates: ChoreTemplate[] = [];
  for (const row of data) {
    const steps = templateStepsSchema.safeParse(row.steps);
    if (!steps.success) {
      logChores("chores.template_shape", "unexpected_shape");
      return { status: "unavailable" };
    }
    const category = categoryRef(
      nullable(row.category_id),
      nullable(row.category_name),
      nullable(row.category_color),
    );
    templates.push({
      id: row.id,
      title: row.title,
      instructions: nullable(row.instructions),
      category: category ? { ...category, archived: row.category_archived } : null,
      minutes: nullable(row.minutes),
      steps: steps.data,
      retired: row.retired,
      revision: row.revision,
    });
  }
  return { status: "ok", value: templates };
}
