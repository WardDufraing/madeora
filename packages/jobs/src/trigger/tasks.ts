/**
 * Trigger.dev tasks (architecture.md §11). `trigger.config.ts` points the Trigger.dev CLI at this
 * folder; every exported task is deployed. One task per job, with the job's retry policy, plus the
 * scheduled outbox dispatcher.
 */
import { createClient } from "@supabase/supabase-js";
import { schedules, task } from "@trigger.dev/sdk";

import type { Database } from "@madeora/database";
import { parseStorageEnv } from "@madeora/storage";

import type { AnyJobDefinition } from "../definition.ts";
import { DISPATCH_BATCH_SIZE } from "../dispatcher.ts";
import { choreClaimRelease, choreReminder } from "../jobs/chores.ts";
import { invitationEmail } from "../jobs/invitation-email.ts";
import { notificationEmail } from "../jobs/notification-email.ts";
import { recoveryReady } from "../jobs/recovery-ready.ts";
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
    services: createJobServices(client, env, parseStorageEnv(process.env)),
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
export const storageUploadExpireTask = jobTask(storageUploadExpire);
export const storageFilePurgeTask = jobTask(storageFilePurge);
export const storageObjectDeleteTask = jobTask(storageObjectDelete);
export const trashEntryPurgeTask = jobTask(trashEntryPurge);
export const taskReminderTask = jobTask(taskReminder);
export const choreClaimReleaseTask = jobTask(choreClaimRelease);
export const choreReminderTask = jobTask(choreReminder);

/** How many recurring series one hourly run looks ahead for; the rest wait for the next hour. */
const REMINDER_ADVANCE_BATCH = 200;

// Recurring occurrences are created lazily, so a reminder days before a due date needs its
// occurrence to exist in time. Hourly: ~720 runs a month, well inside the free tier.
export const taskReminderAdvance = schedules.task({
  id: "task-reminder-advance",
  cron: "0 * * * *",
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 },
  maxDuration: 90,
  run: async () => {
    const { services, logger } = getServices();
    const created = await services.data.advanceReminderSeries(REMINDER_ADVANCE_BATCH);
    logger.info("jobs.task_reminder_advance.done", { created });
    return { created };
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

export const outboxDispatch = schedules.task({
  id: "outbox-dispatch",
  cron: "*/5 * * * *",
  // One sweep at a time; claims are safe concurrently, but overlapping sweeps only waste runs.
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 2, minTimeoutInMs: 5_000, maxTimeoutInMs: 30_000, factor: 2 },
  // Below the 120-second claim lease, so a sweep never holds rows past their lease.
  maxDuration: 90,
  run: async () => {
    const { client, store, logger } = getServices();
    return sweepOutbox({
      store,
      client: triggerDispatchClient,
      registry: jobRegistry,
      logger,
      batchSize: DISPATCH_BATCH_SIZE,
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
