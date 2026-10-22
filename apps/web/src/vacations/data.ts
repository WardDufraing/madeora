import "server-only";

import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import type { Read } from "@/chores/data";
import { logChores } from "@/chores/log";
import { dateOnlySchema } from "@/tasks/schema";

import type {
  AbsenceList,
  AbsenceReview,
  ChoreVacationState,
  VacationDays,
  VacationDetail,
  VacationList,
  VacationReview,
  VacationWidgetData,
} from "./api";

/**
 * Server reads of Home vacations and absences (S22), with the signed-in person's own session: the
 * database answers only what they may see (a Home they are not in is not found, someone else's
 * absence is simply not there). Every answer is checked against its shape; nothing is cached across
 * requests.
 */

const person = z.object({ me: z.boolean(), member: z.uuid().nullable() }).nullable();
const memberRef = z.uuid().nullable();
const range = z.object({ from: dateOnlySchema, to: dateOnlySchema });
const vacationStatus = z.enum(["upcoming", "active", "ended", "cancelled"]);
const participantStatus = z.enum(["pending", "accepted", "declined", "withdrawn", "expired"]);
const decisionKind = z.enum(["keep", "skip", "reassign", "reschedule"]);
const occurrenceStatus = z.enum([
  "open",
  "pending_approval",
  "completed",
  "skipped",
  "expired",
  "paused",
]);

const summary = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  status: vacationStatus,
  startsOn: dateOnlySchema,
  endsOn: dateOnlySchema,
  revision: z.int(),
  createdBy: person,
  participants: z.array(
    z.object({ member: person, startsOn: dateOnlySchema, endsOn: dateOnlySchema }),
  ),
  memberCount: z.int(),
  me: z.boolean(),
  pauseDates: z.array(range),
});

const listSchema = z.object({
  today: dateOnlySchema,
  canManage: z.boolean(),
  pausedToday: z.boolean(),
  current: z.array(summary),
  history: z.array(summary),
  invitations: z.array(
    z.object({
      participantId: z.uuid(),
      vacationId: z.uuid(),
      name: z.string().nullable(),
      startsOn: dateOnlySchema,
      endsOn: dateOnlySchema,
      revision: z.int(),
      invitedBy: person,
    }),
  ),
  proposals: z.array(
    z.object({
      proposalId: z.uuid(),
      vacationId: z.uuid(),
      name: z.string().nullable(),
      startsOn: dateOnlySchema,
      endsOn: dateOnlySchema,
      currentStartsOn: dateOnlySchema,
      currentEndsOn: dateOnlySchema,
      proposedBy: person,
    }),
  ),
});

const detailSchema = summary.extend({
  homeId: z.uuid(),
  today: dateOnlySchema,
  cancelledAt: z.string().nullable(),
  cancelledBy: person,
  reminderDays: z.int().nullable(),
  homePause: z.object({
    confirmed: z.array(range).nullable(),
    effective: z.array(range),
    available: z.array(range),
    by: person,
    at: z.string().nullable(),
  }),
  people: z.array(
    z.object({
      id: z.uuid(),
      member: person,
      status: participantStatus,
      startsOn: dateOnlySchema,
      endsOn: dateOnlySchema,
      direct: z.boolean(),
      invitedBy: person,
      endedReason: z
        .enum(["self", "manager", "creator", "shortened", "cancelled", "departure"])
        .nullable(),
      revision: z.int(),
      proposal: z
        .object({
          id: z.uuid(),
          startsOn: dateOnlySchema,
          endsOn: dateOnlySchema,
          proposedBy: person,
          mine: z.boolean(),
        })
        .nullable(),
      can: z.object({
        answer: z.boolean(),
        withdraw: z.boolean(),
        remove: z.boolean(),
        cancelInvitation: z.boolean(),
        changeDates: z.boolean(),
        proposeDates: z.boolean(),
      }),
    }),
  ),
  history: z
    .array(
      z.object({
        kind: z.enum([
          "created",
          "renamed",
          "invited",
          "added",
          "accepted",
          "declined",
          "withdrawn",
          "removed",
          "invitation_withdrawn",
          "dates_changed",
          "dates_proposed",
          "proposal_accepted",
          "proposal_declined",
          "proposal_withdrawn",
          "shortened",
          "cancelled",
          "home_pause_confirmed",
          "home_pause_removed",
          "reminder_changed",
          "left_home",
        ]),
        at: z.string(),
        by: person,
        subject: person,
        startsOn: dateOnlySchema.nullable(),
        endsOn: dateOnlySchema.nullable(),
      }),
    )
    .nullable(),
  can: z.object({
    rename: z.boolean(),
    reminder: z.boolean(),
    shorten: z.boolean(),
    cancel: z.boolean(),
    pause: z.boolean(),
    invite: z.boolean(),
    addDirectly: z.boolean(),
    decide: z.boolean(),
  }),
});

export const reviewItemSchema = z.object({
  occurrenceId: z.uuid(),
  choreId: z.uuid(),
  title: z.string(),
  kind: z.enum(["recurring", "one_off"]),
  scheduledDate: dateOnlySchema,
  dueDate: dateOnlySchema,
  status: occurrenceStatus,
  inRework: z.boolean(),
  claimed: z.boolean(),
  reason: z.enum(["away", "no_substitute", "paused_date", "overdue_before"]),
  protected: z.boolean(),
  revision: z.int(),
  substituteFor: memberRef,
  assignees: z.array(memberRef),
  away: z.array(memberRef),
  decision: z
    .object({
      decision: decisionKind,
      at: z.string(),
      by: person,
      to: memberRef,
      newDate: dateOnlySchema.nullable(),
    })
    .nullable(),
});

