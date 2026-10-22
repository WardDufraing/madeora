import type { ParticipantStatus, VacationStatus } from "@madeora/domain/vacations";

import type { ChorePerson, ChoreStatus } from "@/chores/api";

/**
 * The HTTP contract of Home vacations and temporary chore absences (S22). Same rules as chores:
 * same-origin JSON, the person's own session, ids of new records from the client (a retry answers
 * `exists`), every consequential change previewable with `dryRun` and checked against the revision
 * the person saw (`409 conflict`). Answers and failures reuse the chore error codes.
 *
 * - `GET|POST /api/v1/vacations?homeId` (list; create, or its preview),
 *   `GET|PATCH /api/v1/vacations/:id` (rename, reminder, shorten, cancel, pause, unpause),
 *   `POST /api/v1/vacations/:id/participants` (add or invite), `GET /api/v1/vacations/:id/review`.
 * - `PATCH /api/v1/vacation-participants/:id` (accept, decline, withdraw, remove, cancel the
 *   invitation, change or propose dates), `PATCH /api/v1/vacation-date-proposals/:id`.
 * - `GET|POST /api/v1/chore-absences?homeId`, `PATCH /api/v1/chore-absences/:id` (edit or remove),
 *   `GET /api/v1/chore-absences/:id/review`.
 * - `POST /api/v1/chore-vacation-decisions` (keep, skip, reassign or reschedule one occurrence).
 * - `GET /api/v1/vacations/days?homeId&from&to` (the chores calendar's vacation days).
 */
export const VACATIONS_ENDPOINT = "/api/v1/vacations";
export const VACATION_PARTICIPANTS_ENDPOINT = "/api/v1/vacation-participants";
export const VACATION_PROPOSALS_ENDPOINT = "/api/v1/vacation-date-proposals";
export const CHORE_ABSENCES_ENDPOINT = "/api/v1/chore-absences";
export const VACATION_DECISIONS_ENDPOINT = "/api/v1/chore-vacation-decisions";

/** Inclusive Home-local dates. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface Stay {
  readonly member: ChorePerson | null;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface VacationSummary {
  readonly id: string;
  /** Null: the generic "Home vacation". */
  readonly name: string | null;
  readonly status: VacationStatus;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly revision: number;
  readonly createdBy: ChorePerson | null;
  /** Accepted participants with their own dates. */
  readonly participants: readonly Stay[];
  readonly memberCount: number;
  /** The viewer is an accepted participant. */
  readonly me: boolean;
  /** Dates on which this vacation pauses the Home's chores now. */
  readonly pauseDates: readonly DateRange[];
}

export interface VacationInvitation {
  readonly participantId: string;
  readonly vacationId: string;
  readonly name: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly revision: number;
  readonly invitedBy: ChorePerson | null;
}

export interface VacationProposalNotice {
  readonly proposalId: string;
  readonly vacationId: string;
  readonly name: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly currentStartsOn: string;
  readonly currentEndsOn: string;
  readonly proposedBy: ChorePerson | null;
}

export interface VacationList {
  readonly today: string;
  readonly canManage: boolean;
  readonly pausedToday: boolean;
  /** Active first, then upcoming. */
  readonly current: readonly VacationSummary[];
  /** Ended and cancelled, newest first. */
  readonly history: readonly VacationSummary[];
  readonly invitations: readonly VacationInvitation[];
  readonly proposals: readonly VacationProposalNotice[];
}

export type EndedReason = "self" | "manager" | "creator" | "shortened" | "cancelled" | "departure";

export interface VacationPerson {
  readonly id: string;
  readonly member: ChorePerson | null;
  readonly status: ParticipantStatus;
  readonly startsOn: string;
  readonly endsOn: string;
  /** Added by a chore manager (or the creator), not invited. */
  readonly direct: boolean;
  readonly invitedBy: ChorePerson | null;
  readonly endedReason: EndedReason | null;
  readonly revision: number;
  readonly proposal: {
    readonly id: string;
    readonly startsOn: string;
    readonly endsOn: string;
    readonly proposedBy: ChorePerson | null;
    readonly mine: boolean;
  } | null;
  readonly can: {
    readonly answer: boolean;
    readonly withdraw: boolean;
    readonly remove: boolean;
    readonly cancelInvitation: boolean;
    readonly changeDates: boolean;
    readonly proposeDates: boolean;
  };
}

export type VacationEventKind =
  | "created"
  | "renamed"
  | "invited"
  | "added"
  | "accepted"
  | "declined"
  | "withdrawn"
  | "removed"
  | "invitation_withdrawn"
  | "dates_changed"
  | "dates_proposed"
  | "proposal_accepted"
  | "proposal_declined"
  | "proposal_withdrawn"
  | "shortened"
  | "cancelled"
  | "home_pause_confirmed"
  | "home_pause_removed"
  | "reminder_changed"
  | "left_home";

export interface VacationEvent {
  readonly kind: VacationEventKind;
  readonly at: string;
  readonly by: ChorePerson | null;
  readonly subject: ChorePerson | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
}

