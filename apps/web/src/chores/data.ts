import "server-only";

import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { weekStarts } from "@/preferences/schema";
import { dateOnlySchema, isLabelColor } from "@/tasks/schema";

import { recurrenceFrequencies } from "@madeora/domain/tasks";

import type {
  ChoreApproval,
  ChoreClaimPolicy,
  ChoreClaimState,
  ChorePool,
  ChoreProposalList,
  ChoreAgenda,
  ChoreReminderView,
  ChoreVolunteerState,
  ManagerSummary,
  ManagerSummarySetting,
  VolunteerOffer,
  ChoreSettings,
  ReassignmentListItem,
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
  claimModes,
  expiryPolicies,
  reassignmentStatuses,
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
  status: z.enum(["open", "pending_approval", "completed", "skipped", "expired", "paused"]),
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
        "claimed",
        "released",
        "expired",
        "reassigned",
        "volunteered",
        "assignment_corrected",
        "vacation_paused",
        "vacation_resumed",
        "vacation_substituted",
        "vacation_restored",
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
  "expired",
  "paused",
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

/**
 * The Home's pool (S21): the unassigned occurrences of the Home-local week holding `date` (today
 * when null) and the overdue ones still available, with whether the viewer may claim each.
 */
export async function getChorePool(homeId: string, date: string | null): Promise<Read<ChorePool>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_pool", {
    p_home_id: homeId,
    ...(date !== null ? { p_date: date } : {}),
  });
  if (error) return failed("chores.pool_failed", error);
  const first = data[0];
  return {
    status: "ok",
    value: {
      weekStart: first?.week_start ?? null,
      today: first?.today ?? null,
      truncated: first?.truncated ?? false,
      rows: data.map((row) => ({
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
        section: row.section === "overdue" ? "overdue" : "week",
        overdue: row.overdue,
        minutes: nullable(row.minutes),
        stepsTotal: row.steps_total,
        requiresApproval: row.requires_approval,
        restricted: row.restricted,
        eligible: row.eligible,
        closesOn: nullable(row.closes_on),
        revision: row.revision,
      })),
    },
  };
}

/**
 * The Home's pool signal version (S21): it moves with every change to its chores, so a page that
 * subscribes to it can tell whether it missed one between rendering and subscribing. 0 before the
 * first change; null when it cannot be read.
 */
export async function getChorePoolVersion(homeId: string): Promise<number | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("chore_pool_signals")
    .select("version")
    .eq("home_id", homeId)
    .maybeSingle();
  if (error) {
    logChores("chores.pool_signal_failed", error.code);
    return null;
  }
  return data?.version ?? 0;
}

const requestSchema = z.object({
  id: z.uuid(),
  status: z.enum(reassignmentStatuses),
  from: personSchema,
  to: personSchema,
  by: personSchema,
  note: z.string().nullable(),
  createdAt: z.string(),
  respondedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decidedBy: personSchema,
  invalidReason: z.enum(["occurrence_closed", "assignment_changed", "member_left"]).nullable(),
  canAnswer: z.boolean(),
  canCancel: z.boolean(),
  canConfirm: z.boolean(),
});

/** The shape `public.get_chore_claim_state` answers. */
const claimStateSchema = z.object({
  claimMode: z.enum(claimModes),
  expiryPolicy: z.enum(expiryPolicies),
  autoReleaseHours: z.int().nullable(),
  claimable: z.boolean(),
  block: z
    .enum([
      "already_claimed",
      "assigned",
      "not_claimable",
      "not_eligible",
      "expired",
      "pending_approval",
      "already_completed",
      "already_skipped",
    ])
    .nullable(),
  claimedBy: personSchema,
  claimedAt: z.string().nullable(),
  canRelease: z.boolean(),
  releaseAt: z.string().nullable(),
  closesOn: dateOnlySchema.nullable(),
  expiredAt: z.string().nullable(),
  canRequest: z.boolean(),
  canRequestForOthers: z.boolean(),
  confirmationRequired: z.boolean(),
  requests: z.array(requestSchema),
});

export async function getChoreClaimState(occurrenceId: string): Promise<Read<ChoreClaimState>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_claim_state", {
    p_occurrence_id: occurrenceId,
  });
  if (error) return failed("chores.claim_state_failed", error);
  if (data === null) return { status: "not-found" };
  const parsed = claimStateSchema.safeParse(data);
  if (!parsed.success) {
    logChores("chores.claim_state_shape", "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const claimPolicySchema = z.object({
  claimMode: z.enum(claimModes),
  members: z.array(memberRef).nullable(),
  expiryPolicy: z.enum(expiryPolicies),
  autoReleaseHours: z.int().nullable(),
  revision: z.int(),
});

