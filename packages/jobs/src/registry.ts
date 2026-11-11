import { createJobRegistry, type AnyJobDefinition } from "./definition.ts";
import { calendarEventReminder } from "./jobs/calendar.ts";
import { googleCalendarSync } from "./jobs/google-calendar.ts";
import { choreClaimRelease, choreReminder, vacationReminder } from "./jobs/chores.ts";
import { goalReminder } from "./jobs/goals.ts";
import { petCareReminder } from "./jobs/pets.ts";
import { homeCopyFiles } from "./jobs/home-copy.ts";
import { habitPauseEnd, habitReminder, habitReminderSnooze } from "./jobs/habits.ts";
import { invitationEmail } from "./jobs/invitation-email.ts";
import { notificationEmail } from "./jobs/notification-email.ts";
import { privacyExportBuild } from "./jobs/privacy-export.ts";
import { recoveryReady } from "./jobs/recovery-ready.ts";
import { samplePing } from "./jobs/sample-ping.ts";
import { accountRecoveryReady, securityEmail } from "./jobs/security-email.ts";
import { taskReminder } from "./jobs/task-reminder.ts";
import { trashEntryPurge } from "./jobs/trash.ts";
import { storageFilePurge, storageObjectDelete, storageUploadExpire } from "./jobs/storage.ts";

/**
 * Every job this code can run. Adding a job: define it in `src/jobs/`, list it here, and add its
 * Trigger.dev task in `src/trigger/tasks.ts` (docs/background-jobs.md, "Adding a job").
 */
export const jobs: readonly AnyJobDefinition[] = [
  samplePing,
  notificationEmail,
  invitationEmail,
  recoveryReady,
  storageUploadExpire,
  storageFilePurge,
  storageObjectDelete,
  trashEntryPurge,
  taskReminder,
  choreClaimRelease,
  choreReminder,
  vacationReminder,
  habitReminder,
  habitReminderSnooze,
  habitPauseEnd,
  goalReminder,
  petCareReminder,
  calendarEventReminder,
  googleCalendarSync,
  securityEmail,
  accountRecoveryReady,
  privacyExportBuild,
  homeCopyFiles,
];

export const jobRegistry = createJobRegistry(jobs);