export interface VacationDetail extends VacationSummary {
  readonly homeId: string;
  readonly today: string;
  readonly cancelledAt: string | null;
  readonly cancelledBy: ChorePerson | null;
  /** Chore managers and the creator only. */
  readonly reminderDays: number | null;
  readonly homePause: {
    /** Null: never confirmed. */
    readonly confirmed: readonly DateRange[] | null;
    readonly effective: readonly DateRange[];
    /** Dates everyone is away that a confirmation would add. */
    readonly available: readonly DateRange[];
    readonly by: ChorePerson | null;
    readonly at: string | null;
  };
  readonly people: readonly VacationPerson[];
  /** Chore managers and the creator only (null otherwise). */
  readonly history: readonly VacationEvent[] | null;
  readonly can: {
    readonly rename: boolean;
    readonly reminder: boolean;
    readonly shorten: boolean;
    readonly cancel: boolean;
    readonly pause: boolean;
    readonly invite: boolean;
    readonly addDirectly: boolean;
    readonly decide: boolean;
  };
}

export type ReviewReason = "away" | "no_substitute" | "paused_date" | "overdue_before";
export type DecisionKind = "keep" | "skip" | "reassign" | "reschedule";

export interface ReviewItem {
  readonly occurrenceId: string;
  readonly choreId: string;
  readonly title: string;
  readonly kind: "recurring" | "one_off";
  readonly scheduledDate: string;
  readonly dueDate: string;
  readonly status: ChoreStatus;
  readonly inRework: boolean;
  readonly claimed: boolean;
  readonly reason: ReviewReason;
  /** Pending approval or Needs rework: listed, never changed. */
  readonly protected: boolean;
  readonly revision: number;
  /** Membership ids (null: a former member). */
  readonly substituteFor: string | null;
  readonly assignees: readonly (string | null)[];
  readonly away: readonly (string | null)[];
  readonly decision: {
    readonly decision: DecisionKind;
    readonly at: string;
    readonly by: ChorePerson | null;
    readonly to: string | null;
    readonly newDate: string | null;
  } | null;
}

/** A recurring chore's date not created yet on which the member would be assigned. */
export interface PlannedDate {
  readonly choreId: string;
  readonly title: string;
  readonly date: string;
  readonly assignment: "fixed" | "rotating";
  readonly member: string | null;
}

export interface VacationReview {
  readonly today: string;
  readonly canDecide: boolean;
  readonly items: readonly ReviewItem[];
  readonly planned: readonly PlannedDate[];
}

export interface AbsenceSummary {
  readonly id: string;
  readonly member: ChorePerson | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly reason: string | null;
  readonly status: "upcoming" | "active" | "ended";
  readonly revision: number;
  /** Listed occurrences without a decision. */
  readonly undecided: number;
}

export interface AbsenceList {
  readonly today: string;
  readonly canManage: boolean;
  readonly absences: readonly AbsenceSummary[];
}

export interface AbsenceReview extends VacationReview {
  readonly id: string;
  readonly homeId: string;
  readonly member: ChorePerson | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly reason: string | null;
  readonly revision: number;
}

export type VacationChangeKind =
  | "paused"
  | "resumed"
  | "substituted"
  | "no_substitute"
  | "restored"
  | "needs_review"
  | "review_cleared";

/** What the rules changed (or would change) on one occurrence. */
export interface VacationChange {
  readonly occurrenceId: string;
  readonly choreId: string;
  readonly title: string;
  readonly date: string;
  readonly dueDate: string;
  readonly change: VacationChangeKind;
  readonly from: readonly (string | null)[];
  readonly to: readonly (string | null)[];
  readonly for: string | null;
}

/** A preview (`dryRun`) or the result of a vacation change. */
export interface VacationImpact {
  readonly changes: readonly VacationChange[];
  readonly review: readonly ReviewItem[];
  readonly startsOn: string;
  readonly endsOn: string;
  readonly pauseDates: readonly DateRange[];
  readonly fullDates: readonly DateRange[];
}

export interface VacationMutationResult {
  readonly outcome: string;
  readonly impact: VacationImpact | null;
  readonly revision: number | null;
}

/** The Home vacation widget. */
export interface VacationWidgetData {
  readonly today: string;
  readonly pausedToday: boolean;
  /** Other current or upcoming vacations. */
  readonly others: number;
  readonly vacation: {
    readonly id: string;
    readonly name: string | null;
    readonly status: VacationStatus;
    readonly startsOn: string;
    readonly endsOn: string;
    readonly scope: "everyone" | "me" | "members";
    readonly awayCount: number;
    readonly me: boolean;
    readonly pauseDates: readonly DateRange[];
  } | null;
}

/** Vacation days for the chores calendar: only days with someone away. */
export interface VacationDays {
  readonly days: readonly {
    readonly date: string;
    readonly paused: boolean;
    readonly away: number;
    readonly me: boolean;
  }[];
  readonly vacations: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly startsOn: string;
    readonly endsOn: string;
    readonly status: VacationStatus;
  }[];
}

/** An occurrence's vacation details on its page. */
export interface ChoreVacationState {
  readonly state: "substitute" | "review" | "paused" | null;
  readonly substituteFor: ChorePerson | null;
  readonly review: boolean;
  readonly pausedAt: string | null;
  readonly away: readonly (ChorePerson | null)[];
  readonly absent: readonly (ChorePerson | null)[];
  readonly decisions: readonly {
    readonly sourceKind: "vacation" | "absence";
    readonly sourceId: string;
    readonly decision: DecisionKind;
    readonly at: string;
    readonly by: ChorePerson | null;
  }[];
}