export async function getChoreClaimPolicy(choreId: string): Promise<Read<ChoreClaimPolicy>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_claim_policy", { p_chore_id: choreId });
  if (error) return failed("chores.claim_policy_failed", error);
  if (data === null) return { status: "not-found" };
  const parsed = claimPolicySchema.safeParse(data);
  if (!parsed.success) {
    logChores("chores.claim_policy_shape", "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

export async function getChoreSettings(homeId: string): Promise<Read<ChoreSettings>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_settings", { p_home_id: homeId });
  if (error) return failed("chores.settings_failed", error);
  const row = data[0];
  if (!row) return { status: "unavailable" };
  const weekStart = weekStarts.find((day) => day === row.week_start) ?? "monday";
  return {
    status: "ok",
    value: {
      weekStart,
      reassignmentConfirmation: row.reassignment_confirmation,
      revision: row.revision,
      canManage: row.can_manage,
    },
  };
}

export async function listReassignmentRequests(
  homeId: string,
): Promise<Read<readonly ReassignmentListItem[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_reassignment_requests", {
    p_home_id: homeId,
  });
  if (error) return failed("chores.requests_failed", error);
  return {
    status: "ok",
    value: data.map((row) => ({
      id: row.id,
      occurrenceId: row.occurrence_id,
      title: row.title,
      dueDate: row.due_date,
      status: row.status === "awaiting_manager" ? "awaiting_manager" : "pending",
      box: row.box === "incoming" ? "incoming" : row.box === "confirm" ? "confirm" : "outgoing",
      from: { me: row.from_me, member: nullable(row.from_member) },
      to: { me: row.to_me, member: nullable(row.to_member) },
      note: nullable(row.note),
      createdAt: row.created_at,
    })),
  };
}

const stepTemplatesSchema = z.array(z.object({ label: z.string(), mandatory: z.boolean() }));
const proposalCategorySchema = z
  .object({ id: z.uuid(), name: z.string(), color: z.string().nullable() })
  .nullable()
  .transform((value) =>
    value === null ? null : { ...value, color: isLabelColor(value.color) ? value.color : null },
  );

/** The shape `public.list_chore_proposals` answers. */
const proposalListSchema = z.object({
  canReview: z.boolean(),
  pendingCount: z.int().nullable(),
  proposals: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(["pending", "approved", "rejected", "withdrawn"]),
      title: z.string(),
      instructions: z.string().nullable(),
      category: proposalCategorySchema,
      minutes: z.int().nullable(),
      steps: stepTemplatesSchema,
      dueDate: dateOnlySchema,
      feedback: z.string().nullable(),
      revised: z.boolean(),
      by: personSchema,
      createdAt: z.string(),
      decidedAt: z.string().nullable(),
      decidedBy: personSchema,
      revision: z.int(),
      occurrenceId: z.uuid().nullable(),
      canWithdraw: z.boolean(),
      canReview: z.boolean(),
      possibleDuplicate: z.boolean(),
    }),
  ),
});

/** The proposals the person may see in a Home (S21): their own, or every one for chore managers. */
export async function listChoreProposals(homeId: string): Promise<Read<ChoreProposalList>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_proposals", { p_home_id: homeId });
  if (error) return failed("chores.proposals_failed", error);
  const parsed = proposalListSchema.safeParse(data);
  if (!parsed.success) {
    logChores("chores.proposals_shape", "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const volunteerStateSchema = z.object({
  inReview: z.boolean(),
  awaitingVolunteer: z.boolean(),
  deadline: z.string(),
  canRequest: z.boolean(),
  canCorrect: z.boolean(),
  volunteer: personSchema,
  requests: z.array(
    z.object({
      id: z.uuid(),
      status: z.enum(["open", "accepted", "cancelled", "resolved", "closed", "expired"]),
      createdAt: z.string(),
      closedAt: z.string().nullable(),
      by: personSchema,
      acceptedBy: personSchema,
      canChange: z.boolean(),
      invitations: z.array(
        z.object({
          member: personSchema,
          status: z.enum(["pending", "accepted", "declined", "withdrawn", "expired", "closed"]),
          invitedAt: z.string(),
          respondedAt: z.string().nullable(),
          canAnswer: z.boolean(),
        }),
      ),
    }),
  ),
});

