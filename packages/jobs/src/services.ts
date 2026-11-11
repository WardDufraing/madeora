/**
 * What the email jobs (S14) need from the outside world, behind small interfaces so every rule is
 * unit-tested with fakes. The production implementations are `createSupabaseJobData` (narrow
 * `service_role` functions through `supabase.rpc()`, never a table) and an `EmailTransport` from
 * `@madeora/email`.
 */
import type { EmailTransport } from "@madeora/email";
import type { GoogleCalendarClient, SyncStore } from "@madeora/google-calendar";
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

/** What the security-email job (S37) reads: an email to a backup or new address, or 'skipped'. */
export type SecurityEmailRead =
  | {
      readonly outcome: "ok";
      readonly kind: "backup_verify" | "recovery_link" | "recovery_started" | "recovery_ready";
      readonly to: string;
      readonly locale: EmailLanguage;
      /** The secret part of the link, or null for a notice without one; never logged. */
      readonly token: string | null;
      readonly expiresAt: Date | null;
    }
  | { readonly outcome: "skipped" };

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
  /** security-email (S37). */
  getSecurityEmail(emailId: string): Promise<SecurityEmailRead>;
  /** False when the email was already recorded. Erases the link's secret. */
  recordSecurityEmail(
    emailId: string,
    status: Exclude<EmailRecordStatus, "skipped">,
  ): Promise<boolean>;
  /** account-recovery-ready (S37): the end of a recovery's 72-hour wait. */
  deliverAccountRecoveryReady(recoveryId: string, readyAt: Date): Promise<"notified" | "not_ready">;
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
  /**
   * task-reminder-advance (S30b): finalizes ended periods of recurring goal series and creates the
   * period running now; how many periods it created.
   */
  rollGoalPeriods(limit: number): Promise<number>;
  /** pet-care-reminder (S31): one occurrence's reminder moment, if still current. */
  deliverPetCareReminder(occurrenceId: string, at: string): Promise<PetCareReminderOutcome>;
  /**
   * task-reminder-advance (S31): creates pet-care occurrences up to a week ahead (and queues their
   * reminders); how many it created.
   */
  advancePetCare(limit: number): Promise<number>;
  /**
   * google-calendar-sync (S33): the service-role sync functions, each rechecking the connection's
   * lease (`google_sync_*`).
   */
  readonly googleSync: SyncStore;
  /**
   * outbox-dispatch (S33): queues the automatic sync of connections whose last run is over 15 minutes
   * old; how many it queued.
   */
  queueGoogleCalendarSyncs(limit: number): Promise<number>;
  /**
   * outbox-dispatch (S38): classifies settled sign-ins for the activity history and sends the
   * routine sign-in alerts (re-authentication sign-ins are left out); how many it classified.
   */
  processSignInEvents(limit: number): Promise<number>;
  /** task-reminder-advance (S38): removes activity history past retention; how many entries. */
  purgeAccountActivity(): Promise<number>;
  /**
   * task-reminder-advance (S38): sends due long-term inactivity reminders (bounded by the
   * reminder limit and interval); how many it sent.
   */
  sendInactivityReminders(limit: number): Promise<number>;
  /**
   * privacy-export-build (S39): starts (or resumes) preparing a personal data export. 'skip' when it
   * is no longer queued or preparing; 'invalidated' when what it depended on changed.
   */
  beginDataExport(exportId: string): Promise<DataExportBegin>;
  /** One category's rows and attachments, re-checked by the database; 'gone' when no longer allowed. */
  collectDataExport(exportId: string, category: string): Promise<unknown>;
  /** Marks the stored archive ready (and notifies), or 'discarded' if the export ended meanwhile. */
  finishDataExport(
    exportId: string,
    sizeBytes: number,
    summary: Readonly<Record<string, unknown>>,
    partial: boolean,
  ): Promise<"ready" | "discarded">;
  /** Records a failed preparation with a short code; false when it had already ended. */
  failDataExport(exportId: string, code: string): Promise<boolean>;
  /** task-reminder-advance (S39): expiry, expiry warnings and stuck preparations; how many changed. */
  sweepDataExports(limit: number): Promise<number>;
  /**
   * task-reminder-advance (S40): deletes Homes and accounts whose 30-day recovery period ended;
   * how many of each, and how many failed (retried next hour).
   */
  purgeDueDeletions(limit: number): Promise<DeletionPurge>;
  /** home-copy-files (S40 part 2): the objects one running Home copy must copy; 'skip' when ended. */
  beginHomeCopyFiles(requestId: string): Promise<HomeCopyBegin>;
  /**
   * Records the job's result. With `ok` the database makes the Home item (after checking everything
   * again); otherwise the copy fails with `code`. 'discarded' when the request had already ended.
   */
  finishHomeCopyFiles(requestId: string, ok: boolean, code: string | null): Promise<HomeCopyFinish>;
  /** task-reminder-advance (S40 part 2): expired, stuck and orphaned copy requests; how many ended. */
  sweepHomeCopies(limit: number): Promise<number>;
  /** calendar-event-reminder (S32): one occurrence's reminder moment, if still current. */
  deliverCalendarReminder(
    eventId: string,
    on: string,
    at: string,
  ): Promise<CalendarReminderOutcome>;
}

export type HomeCopyBegin =
  | {
      readonly outcome: "ok";
      /** Keys chosen by the database, never logged; `size` is what each copy must measure. */
      readonly objects: readonly {
        readonly from: string;
        readonly to: string;
        readonly size: number | null;
      }[];
    }
  | { readonly outcome: "skip" };

export type HomeCopyFinish = "completed" | "failed" | "invalidated" | "discarded";

export interface DeletionPurge {
  readonly homes: number;
  readonly accounts: number;
  readonly failed: number;
}

export type DataExportBegin =
  | {
      readonly outcome: "ok";
      /** Where the archive goes; chosen by the database, never logged. */
      readonly objectKey: string;
      readonly categories: readonly string[];
      readonly allData: boolean;
      /** The selected Homes still in scope, for the manifest. */
      readonly homes: readonly { readonly id: string; readonly name: string }[];
      readonly kind: "personal" | "home";
    }
  | { readonly outcome: "skip" | "invalidated" };

export type HabitReminderOutcome =
  "notified" | "not_needed" | "late" | "inactive" | "stale" | "not_due";

export type HabitSnoozeOutcome = "notified" | "cancelled" | "stale" | "not_due";

export type HabitPauseEndOutcome = "notified" | "still_paused" | "stale" | "not_due";

export type GoalReminderKind = "lead" | "overdue";

export type GoalReminderOutcome = "notified" | "late" | "inactive" | "stale" | "not_due";

export type PetCareReminderOutcome = "notified" | "late" | "inactive" | "stale" | "not_due";

export type CalendarReminderOutcome = "notified" | "late" | "stale" | "not_due";

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
  /**
   * Google Calendar (S33): the OAuth and Calendar client and the refresh-token key, or null where the
   * integration is off (`GOOGLE_CALENDAR_*` unset).
   */
  readonly googleCalendar: {
    readonly client: GoogleCalendarClient;
    readonly tokenKey: Buffer;
  } | null;
}
