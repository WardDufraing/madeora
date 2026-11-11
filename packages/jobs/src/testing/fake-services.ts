/**
 * In-memory stand-ins for the email jobs' services (S14). Test-only; the real database functions
 * are covered by tests/db/rls/notifications.test.sql.
 */
import type { EmailTransport, OutgoingEmail, SendResult } from "@madeora/email";
import type { BeginResult, SyncStore } from "@madeora/google-calendar";
import {
  StorageUnavailableError,
  type ObjectFacts,
  type ObjectRead,
  type ObjectStore,
  type PresignedUpload,
} from "@madeora/storage";

import type {
  ChoreClaimReleaseOutcome,
  GoalReminderKind,
  GoalReminderOutcome,
  HabitPauseEndOutcome,
  HabitReminderOutcome,
  HabitSnoozeOutcome,
  EmailRecordStatus,
  InvitationEmailRead,
  JobDataPort,
  JobServices,
  NotificationEmailRead,
  SecurityEmailRead,
  CalendarReminderOutcome,
  DataExportBegin,
  DeletionPurge,
  HomeCopyBegin,
  HomeCopyFinish,
  PetCareReminderOutcome,
  StoredFileStatus,
  TaskReminderOutcome,
  TrashEntryStatus,
} from "../services.ts";

export class FakeJobData implements JobDataPort {
  notification: NotificationEmailRead = { outcome: "not_found" };
  invitation: InvitationEmailRead = { outcome: "not_found" };
  readyOutcome: "notified" | "not_ready" = "not_ready";
  /** When set, every call throws, as when Postgres cannot be reached. */
  unavailable = false;
  readonly notificationRecords: { id: string; status: EmailRecordStatus; code: string | null }[] =
    [];
  readonly invitationRecords: { id: string; send: number; status: EmailRecordStatus }[] = [];
  readonly readyCalls: { recoveryId: string; endsAt: Date }[] = [];
  /** Security emails (S37). */
  securityEmail: SecurityEmailRead = { outcome: "skipped" };
  readonly securityRecords: { id: string; status: EmailRecordStatus }[] = [];
  accountRecoveryOutcome: "notified" | "not_ready" = "not_ready";
  readonly accountRecoveryCalls: { recoveryId: string; readyAt: Date }[] = [];
  /** Reminders (S19b): what delivery answers, the calls, and how many occurrences an advance makes. */
  reminderOutcome: TaskReminderOutcome = "notified";
  readonly reminderCalls: { taskId: string; revision: number }[] = [];
  advanced = 0;
  readonly advanceCalls: number[] = [];
  /** Storage (S15): file statuses the database functions return, and the deletion queue. */
  expireStatus: StoredFileStatus = "failed";
  purgeStatus: StoredFileStatus = "purged";
  trashStatus: TrashEntryStatus = "purged";
  readonly trashCalls: string[] = [];
  /** Chores (S21): what an automatic claim release answers, and the calls. */
  claimReleaseOutcome: ChoreClaimReleaseOutcome = "released";
  readonly claimReleaseCalls: { occurrenceId: string; claim: number }[] = [];
  choreReminderOutcome: TaskReminderOutcome = "notified";
  readonly choreReminderCalls: { occurrenceId: string; userId: string; revision: number }[] = [];
  vacationReminderOutcome: TaskReminderOutcome = "notified";
  readonly vacationReminderCalls: { vacationId: string; startsOn: string; days: number }[] = [];
  summariesSent = 0;
  /** Habits (S28): what each delivery answers, the calls, and how many habits an advance checks. */
  habitReminderOutcome: HabitReminderOutcome = "notified";
  readonly habitReminderCalls: { habitId: string; revision: number; at: string }[] = [];
  habitsAdvanced = 0;
  readonly habitAdvanceCalls: number[] = [];
  goalPeriodsCreated = 0;
  readonly goalRollCalls: number[] = [];
  habitSnoozeOutcome: HabitSnoozeOutcome = "notified";
  readonly habitSnoozeCalls: string[] = [];
  habitPauseEndOutcome: HabitPauseEndOutcome = "notified";
  readonly habitPauseEndCalls: { pauseId: string; resumesOn: string }[] = [];
  /** Goals (S30): what a reminder delivery answers, and the calls. */
  goalReminderOutcome: GoalReminderOutcome = "notified";
  readonly goalReminderCalls: {
    goalId: string;
    revision: number;
    kind: GoalReminderKind;
    at: string;
  }[] = [];
  /** Pets (S31): what a care reminder delivery answers, the calls, and the hourly advance. */
  petCareReminderOutcome: PetCareReminderOutcome = "notified";
  readonly petCareReminderCalls: { occurrenceId: string; at: string }[] = [];
  calendarReminderOutcome: CalendarReminderOutcome = "notified";
  readonly calendarReminderCalls: { eventId: string; on: string; at: string }[] = [];
  petCareCreated = 0;
  readonly petCareAdvanceCalls: number[] = [];
  readonly summaryCalls: number[] = [];
  readonly fileCalls: { operation: "expire" | "purge"; fileId: string }[] = [];
  readonly deletions = new Map<string, { objectKey: string; done: boolean }>();

