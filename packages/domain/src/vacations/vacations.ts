/**
 * Home vacations (S22). Pure and framework-free, with dates as `YYYY-MM-DD` in the Home's timezone
 * (string order is date order). The database derives the same statuses and decides every right again
 * (`private.vacation_status`, `private.vacation_participant_status`, `private.valid_vacation_stay` and
 * the `can` flags of `public.get_home_vacation` in supabase/migrations/*_home_vacations.sql); this
 * module only guides forms and labels.
 */
import { addDays, daysBetween } from "../tasks/recurrence";

/** The database's limits (`private.vacation_limit`). */
export const VACATION_LIMITS = {
  name: 80,
  /** Participants one change names. */
  people: 20,
  /** The longest stay of one participant, in inclusive days. */
  days: 366,
  /** How many days ahead a stay may start. */
  ahead: 730,
  reminderDays: 30,
  /** An absence's private reason. */
  reason: 200,
  /** Days one chores calendar read covers. */
  calendarDays: 42,
} as const;

export type VacationStatus = "upcoming" | "active" | "ended" | "cancelled";
export type ParticipantStatus = "pending" | "accepted" | "declined" | "withdrawn" | "expired";

/** Never picked: cancelled is final, the rest follows the envelope and the Home's today. */
export function vacationStatus(
  vacation: { readonly startsOn: string; readonly endsOn: string; readonly cancelled: boolean },
  today: string,
): VacationStatus {
  if (vacation.cancelled) return "cancelled";
  if (today < vacation.startsOn) return "upcoming";
  return today <= vacation.endsOn ? "active" : "ended";
}

/** A pending invitation expires at the start of its proposed start day. */
export function participantStatus(
  stored: ParticipantStatus,
  startsOn: string,
  today: string,
): ParticipantStatus {
  return stored === "pending" && today >= startsOn ? "expired" : stored;
}

/**
 * Whether a stay is acceptable as new dates: from `earliest` (today, or the start of a stay already
 * under way) to at most `ahead` days ahead, ending on or after its start and no earlier than
 * yesterday (ending early), at most `days` days long.
 */
export function validStay(
  startsOn: string,
  endsOn: string,
  today: string,
  earliest = today,
): boolean {
  const from = earliest < today ? earliest : today;
  return (
    startsOn >= from &&
    startsOn <= addDays(today, VACATION_LIMITS.ahead) &&
    endsOn >= startsOn &&
    endsOn >= addDays(today, -1) &&
    daysBetween(startsOn, endsOn) < VACATION_LIMITS.days
  );
}

/** Who is looking: a chore manager (`manageHomeChores`), the vacation's creator, or neither. */
export interface VacationViewer {
  readonly manager: boolean;
  readonly creator: boolean;
}

export type VacationAction =
  "rename" | "reminder" | "shorten" | "cancel" | "pause" | "invite" | "addDirectly" | "decide";

/**
 * What the viewer may do with a vacation in a status. A creator cancels only while nobody else is
 * an accepted participant (`othersAccepted`).
 */
export function canOnVacation(
  action: VacationAction,
  status: VacationStatus,
  viewer: VacationViewer,
  othersAccepted = false,
): boolean {
  const open = status === "upcoming" || status === "active";
  switch (action) {
    case "rename":
      return status !== "cancelled" && (viewer.manager || viewer.creator);
    case "reminder":
      return status === "upcoming" && viewer.manager;
    case "shorten":
    case "pause":
    case "addDirectly":
      return open && viewer.manager;
    case "cancel":
      return open && (viewer.manager || (viewer.creator && !othersAccepted));
    case "invite":
      return open && (viewer.manager || viewer.creator);
    case "decide":
      return status !== "cancelled" && viewer.manager;
  }
}

export type ParticipantAction =
  "answer" | "withdraw" | "remove" | "cancelInvitation" | "changeDates" | "proposeDates";

/**
 * What the viewer may do with one participation. `self`: it is the viewer's own; `direct`: a chore
 * manager added it (or the creator was a manager), so a manager changes its dates directly; anyone
 * else's changes to an invited participant's dates are proposals they accept or decline.
 */
export function canOnParticipant(
  action: ParticipantAction,
  vacation: VacationStatus,
  participant: {
    readonly status: ParticipantStatus;
    readonly self: boolean;
    readonly direct: boolean;
  },
  viewer: VacationViewer,
): boolean {
  if (vacation !== "upcoming" && vacation !== "active") return false;
  const { status, self, direct } = participant;
  switch (action) {
    case "answer":
      return self && status === "pending";
    case "withdraw":
      return self && status === "accepted";
    case "remove":
      return viewer.manager && (status === "pending" || status === "accepted");
    case "cancelInvitation":
      return (viewer.manager || viewer.creator) && status === "pending";
    case "changeDates":
      return status === "accepted" && (self || (viewer.manager && direct));
    case "proposeDates":
      return (
        status === "accepted" &&
        !self &&
        (viewer.manager || viewer.creator) &&
        !(viewer.manager && direct)
      );
  }
}
