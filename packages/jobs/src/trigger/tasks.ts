/**
 * Trigger.dev tasks (architecture.md §11). `trigger.config.ts` points the Trigger.dev CLI at this
 * folder; every exported task is deployed. One task per job, with the job's retry policy, plus the
 * scheduled outbox dispatcher.
 */
import { createClient } from "@supabase/supabase-js";
import { schedules, task } from "@trigger.dev/sdk";

import type { Database } from "@madeora/database";
import { parseGoogleCalendarEnv } from "@madeora/google-calendar";
import { parseStorageEnv } from "@madeora/storage";

import type { AnyJobDefinition } from "../definition.ts";
import { DISPATCH_BATCH_SIZE } from "../dispatcher.ts";
import { choreClaimRelease, choreReminder, vacationReminder } from "../jobs/chores.ts";
import { goalReminder } from "../jobs/goals.ts";
import { petCareReminder } from "../jobs/pets.ts";
import { calendarEventReminder } from "../jobs/calendar.ts";
import { googleCalendarSync } from "../jobs/google-calendar.ts";
import { habitPauseEnd, habitReminder, habitReminderSnooze } from "../jobs/habits.ts";
import { invitationEmail } from "../jobs/invitation-email.ts";
import { notificationEmail } from "../jobs/notification-email.ts";
import { privacyExportBuild } from "../jobs/privacy-export.ts";
import { recoveryReady } from "../jobs/recovery-ready.ts";
import { accountRecoveryReady, securityEmail } from "../jobs/security-email.ts";
import { samplePing } from "../jobs/sample-ping.ts";
import { storageFilePurge, storageObjectDelete, storageUploadExpire } from "../jobs/storage.ts";
import { taskReminder } from "../jobs/task-reminder.ts";
import { trashEntryPurge } from "../jobs/trash.ts";
import { jobRegistry } from "../registry.ts";
import { createSupabaseJobStore, JobStoreError } from "../supabase-store.ts";
import { parseWorkerEnv } from "./env.ts";
import { createJobServices } from "./services.ts";
import { jobLogger, retryTiming, runJobTask, sweepOutbox, triggerDispatchClient } from "./run.ts";

// Created on first use inside a run, so loading the tasks (deploys, indexing) needs no secrets.
let services: ReturnType<typeof createServices> | undefined;

function createServices() {
  const env = parseWorkerEnv(process.env);
  const client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    client,
    store: createSupabaseJobStore(client),
    services: createJobServices(
      client,
      env,
      parseStorageEnv(process.env),
      parseGoogleCalendarEnv(process.env),
    ),
    logger: jobLogger(env.APP_ENV),
  };
}

function getServices() {
  services ??= createServices();
  return services;
}

function jobTask<const Name extends string>(definition: AnyJobDefinition & { name: Name }) {
  return task({
    id: definition.name,
    retry: {
      maxAttempts: definition.retry.maxAttempts,
      factor: definition.retry.factor,
      minTimeoutInMs: definition.retry.minTimeoutMs,
      maxTimeoutInMs: definition.retry.maxTimeoutMs,
      randomize: true,
    },
    // A run may never outlive its execution lease, or a second run could take the key over.
    maxDuration: definition.leaseSeconds,
    run: async (payload: unknown) => {
      const { store, logger, services } = getServices();
      return runJobTask(definition, payload, { store, logger, services });
    },
    catchError: ({ error }) => retryTiming(error),
  });
}

export const samplePingTask = jobTask(samplePing);
export const notificationEmailTask = jobTask(notificationEmail);
export const invitationEmailTask = jobTask(invitationEmail);
export const recoveryReadyTask = jobTask(recoveryReady);
export const securityEmailTask = jobTask(securityEmail);
export const accountRecoveryReadyTask = jobTask(accountRecoveryReady);
export const storageUploadExpireTask = jobTask(storageUploadExpire);
export const storageFilePurgeTask = jobTask(storageFilePurge);
export const storageObjectDeleteTask = jobTask(storageObjectDelete);
export const trashEntryPurgeTask = jobTask(trashEntryPurge);
export const taskReminderTask = jobTask(taskReminder);
export const choreClaimReleaseTask = jobTask(choreClaimRelease);
export const choreReminderTask = jobTask(choreReminder);
export const vacationReminderTask = jobTask(vacationReminder);
export const habitReminderTask = jobTask(habitReminder);
export const habitReminderSnoozeTask = jobTask(habitReminderSnooze);
export const habitPauseEndTask = jobTask(habitPauseEnd);
export const goalReminderTask = jobTask(goalReminder);
export const petCareReminderTask = jobTask(petCareReminder);
export const calendarEventReminderTask = jobTask(calendarEventReminder);
export const googleCalendarSyncTask = jobTask(googleCalendarSync);
export const privacyExportBuildTask = jobTask(privacyExportBuild);

/** How many recurring series one hourly run looks ahead for; the rest wait for the next hour. */
const REMINDER_ADVANCE_BATCH = 200;