  /** Google Calendar (S33): what a run's start answers, the calls, and the automatic queue. */
  googleBegin: BeginResult = { outcome: "missing" };
  readonly googleCalls: string[] = [];
  googleQueued = 0;
  /** S38: sign-in classification and activity purge calls. */
  readonly signInCalls: number[] = [];
  signInsClassified = 0;
  activityPurges = 0;
  readonly inactivityCalls: number[] = [];
  readonly googleSync: SyncStore = {
    begin: (connectionId) => {
      this.check();
      this.googleCalls.push(`begin:${connectionId}`);
      return Promise.resolve(this.googleBegin);
    },
    applyCalendars: () => Promise.resolve([]),
    applyEvents: () => Promise.resolve(0),
    finishCalendar: () => Promise.resolve(true),
    pushChanges: () => Promise.resolve([]),
    pushResult: () => Promise.resolve({ state: "done" }),
    finish: (_connectionId, _lease, outcome) => {
      this.googleCalls.push(`finish:${outcome}`);
      return Promise.resolve(true);
    },
  };

  queueGoogleCalendarSyncs(): Promise<number> {
    this.check();
    return Promise.resolve(this.googleQueued);
  }

  processSignInEvents(limit: number): Promise<number> {
    this.check();
    this.signInCalls.push(limit);
    return Promise.resolve(this.signInsClassified);
  }

  purgeAccountActivity(): Promise<number> {
    this.check();
    this.activityPurges += 1;
    return Promise.resolve(0);
  }

  sendInactivityReminders(limit: number): Promise<number> {
    this.check();
    this.inactivityCalls.push(limit);
    return Promise.resolve(0);
  }

  /** S39: data exports. `exportCategories` is what collect returns per category (or 'gone'). */
  exportBegin: DataExportBegin = { outcome: "skip" };
  exportCategories: Record<string, unknown> = {};
  exportFinishOutcome: "ready" | "discarded" = "ready";
  readonly exportCalls: string[] = [];
  readonly exportFinishes: {
    exportId: string;
    sizeBytes: number;
    summary: Readonly<Record<string, unknown>>;
    partial: boolean;
  }[] = [];
  readonly exportFailures: { exportId: string; code: string }[] = [];
  readonly exportSweeps: number[] = [];
  readonly deletionPurges: number[] = [];

  beginDataExport(exportId: string): Promise<DataExportBegin> {
    this.check();
    this.exportCalls.push(`begin:${exportId}`);
    return Promise.resolve(this.exportBegin);
  }

  collectDataExport(exportId: string, category: string): Promise<unknown> {
    this.check();
    this.exportCalls.push(`collect:${category}`);
    return Promise.resolve(this.exportCategories[category] ?? { files: {}, media: [] });
  }

  finishDataExport(
    exportId: string,
    sizeBytes: number,
    summary: Readonly<Record<string, unknown>>,
    partial: boolean,
  ): Promise<"ready" | "discarded"> {
    this.check();
    this.exportFinishes.push({ exportId, sizeBytes, summary, partial });
    return Promise.resolve(this.exportFinishOutcome);
  }

  failDataExport(exportId: string, code: string): Promise<boolean> {
    this.check();
    this.exportFailures.push({ exportId, code });
    return Promise.resolve(true);
  }

  sweepDataExports(limit: number): Promise<number> {
    this.check();
    this.exportSweeps.push(limit);
    return Promise.resolve(0);
  }

  purgeDueDeletions(limit: number): Promise<DeletionPurge> {
    this.check();
    this.deletionPurges.push(limit);
    return Promise.resolve({ homes: 0, accounts: 0, failed: 0 });
  }

  homeCopyBegin: HomeCopyBegin = { outcome: "skip" };
  readonly homeCopyFinishes: { requestId: string; ok: boolean; code: string | null }[] = [];
  homeCopyFinishOutcome: HomeCopyFinish = "completed";
  readonly homeCopySweeps: number[] = [];

  beginHomeCopyFiles(): Promise<HomeCopyBegin> {
    this.check();
    return Promise.resolve(this.homeCopyBegin);
  }

  finishHomeCopyFiles(
    requestId: string,
    ok: boolean,
    code: string | null,
  ): Promise<HomeCopyFinish> {
    this.check();
    this.homeCopyFinishes.push({ requestId, ok, code });
    return Promise.resolve(this.homeCopyFinishOutcome);
  }