const plannedSchema = z.object({
  choreId: z.uuid(),
  title: z.string(),
  date: dateOnlySchema,
  assignment: z.enum(["fixed", "rotating"]),
  member: memberRef,
});

const reviewSchema = z.object({
  today: dateOnlySchema,
  canDecide: z.boolean(),
  items: z.array(reviewItemSchema),
  planned: z.array(plannedSchema),
});

const absenceListSchema = z.object({
  today: dateOnlySchema,
  canManage: z.boolean(),
  absences: z.array(
    z.object({
      id: z.uuid(),
      member: person,
      startsOn: dateOnlySchema,
      endsOn: dateOnlySchema,
      reason: z.string().nullable(),
      status: z.enum(["upcoming", "active", "ended"]),
      revision: z.int(),
      undecided: z.int(),
    }),
  ),
});

const absenceReviewSchema = reviewSchema.extend({
  id: z.uuid(),
  homeId: z.uuid(),
  member: person,
  startsOn: dateOnlySchema,
  endsOn: dateOnlySchema,
  reason: z.string().nullable(),
  revision: z.int(),
});

const widgetSchema = z.object({
  today: dateOnlySchema,
  pausedToday: z.boolean(),
  others: z.int(),
  vacation: z
    .object({
      id: z.uuid(),
      name: z.string().nullable(),
      status: vacationStatus,
      startsOn: dateOnlySchema,
      endsOn: dateOnlySchema,
      scope: z.enum(["everyone", "me", "members"]),
      awayCount: z.int(),
      me: z.boolean(),
      pauseDates: z.array(range),
    })
    .nullable(),
});

const daysSchema = z.object({
  days: z.array(
    z.object({ date: dateOnlySchema, paused: z.boolean(), away: z.int(), me: z.boolean() }),
  ),
  vacations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().nullable(),
      startsOn: dateOnlySchema,
      endsOn: dateOnlySchema,
      status: vacationStatus,
    }),
  ),
});

const stateSchema = z.object({
  state: z.enum(["substitute", "review", "paused"]).nullable(),
  substituteFor: person,
  review: z.boolean(),
  pausedAt: z.string().nullable(),
  away: z.array(person),
  absent: z.array(person),
  decisions: z.array(
    z.object({
      sourceKind: z.enum(["vacation", "absence"]),
      sourceId: z.uuid(),
      decision: decisionKind,
      at: z.string(),
      by: person,
    }),
  ),
});

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501" || error.code === "22023") return { status: "not-found" };
  logChores(event, error.code);
  return { status: "unavailable" };
}

/** Parses an answer; null from the database (not the caller's to see) is not found. */
function parsed<T>(event: string, schema: z.ZodType<T>, data: unknown): Read<T> {
  if (data === null) return { status: "not-found" };
  const result = schema.safeParse(data);
  if (!result.success) {
    logChores(event, "unexpected_shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: result.data };
}

export async function listHomeVacations(homeId: string): Promise<Read<VacationList>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_home_vacations", { p_home_id: homeId });
  if (error) return failed("vacations.list_failed", error);
  return parsed("vacations.list_shape", listSchema, data);
}

/** An id from an address that is not one is answered like one that does not exist. */
const isId = (value: string) => z.uuid().safeParse(value).success;

export async function getHomeVacation(vacationId: string): Promise<Read<VacationDetail>> {
  if (!isId(vacationId)) return { status: "not-found" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_home_vacation", { p_vacation_id: vacationId });
  if (error) return failed("vacations.get_failed", error);
  return parsed("vacations.get_shape", detailSchema, data);
}

export async function listVacationReview(vacationId: string): Promise<Read<VacationReview>> {
  if (!isId(vacationId)) return { status: "not-found" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_vacation_review", {
    p_vacation_id: vacationId,
  });
  if (error) return failed("vacations.review_failed", error);
  return parsed("vacations.review_shape", reviewSchema, data);
}

export async function listChoreAbsences(homeId: string): Promise<Read<AbsenceList>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_chore_absences", { p_home_id: homeId });
  if (error) return failed("vacations.absences_failed", error);
  return parsed("vacations.absences_shape", absenceListSchema, data);
}

export async function listAbsenceReview(absenceId: string): Promise<Read<AbsenceReview>> {
  if (!isId(absenceId)) return { status: "not-found" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_absence_review", { p_id: absenceId });
  if (error) return failed("vacations.absence_review_failed", error);
  return parsed("vacations.absence_review_shape", absenceReviewSchema, data);
}

export async function getVacationWidget(homeId: string): Promise<Read<VacationWidgetData>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_home_vacation_widget", { p_home_id: homeId });
  if (error) return failed("vacations.widget_failed", error);
  return parsed("vacations.widget_shape", widgetSchema, data);
}

export async function listVacationDays(
  homeId: string,
  from: string,
  to: string,
): Promise<Read<VacationDays>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_home_vacation_days", {
    p_home_id: homeId,
    p_from: from,
    p_to: to,
  });
  if (error) return failed("vacations.days_failed", error);
  return parsed("vacations.days_shape", daysSchema, data);
}

export async function getChoreVacationState(
  occurrenceId: string,
): Promise<Read<ChoreVacationState>> {
  if (!isId(occurrenceId)) return { status: "not-found" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_chore_vacation_state", {
    p_occurrence_id: occurrenceId,
  });
  if (error) return failed("vacations.state_failed", error);
  return parsed("vacations.state_shape", stateSchema, data);
}