/** The volunteer side of an occurrence for the person (S21). */
export async function getChoreVolunteerState(
  occurrenceId: string,
): Promise<Read<ChoreVolunteerState>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_volunteer_state", {
    p_occurrence_id: occurrenceId,
  });
  if (error) return failed("chores.volunteer_state_failed", error);
  if (data === null) return { status: "not-found" };
  const parsed = volunteerStateSchema.safeParse(data);
  if (!parsed.success) {
    logChores("chores.volunteer_state_shape", "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

/** The person's open volunteer invitations in a Home (S21). */
export async function listVolunteerOffers(
  homeId: string,
): Promise<Read<readonly VolunteerOffer[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_volunteer_offers", { p_home_id: homeId });
  if (error) return failed("chores.volunteer_offers_failed", error);
  const offers: VolunteerOffer[] = [];
  for (const row of data) {
    const steps = stepTemplatesSchema.safeParse(row.steps);
    if (!steps.success) {
      logChores("chores.volunteer_offers_shape", "unexpected_shape");
      return { status: "unavailable" };
    }
    offers.push({
      requestId: row.request_id,
      occurrenceId: row.occurrence_id,
      title: row.title,
      dueDate: row.due_date,
      deadline: row.deadline,
      instructions: nullable(row.instructions),
      minutes: nullable(row.minutes),
      steps: steps.data,
      invitedAt: row.invited_at,
    });
  }
  return { status: "ok", value: offers };
}

const reminderViewSchema = z.object({
  occurrenceId: z.uuid(),
  dueDate: dateOnlySchema,
  timeZone: z.string(),
  canSet: z.boolean(),
  reminder: z
    .object({
      mode: z.enum(["absolute", "relative"]),
      localAt: z.string().nullable(),
      daysBefore: z.int().nullable(),
      time: z.string().nullable(),
      fireAt: z.string(),
      dst: z.enum(["gap", "overlap"]).nullable(),
      status: z.enum(["scheduled", "sent"]),
    })
    .nullable(),
  revision: z.int(),
  channels: z.object({ inApp: z.boolean(), email: z.boolean() }),
});

/** The person's own reminder on an occurrence (S21); not-found when they cannot see it. */
export async function getChoreReminder(occurrenceId: string): Promise<Read<ChoreReminderView>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_reminder", {
    p_occurrence_id: occurrenceId,
  });
  if (error) return failed("chores.reminder_failed", error);
  if (data === null) return { status: "not-found" };
  const parsed = reminderViewSchema.safeParse(data);
  if (!parsed.success) {
    logChores("chores.reminder_shape", "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const categoryShape = z
  .object({ id: z.uuid(), name: z.string(), color: z.string().nullable() })
  .nullable()
  .transform((category) =>
    category
      ? {
          id: category.id,
          name: category.name,
          color: category.color !== null && isLabelColor(category.color) ? category.color : null,
        }
      : null,
  );

const scheduleSchema = z.object({
  today: dateOnlySchema,
  canManage: z.boolean(),
  truncated: z.boolean(),
  items: z.array(
    z.object({
      id: z.uuid().nullable(),
      choreId: z.uuid(),
      title: z.string(),
      date: dateOnlySchema,
      category: categoryShape,
      status: z.enum(["open", "pending_approval", "completed", "skipped", "expired", "paused"]),
      overdue: z.boolean(),
      inRework: z.boolean(),
      needsReassignment: z.boolean(),
      awaitingVolunteer: z.boolean(),
      assigneeIds: z.array(z.uuid().nullable()),
      minutes: z.int().nullable(),
      revision: z.int().nullable(),
      recurring: z.boolean(),
      projected: z.boolean(),
    }),
  ),
});

/**
 * A Home's chores between two dates (S21): occurrences with their state and the dates of recurring
 * chores still to be created, for the schedule widget and the Chores calendar.
 */
export async function listChoreSchedule(
  homeId: string,
  from: string,
  to: string,
): Promise<Read<ChoreAgenda>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_schedule", {
    p_home_id: homeId,
    p_from: from,
    p_to: to,
  });
  if (error) return failed("chores.schedule_failed", error);
  const parsed = scheduleSchema.safeParse(data);
  if (!parsed.success) {
    logChores("chores.schedule_shape", "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const summaryGroups = [
  "overdueAssigned",
  "overdueUnassigned",
  "pendingReview",
  "rework",
  "inReview",
  "releaseSoon",
] as const;

const managerSummarySchema = z.discriminatedUnion("canManage", [
  z.object({ canManage: z.literal(false) }),
  z.object({
    canManage: z.literal(true),
    today: dateOnlySchema,
    counts: z.object(
      Object.fromEntries(summaryGroups.map((group) => [group, z.int()])) as Record<
        (typeof summaryGroups)[number],
        z.ZodInt
      >,
    ),
    items: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        dueDate: dateOnlySchema,
        group: z.enum(summaryGroups),
        assigneeIds: z.array(z.uuid().nullable()),
        releaseAt: z.string().nullable(),
      }),
    ),
  }),
]);

/** The live daily summary for a chore manager (S21); null for anyone else. */
export async function getManagerSummary(homeId: string): Promise<Read<ManagerSummary | null>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_summary", { p_home_id: homeId });
  if (error) return failed("chores.summary_failed", error);
  const parsed = managerSummarySchema.safeParse(data);
  if (!parsed.success) {
    logChores("chores.summary_shape", "unexpected_shape");
    return { status: "unavailable" };
  }
  if (!parsed.data.canManage) return { status: "ok", value: null };
  const { today, counts, items } = parsed.data;
  return { status: "ok", value: { today, counts, items } };
}

const summarySettingShape = z.object({
  canManage: z.boolean(),
  enabled: z.boolean(),
  hour: z.int().min(0).max(23),
  timeZone: z.string().nullable(),
  revision: z.int(),
});

/** The person's daily summary setting for a Home (S21). */
export async function getManagerSummarySetting(
  homeId: string,
): Promise<Read<ManagerSummarySetting>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_summary_setting", { p_home_id: homeId });
  if (error) return failed("chores.summary_setting_failed", error);
  const parsed = summarySettingShape.safeParse(data);
  if (!parsed.success) {
    logChores("chores.summary_setting_shape", "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}
