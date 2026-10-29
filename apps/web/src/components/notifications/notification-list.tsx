import { notificationPath } from "@madeora/domain/notifications";
import { getLocale, getTranslations } from "next-intl/server";
import Link from "next/link";

import { FormAlert } from "@/components/auth/form-alert";
import { HabitReminderActions } from "@/components/habits/habit-reminder-actions";
import { formatDateTime, isolate, type DateTimeFormats } from "@/invitations/format";
import type { NotificationView } from "@/notifications/types";
import { isPresetUnit, unitMessageKey } from "@/habits/numeric-keys";
import { formatTaskDate } from "@/tasks/format";

import { MarkAllReadButton, MarkReadButton } from "./mark-read-buttons";

/**
 * The message for a notification: its kind names the event for one kind of reader, the words
 * come from the reader's language. A kind this build does not know still reads as a sentence.
 */
const kindMessage = {
  "recovery.owner_requested": "kindRecoveryOwnerRequested",
  "recovery.owner_review_started": "kindRecoveryOwnerReviewStarted",
  "recovery.owner_approved": "kindRecoveryOwnerApproved",
  "recovery.claimant_review_started": "kindRecoveryClaimantReviewStarted",
  "recovery.claimant_approved": "kindRecoveryClaimantApproved",
  "recovery.claimant_paused": "kindRecoveryClaimantPaused",
  "recovery.claimant_resumed": "kindRecoveryClaimantResumed",
  "recovery.claimant_rejected": "kindRecoveryClaimantRejected",
  "recovery.claimant_ended_owner_access": "kindRecoveryClaimantEndedOwnerAccess",
  "recovery.claimant_invalid": "kindRecoveryClaimantInvalid",
  "recovery.claimant_completed": "kindRecoveryClaimantCompleted",
  "recovery.claimant_ready": "kindRecoveryClaimantReady",
  "recovery.member_requested": "kindRecoveryMemberRequested",
  "recovery.member_objection_open": "kindRecoveryMemberObjectionOpen",
  "recovery.member_ended": "kindRecoveryMemberEnded",
  "recovery.member_completed": "kindRecoveryMemberCompleted",
  "recovery.former_owner_completed": "kindRecoveryFormerOwnerCompleted",
  "recovery.former_owner_completed_removed": "kindRecoveryFormerOwnerCompletedRemoved",
  "join_request.received": "kindJoinRequestReceived",
  "storage.personal_warning": "kindStoragePersonalWarning",
  "storage.personal_critical": "kindStoragePersonalCritical",
  "storage.home_warning": "kindStorageHomeWarning",
  "storage.home_critical": "kindStorageHomeCritical",
  "chore.approval_requested": "kindChoreApprovalRequested",
  "chore.claim_released": "kindChoreClaimReleased",
  "chore.reassignment_requested": "kindChoreReassignmentRequested",
  "chore.reassignment_answered": "kindChoreReassignmentAnswered",
  "chore.reassignment_confirmation_needed": "kindChoreReassignmentConfirmationNeeded",
  "chore.reassignment_decided": "kindChoreReassignmentDecided",
  "chore.reassignment_invalidated": "kindChoreReassignmentInvalidated",
  "chore.proposal_decided": "kindChoreProposalDecided",
  "chore.volunteer_invited": "kindChoreVolunteerInvited",
  "chore.volunteer_accepted": "kindChoreVolunteerAccepted",
  "chore.assignment_corrected": "kindChoreAssignmentCorrected",
  "chore.reminder": "kindChoreReminder",
  "chore.manager_summary": "kindChoreManagerSummary",
  "vacation.invited": "kindVacationInvited",
  "vacation.dates_proposed": "kindVacationDatesProposed",
  "vacation.reminder": "kindVacationReminder",
  "points.awarded": "kindPointsAwarded",
  "points.reversed": "kindPointsReversed",
  "points.bonus": "kindPointsBonus",
  "points.corrected": "kindPointsCorrected",
  "points.adjustment_reversed": "kindPointsAdjustmentReversed",
  "reward.requested": "kindRewardRequested",
  "reward.approved": "kindRewardApproved",
  "reward.rejected": "kindRewardRejected",
  "reward.cancelled": "kindRewardCancelled",
  "reward.fulfilled": "kindRewardFulfilled",
  "reward.unable": "kindRewardUnable",
  "reward.refunded": "kindRewardRefunded",
  "reward.replacement": "kindRewardReplacement",
} as const;