/** How many Homes and accounts one hourly run deletes for good (S40); the rest wait an hour. */
const DELETION_PURGE_BATCH = 20;

// Recurring occurrences are created lazily, so a reminder days before a due date needs its
// occurrence to exist in time; the same run tops up habit reminder chains whose next moment is
// missing (S28), and rolls recurring goal series (S30b): ended periods are finalized and the period
// running now is created (reads also roll lazily), and creates pet-care occurrences a week ahead with
// their reminders (S31; pages also do it lazily). Hourly: ~720 runs a month, well inside the free
// tier; no extra schedule.
export const taskReminderAdvance = schedules.task({
  id: "task-reminder-advance",
  cron: "0 * * * *",
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 },
  maxDuration: 90,
  run: async () => {
    const { services, logger } = getServices();
    const created = await services.data.advanceReminderSeries(REMINDER_ADVANCE_BATCH);
    const habits = await services.data.advanceHabitReminders(REMINDER_ADVANCE_BATCH);
    const goalPeriods = await services.data.rollGoalPeriods(REMINDER_ADVANCE_BATCH);
    const petCare = await services.data.advancePetCare(REMINDER_ADVANCE_BATCH);
    // S38: activity history past its 12-month retention; a cheap delete, no extra schedule.
    const activityPurged = await services.data.purgeAccountActivity();
    // S38: long-term inactivity reminders; at most a few per account, ever.
    const inactivityReminders = await services.data.sendInactivityReminders(REMINDER_ADVANCE_BATCH);
    // S39: data exports past their 7 days, the warning a day before, and stuck preparations.
    const dataExports = await services.data.sweepDataExports(REMINDER_ADVANCE_BATCH);
    // S40: Homes and accounts whose 30-day recovery period ended; a few per hour at most.
    const deletions = await services.data.purgeDueDeletions(DELETION_PURGE_BATCH);
    logger.info("jobs.task_reminder_advance.done", {
      created,
      habits,
      goalPeriods,
      petCare,
      activityPurged,
      inactivityReminders,
      dataExports,
      homesPurged: deletions.homes,
      accountsPurged: deletions.accounts,
      purgesFailed: deletions.failed,
    });
    return {
      created,
      habits,
      goalPeriods,
      petCare,
      activityPurged,
      inactivityReminders,
      dataExports,
      deletions,
    };
  },
});

/** How many daily summaries one hourly run handles; the rest wait for the next hour. */
const CHORE_SUMMARY_BATCH = 200;

// The chore managers' daily summaries (S21): each is due from its hour in the person's timezone, so
// an hourly run sends those whose hour has come. ~720 runs a month, well inside the free tier.
export const choreDigest = schedules.task({
  id: "chore-digest",
  cron: "5 * * * *",
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 },
  maxDuration: 90,
  run: async () => {
    const { services, logger } = getServices();
    const sent = await services.data.sendChoreSummaries(CHORE_SUMMARY_BATCH);
    logger.info("jobs.chore_digest.done", { sent });
    return { sent };
  },
});

/** How many settled sign-ins one sweep classifies (S38); the rest wait for the next one. */
const SIGN_IN_BATCH = 200;

/** How many connections one sweep queues for their automatic sync; the rest wait for the next one. */
const GOOGLE_SYNC_QUEUE_BATCH = 100;

export const outboxDispatch = schedules.task({
  id: "outbox-dispatch",
  cron: "*/5 * * * *",
  // One sweep at a time; claims are safe concurrently, but overlapping sweeps only waste runs.
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 },
  // Below the 120-second claim lease, so a sweep never holds rows past their lease.
  maxDuration: 90,
  run: async () => {
    const { client, store, logger, services } = getServices();
    return sweepOutbox({
      store,
      client: triggerDispatchClient,
      registry: jobRegistry,
      logger,
      batchSize: DISPATCH_BATCH_SIZE,
      // Google Calendar (S33): connections due for their 15-minute sync; no extra schedule or run.
      // S38: settled sign-ins are classified for the activity history and their alerts sent.
      prepare: async () => ({
        googleCalendarSyncs: await services.data.queueGoogleCalendarSyncs(GOOGLE_SYNC_QUEUE_BATCH),
        signInsClassified: await services.data.processSignInEvents(SIGN_IN_BATCH),
      }),
      stats: async () => {
        const { data, error } = await client.rpc("job_outbox_stats");
        if (error) throw new JobStoreError("job_outbox_stats", error.code);
        const [row] = data;
        return {
          pending: row?.pending ?? 0,
          dispatching: row?.dispatching ?? 0,
          dead: row?.dead ?? 0,
          oldestPendingSeconds: row?.oldest_pending_seconds ?? 0,
          failedExecutions: row?.failed_executions ?? 0,
          stalledExecutions: row?.stalled_executions ?? 0,
          unexecutedDispatches: row?.unexecuted_dispatches ?? 0,
        };
      },
    });
  },
});