  sweepHomeCopies(limit: number): Promise<number> {
    this.check();
    this.homeCopySweeps.push(limit);
    return Promise.resolve(0);
  }

  private check(): void {
    if (this.unavailable) throw new Error("database unavailable");
  }

  getNotificationEmail(): Promise<NotificationEmailRead> {
    this.check();
    return Promise.resolve(this.notification);
  }

  recordNotificationEmail(
    id: string,
    status: EmailRecordStatus,
    code: string | null,
  ): Promise<boolean> {
    this.check();
    this.notificationRecords.push({ id, status, code });
    return Promise.resolve(true);
  }

  getInvitationEmail(): Promise<InvitationEmailRead> {
    this.check();
    return Promise.resolve(this.invitation);
  }

  recordInvitationEmail(id: string, send: number, status: EmailRecordStatus): Promise<boolean> {
    this.check();
    this.invitationRecords.push({ id, send, status });
    return Promise.resolve(true);
  }

  getSecurityEmail(): Promise<SecurityEmailRead> {
    this.check();
    return Promise.resolve(this.securityEmail);
  }

  recordSecurityEmail(id: string, status: EmailRecordStatus): Promise<boolean> {
    this.check();
    this.securityRecords.push({ id, status });
    return Promise.resolve(true);
  }

  deliverAccountRecoveryReady(
    recoveryId: string,
    readyAt: Date,
  ): Promise<"notified" | "not_ready"> {
    this.check();
    this.accountRecoveryCalls.push({ recoveryId, readyAt });
    return Promise.resolve(this.accountRecoveryOutcome);
  }

  deliverRecoveryReady(recoveryId: string, endsAt: Date): Promise<"notified" | "not_ready"> {
    this.check();
    this.readyCalls.push({ recoveryId, endsAt });
    return Promise.resolve(this.readyOutcome);
  }

  deliverTaskReminder(taskId: string, revision: number): Promise<TaskReminderOutcome> {
    this.check();
    this.reminderCalls.push({ taskId, revision });
    return Promise.resolve(this.reminderOutcome);
  }

  advanceReminderSeries(limit: number): Promise<number> {
    this.check();
    this.advanceCalls.push(limit);
    return Promise.resolve(this.advanced);
  }

  expireUpload(fileId: string): Promise<StoredFileStatus> {
    this.check();
    this.fileCalls.push({ operation: "expire", fileId });
    return Promise.resolve(this.expireStatus);
  }

  purgeStoredFile(fileId: string): Promise<StoredFileStatus> {
    this.check();
    this.fileCalls.push({ operation: "purge", fileId });
    return Promise.resolve(this.purgeStatus);
  }

  purgeExpiredTrashEntry(entryId: string): Promise<TrashEntryStatus> {
    this.check();
    this.trashCalls.push(entryId);
    return Promise.resolve(this.trashStatus);
  }

  releaseOverdueChoreClaim(occurrenceId: string, claim: number): Promise<ChoreClaimReleaseOutcome> {
    this.check();
    this.claimReleaseCalls.push({ occurrenceId, claim });
    return Promise.resolve(this.claimReleaseOutcome);
  }

  deliverChoreReminder(
    occurrenceId: string,
    userId: string,
    revision: number,
  ): Promise<TaskReminderOutcome> {
    this.check();
    this.choreReminderCalls.push({ occurrenceId, userId, revision });
    return Promise.resolve(this.choreReminderOutcome);
  }

  deliverVacationReminder(
    vacationId: string,
    startsOn: string,
    days: number,
  ): Promise<TaskReminderOutcome> {
    this.check();
    this.vacationReminderCalls.push({ vacationId, startsOn, days });
    return Promise.resolve(this.vacationReminderOutcome);
  }

  sendChoreSummaries(limit: number): Promise<number> {
    this.check();
    this.summaryCalls.push(limit);
    return Promise.resolve(this.summariesSent);
  }

  deliverHabitReminder(
    habitId: string,
    revision: number,
    at: string,
  ): Promise<HabitReminderOutcome> {
    this.check();
    this.habitReminderCalls.push({ habitId, revision, at });
    return Promise.resolve(this.habitReminderOutcome);
  }

  advanceHabitReminders(limit: number): Promise<number> {
    this.check();
    this.habitAdvanceCalls.push(limit);
    return Promise.resolve(this.habitsAdvanced);
  }

  deliverHabitSnooze(notificationId: string): Promise<HabitSnoozeOutcome> {
    this.check();
    this.habitSnoozeCalls.push(notificationId);
    return Promise.resolve(this.habitSnoozeOutcome);
  }