/** Chore notices whose words follow their outcome (S21). */
const choreOutcomeMessage = {
  "chore.claim_released": {
    auto: "kindChoreClaimReleasedAuto",
    manager: "kindChoreClaimReleasedManager",
  },
  "chore.reassignment_answered": {
    accepted: "kindChoreReassignmentAccepted",
    declined: "kindChoreReassignmentDeclined",
    awaiting_manager: "kindChoreReassignmentAwaitingManager",
  },
  "chore.reassignment_decided": {
    confirmed: "kindChoreReassignmentConfirmed",
    refused: "kindChoreReassignmentRefused",
  },
  "chore.proposal_decided": {
    approved: "kindChoreProposalApproved",
    rejected: "kindChoreProposalRejected",
  },
} as const;

type OutcomeKey<T> = T[keyof T];

type MessageKey =
  | (typeof kindMessage)[keyof typeof kindMessage]
  | OutcomeKey<(typeof choreOutcomeMessage)["chore.claim_released"]>
  | OutcomeKey<(typeof choreOutcomeMessage)["chore.reassignment_answered"]>
  | OutcomeKey<(typeof choreOutcomeMessage)["chore.reassignment_decided"]>
  | OutcomeKey<(typeof choreOutcomeMessage)["chore.proposal_decided"]>
  | "kindJoinRequestApproved"
  | "kindJoinRequestDeclined"
  | "kindTaskReminder"
  | "kindTaskReminderDue"
  | "kindHabitReminder"
  | "kindHabitReminderWeekly"
  | "kindHabitPaused"
  | "kindHabitPausedOpen"
  | "kindHabitResumed"
  | "kindHabitPauseEnded"
  | "kindHabitReminderProgress"
  | "kindGoalReminderLead"
  | "kindGoalReminderOverdue"
  | "kindUnknown";

/** The message key for a notification (exported for tests). */
export function messageKeyFor(
  item: Pick<NotificationView, "kind" | "decision"> &
    Partial<
      Pick<
        NotificationView,
        "dueDate" | "reason" | "weekly" | "resumesOn" | "automatic" | "progress" | "goalReminder"
      >
    >,
): MessageKey {
  const outcomes: Readonly<Record<string, MessageKey>> | undefined = (
    choreOutcomeMessage as Readonly<Record<string, Readonly<Record<string, MessageKey>>>>
  )[item.kind];
  const outcome = item.kind === "chore.claim_released" ? item.reason : item.decision;
  if (outcomes && outcome && outcomes[outcome]) return outcomes[outcome];
  if (item.kind === "task.reminder")
    return item.dueDate ? "kindTaskReminderDue" : "kindTaskReminder";
  // S28: a weekly reminder is about the week, a pause notice says until when.
  if (item.kind === "habit.reminder") {
    if (item.weekly) return "kindHabitReminderWeekly";
    return item.progress ? "kindHabitReminderProgress" : "kindHabitReminder";
  }
  if (item.kind === "habit.paused") {
    return item.resumesOn ? "kindHabitPaused" : "kindHabitPausedOpen";
  }
  if (item.kind === "habit.resumed") {
    return item.automatic ? "kindHabitPauseEnded" : "kindHabitResumed";
  }
  // S30: an advance reminder before the deadline, or an overdue one after it.
  if (item.kind === "goal.reminder") {
    return item.goalReminder === "overdue" ? "kindGoalReminderOverdue" : "kindGoalReminderLead";
  }
  if (item.kind === "join_request.decided") {
    return item.decision === "declined" ? "kindJoinRequestDeclined" : "kindJoinRequestApproved";
  }
  return (kindMessage as Readonly<Record<string, MessageKey>>)[item.kind] ?? "kindUnknown";
}

/**
 * The person's notifications, newest first, with where each came from (its source Home), when it
 * arrived, whether it is unread and whether it arrived during their quiet hours. Server-rendered
 * from rows the database already limited to this person and their current Homes.
 */
