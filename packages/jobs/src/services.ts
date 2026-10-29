/**
 * What the email jobs (S14) need from the outside world, behind small interfaces so every rule is
 * unit-tested with fakes. The production implementations are `createSupabaseJobData` (narrow
 * `service_role` functions through `supabase.rpc()`, never a table) and an `EmailTransport` from
 * `@madeora/email`.
 */
import type { EmailTransport } from "@madeora/email";
import type { ObjectStore } from "@madeora/storage";

export type EmailLanguage = "en" | "nl";

/** What an email job reads about one notification, re-checked by the database at send time. */
export type NotificationEmailRead =
  | {
      readonly outcome: "ok";
      readonly to: string;
      readonly locale: EmailLanguage;
      readonly kind: string;
      readonly homeId: string | null;
      readonly homeName: string | null;
      readonly homeTimeZone: string | null;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | {
      readonly outcome:
        "not_found" | "already_done" | "not_member" | "disabled" | "no_address" | "cannot_receive";
    };

export type InvitationEmailRead =
  | {
      readonly outcome: "ok";
      readonly to: string;
      readonly locale: EmailLanguage;
      readonly role: "member" | "administrator";
      /** The secret part of the link; only ever in memory, never logged. */
      readonly token: string;
      readonly expiresAt: Date;
      readonly homeName: string;
      readonly homeTimeZone: string;
    }
  | { readonly outcome: "not_found" | "superseded" | "not_active" };

export type EmailRecordStatus = "sent" | "failed" | "skipped" | "not_configured";

export interface JobDataPort {
  getNotificationEmail(notificationId: string): Promise<NotificationEmailRead>;
  /** False when the notification is no longer waiting for an email outcome. */
  recordNotificationEmail(
    notificationId: string,
    status: EmailRecordStatus,
    errorCode: string | null,
  ): Promise<boolean>;
  getInvitationEmail(invitationId: string, send: number): Promise<InvitationEmailRead>;
  /** False when a newer send has taken over the invitation's status. */
  recordInvitationEmail(
    invitationId: string,
    send: number,
    status: Exclude<EmailRecordStatus, "skipped">,
  ): Promise<boolean>;
  deliverRecoveryReady(
    recoveryId: string,
    objectionEndsAt: Date,
  ): Promise<"notified" | "not_ready">;
  /**
   * task-reminder (S19b): delivers a reminder at its time. 'stale': a newer revision, or it is no
   * longer scheduled; 'not_sent': the task was completed or deleted, or nobody is left to remind.
   */
  deliverTaskReminder(taskId: string, revision: number): Promise<TaskReminderOutcome>;
  /** task-reminder-advance (S19b): creates occurrences of series with a reminder; how many. */
  advanceReminderSeries(limit: number): Promise<number>;
  /** storage-upload-expire (S15): settles an upload after its intent ended; its status afterwards. */
  expireUpload(fileId: string): Promise<StoredFileStatus>;
  /** storage-file-purge (S15): purges a deleted file past its recovery window; its status afterwards. */
  purgeStoredFile(fileId: string): Promise<StoredFileStatus>;
  /** storage-object-delete (S15): the key to remove, or null when the row is gone. */
  getStorageObjectDeletion(
    deletionId: string,
  ): Promise<{ readonly objectKey: string; readonly done: boolean } | null>;
  /** False when it was already done. */
  completeStorageObjectDeletion(deletionId: string): Promise<boolean>;
  /** trash-entry-purge (S16): purges a trash entry past its recovery window; its status afterwards. */
  purgeExpiredTrashEntry(entryId: string): Promise<TrashEntryStatus>;
  /**
   * chore-claim-release (S21): releases a claim held past its automatic release time. 'stale': the
   * claim changed, ended or is not due; 'missing': the occurrence is gone.
   */
  releaseOverdueChoreClaim(occurrenceId: string, claim: number): Promise<ChoreClaimReleaseOutcome>;
  /**
   * chore-reminder (S21): delivers one person's reminder on an occurrence if its revision is still
   * current; the outcomes are the task reminder's.
   */
  deliverChoreReminder(
    occurrenceId: string,
    userId: string,
    revision: number,
  ): Promise<TaskReminderOutcome>;
  /**
   * vacation-reminder (S22): tells the chore managers about an upcoming vacation if it still starts
   * on that date with that lead time; the outcomes are the task reminder's.
   */
  deliverVacationReminder(
    vacationId: string,
    startsOn: string,
    days: number,
  ): Promise<TaskReminderOutcome>;
  /** chore-digest (S21): sends the daily summaries whose hour has come; how many were sent. */
  sendChoreSummaries(limit: number): Promise<number>;
  /** habit-reminder (S28): reminds of one habit's moment `at` (an ISO instant) if still current. */
  deliverHabitReminder(
    habitId: string,
    revision: number,
    at: string,
  ): Promise<HabitReminderOutcome>;
  /** task-reminder-advance (S28): queues missing next reminder moments; how many habits it checked. */
  advanceHabitReminders(limit: number): Promise<number>;
  /** habit-reminder-snooze (S28): delivers a snoozed reminder if it is still wanted. */
  deliverHabitSnooze(notificationId: string): Promise<HabitSnoozeOutcome>;
  /** habit-pause-end (S28): tells the members a Home habit resumed after a dated pause. */
  deliverHabitPauseEnd(pauseId: string, resumesOn: string): Promise<HabitPauseEndOutcome>;
  /** goal-reminder (S30): one deadline reminder moment of a goal, if still current. */
  deliverGoalReminder(
    goalId: string,
    revision: number,
    kind: GoalReminderKind,
    at: string,
  ): Promise<GoalReminderOutcome>;
}

export type HabitReminderOutcome =
  "notified" | "not_needed" | "late" | "inactive" | "stale" | "not_due";

export type HabitSnoozeOutcome = "notified" | "cancelled" | "stale" | "not_due";

export type HabitPauseEndOutcome = "notified" | "still_paused" | "stale" | "not_due";

export type GoalReminderKind = "lead" | "overdue";

export type GoalReminderOutcome = "notified" | "late" | "inactive" | "stale" | "not_due";

export type ChoreClaimReleaseOutcome = "released" | "stale" | "missing";

export type TaskReminderOutcome = "notified" | "not_sent" | "stale" | "not_due";

export type TrashEntryStatus = "trashed" | "restored" | "purged" | "missing";

export type StoredFileStatus = "pending" | "ready" | "failed" | "deleted" | "purged" | "missing";

export interface JobServices {
  readonly data: JobDataPort;
  /** Null when the environment sends no email (`EMAIL_TRANSPORT` off): in-app delivery goes on. */
  readonly mail: EmailTransport | null;
  /** The web app's address, for the links in emails; null when `mail` is. */
  readonly appUrl: string | null;
  /** The object store (S15), or null where storage is off (`STORAGE_DRIVER` unset or `off`). */
  readonly objects: ObjectStore | null;
}