  deliverHabitPauseEnd(pauseId: string, resumesOn: string): Promise<HabitPauseEndOutcome> {
    this.check();
    this.habitPauseEndCalls.push({ pauseId, resumesOn });
    return Promise.resolve(this.habitPauseEndOutcome);
  }

  deliverGoalReminder(
    goalId: string,
    revision: number,
    kind: GoalReminderKind,
    at: string,
  ): Promise<GoalReminderOutcome> {
    this.check();
    this.goalReminderCalls.push({ goalId, revision, kind, at });
    return Promise.resolve(this.goalReminderOutcome);
  }

  rollGoalPeriods(limit: number): Promise<number> {
    this.check();
    this.goalRollCalls.push(limit);
    return Promise.resolve(this.goalPeriodsCreated);
  }

  deliverPetCareReminder(occurrenceId: string, at: string): Promise<PetCareReminderOutcome> {
    this.check();
    this.petCareReminderCalls.push({ occurrenceId, at });
    return Promise.resolve(this.petCareReminderOutcome);
  }

  advancePetCare(limit: number): Promise<number> {
    this.check();
    this.petCareAdvanceCalls.push(limit);
    return Promise.resolve(this.petCareCreated);
  }

  deliverCalendarReminder(
    eventId: string,
    on: string,
    at: string,
  ): Promise<CalendarReminderOutcome> {
    this.check();
    this.calendarReminderCalls.push({ eventId, on, at });
    return Promise.resolve(this.calendarReminderOutcome);
  }

  getStorageObjectDeletion(id: string): Promise<{ objectKey: string; done: boolean } | null> {
    this.check();
    const deletion = this.deletions.get(id);
    return Promise.resolve(deletion ? { ...deletion } : null);
  }

  completeStorageObjectDeletion(id: string): Promise<boolean> {
    this.check();
    const deletion = this.deletions.get(id);
    if (!deletion || deletion.done) return Promise.resolve(false);
    deletion.done = true;
    return Promise.resolve(true);
  }
}

/** An in-memory object store; `down` makes every call fail like an outage. */
export class FakeObjects implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  down = false;

  private check(): void {
    if (this.down) throw new StorageUnavailableError("network");
  }

  presignPut(key: string): PresignedUpload {
    return { url: `https://store.test/${key}?signed`, headers: {} };
  }

  presignGet(key: string): string {
    return `https://store.test/${key}?signed`;
  }

  head(key: string): Promise<ObjectFacts | null> {
    this.check();
    const bytes = this.objects.get(key);
    return Promise.resolve(bytes ? { size: bytes.byteLength, contentType: null } : null);
  }

  get(key: string): Promise<ObjectRead> {
    this.check();
    const bytes = this.objects.get(key);
    return Promise.resolve(
      bytes ? { status: "ok", bytes, contentType: null } : { status: "missing" },
    );
  }

  put(key: string, bytes: Uint8Array): Promise<void> {
    this.check();
    this.objects.set(key, bytes);
    return Promise.resolve();
  }

  copy(sourceKey: string, destKey: string): Promise<"copied" | "missing"> {
    this.check();
    const bytes = this.objects.get(sourceKey);
    if (!bytes) return Promise.resolve("missing");
    this.objects.set(destKey, bytes.slice());
    return Promise.resolve("copied");
  }

  delete(key: string): Promise<void> {
    this.check();
    this.objects.delete(key);
    this.deleted.push(key);
    return Promise.resolve();
  }
}

/**
 * A mail transport that behaves like Resend with idempotency keys: the same key sends once. Results
 * are queued so a test can make the provider fail first and succeed later.
 */
export class FakeMail implements EmailTransport {
  /** Emails the provider actually delivered (one per distinct idempotency key). */
  readonly delivered: OutgoingEmail[] = [];
  /** Every request, including repeats of a key. */
  readonly requests: OutgoingEmail[] = [];
  /** Consumed one per request; the default is success. */
  results: SendResult[] = [];

  send(email: OutgoingEmail): Promise<SendResult> {
    this.requests.push(email);
    const result = this.results.shift() ?? { ok: true };
    if (result.ok && !this.delivered.some((sent) => sent.idempotencyKey === email.idempotencyKey)) {
      this.delivered.push(email);
    }
    return Promise.resolve(result);
  }
}

export function fakeServices(
  overrides: Partial<JobServices> = {},
): JobServices & { data: FakeJobData; mail: FakeMail | null } {
  return {
    data: new FakeJobData(),
    mail: new FakeMail(),
    appUrl: "https://app.madeora.test",
    objects: null,
    googleCalendar: null,
    ...overrides,
  } as JobServices & { data: FakeJobData; mail: FakeMail | null };
}