export async function NotificationList({
  items,
  formats,
}: {
  readonly items: readonly NotificationView[];
  readonly formats: DateTimeFormats;
}) {
  const [t, tn, locale] = await Promise.all([
    getTranslations("Notifications"),
    getTranslations("HabitsNumeric"),
    getLocale(),
  ]);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  /** "500 / 2,000 mL": the day's point-in-time progress when the reminder was sent. */
  const progressText = (progress: NonNullable<NotificationView["progress"]>) =>
    tn("progressText", {
      total: number.format(progress.total),
      target: number.format(progress.target),
      unit:
        progress.unitKind === "preset" && isPresetUnit(progress.unit)
          ? tn(unitMessageKey(progress.unit, progress.target, locale))
          : isolate(progress.unit),
    });
  if (items.length === 0) {
    return (
      <FormAlert tone="info">
        <p data-testid="notifications-empty">{t("empty")}</p>
      </FormAlert>
    );
  }
  const unread = items.some((item) => item.readAt === null);

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {unread ? <MarkAllReadButton /> : null}
      <ol className="flex flex-col gap-3">
        {items.map((item) => {
          const text = t(messageKeyFor(item), {
            home: item.homeName ? isolate(item.homeName) : t("homeFallback"),
            date: item.objectionEndsAt
              ? formatDateTime(item.objectionEndsAt, formats)
              : item.dueDate
                ? formatTaskDate(item.dueDate, formats)
                : item.kind === "habit.paused" && item.resumesOn
                  ? formatTaskDate(item.resumesOn, formats)
                  : item.kind === "goal.reminder" && item.deadline
                    ? formatTaskDate(item.deadline, formats)
                    : item.onDate
                      ? formatTaskDate(item.onDate, formats)
                      : "",
            task: item.taskTitle ? isolate(item.taskTitle) : t("taskFallback"),
            habit: item.habitName ? isolate(item.habitName) : t("habitFallback"),
            goal: item.goalName ? isolate(item.goalName) : t("goalFallback"),
            progress: item.progress ? progressText(item.progress) : "",
          });
          const href = notificationPath(
            item.kind,
            item.homeId,
            item.taskId
              ? { taskId: item.taskId }
              : item.habitId
                ? { habitId: item.habitId }
                : item.goalId
                  ? { goalId: item.goalId }
                  : item.occurrenceId
                    ? { occurrenceId: item.occurrenceId }
                    : {},
          );
          const isUnread = item.readAt === null;
          return (
            <li
              key={item.id}
              id={`notification-${item.id}`}
              tabIndex={-1}
              data-testid="notification"
              data-unread={isUnread ? "true" : "false"}
              className={
                isUnread
                  ? "flex flex-col gap-2 rounded-card border border-accent-edge bg-accent-subtle p-4"
                  : "flex flex-col gap-2 rounded-card border border-line bg-surface p-4"
              }
            >
              <p className="text-body text-fg">
                {isUnread ? (
                  <span className="me-2 font-semibold text-accent-fg">{t("unread")}.</span>
                ) : null}
                {text}
              </p>
              <p className={isUnread ? "text-helper text-fg" : "text-helper text-fg-muted"}>
                {item.homeName ? `${t("fromHome", { home: isolate(item.homeName) })} · ` : ""}
                <time dateTime={item.createdAt}>{formatDateTime(item.createdAt, formats)}</time>
                {item.duringQuietHours ? ` · ${t("quietMarker")}` : ""}
              </p>
              {item.kind === "habit.reminder" && item.habitId && item.habitName ? (
                <HabitReminderActions
                  notificationId={item.id}
                  habitId={item.habitId}
                  habitName={item.habitName}
                  onDate={item.weekly ? null : item.onDate}
                  numeric={item.progress !== null}
                  href={href}
                />
              ) : null}
              <div className="flex flex-wrap items-start gap-3">
                <Link href={href} className="text-body font-medium text-accent-fg underline">
                  {t("open")}
                </Link>
                {isUnread ? (
                  <MarkReadButton id={item.id} text={text} rowId={`notification-${item.id}`} />
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
