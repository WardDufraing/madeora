/**
 * Runs jobs in one process instead of in Trigger.dev, for tests and local checks (S14): the same
 * outbox, dispatcher, executor and handlers, with a dispatch client that runs the job at once.
 * There is no scheduler, no dashboard and no durable retry: a job that keeps failing stops after
 * its attempts and its outbox row stays `dispatched` with the execution recorded as failed.
 * Production uses Trigger.dev (docs/trigger-setup.md); developers who want the real thing run
 * `trigger dev` against its free Dev environment.
 *
 * It only ever sends mail through the local Mailpit catcher, and refuses a Supabase address that
 * is not on this machine, so it can never reach a hosted project or a real mailbox.
 */
import type { Database } from "@madeora/database";
import { createMailpitTransport } from "@madeora/email";
import { createLogger, type Logger } from "@madeora/observability";
import { createObjectStore, type StorageConfig } from "@madeora/storage";
import { createClient } from "@supabase/supabase-js";

import { DispatchRejectedError, dispatchOutbox, type DispatchClient } from "./dispatcher.ts";
import { classifyError } from "./errors.ts";
import { runJob } from "./executor.ts";
import { jobRegistry } from "./registry.ts";
import type { JobServices } from "./services.ts";
import type { ExecutionStore, OutboxStore } from "./store.ts";
import { createSupabaseJobData } from "./supabase-data.ts";
import { createSupabaseJobStore } from "./supabase-store.ts";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface LocalDispatchDependencies {
  readonly store: OutboxStore & ExecutionStore;
  readonly services: JobServices;
  readonly logger: Logger;
  /** Pause between a job's attempts, in milliseconds. */
  readonly retryDelayMs?: number;
}

/** A dispatch client that runs the job right here, with the job's own number of attempts. */
export function createLocalDispatchClient(deps: LocalDispatchDependencies): DispatchClient {
  let runs = 0;
  return {
    async trigger(taskId, envelope) {
      const definition = jobRegistry.get(taskId);
      if (!definition) throw new DispatchRejectedError(404);
      runs += 1;
      for (let attempt = 1; attempt <= definition.retry.maxAttempts; attempt += 1) {
        try {
          await runJob(definition, envelope, deps);
          break;
        } catch (error) {
          if (classifyError(error).kind === "permanent") break;
          if (attempt < definition.retry.maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, deps.retryDelayMs ?? 200));
          }
        }
      }
      return { runId: `local-${String(runs)}` };
    },
  };
}

export interface LocalJobRunnerOptions {
  readonly supabaseUrl: string;
  /** The local stack's service-role key. */
  readonly serviceRoleKey: string;
  readonly mailpitUrl: string;
  readonly from: string;
  /** The web app's address, for the links in emails. */
  readonly appUrl: string;
  /** The local S3 stand-in (S15), if the run uses storage; never a hosted store. */
  readonly storage?: StorageConfig;
}

export interface LocalJobRunner {
  /** Dispatches and runs due jobs until none are left (at most `maxRounds` sweeps); returns how many ran. */
  runUntilIdle(maxRounds?: number): Promise<number>;
}

export function createLocalJobRunner(options: LocalJobRunnerOptions): LocalJobRunner {
  const hosts = [
    options.supabaseUrl,
    options.mailpitUrl,
    ...(options.storage ? [options.storage.endpoint] : []),
  ].map((value) => new URL(value).hostname);
  if (!hosts.every((host) => LOCAL_HOSTS.has(host))) {
    throw new Error(
      "The local job runner only works with Supabase, Mailpit and storage on this machine.",
    );
  }
  const client = createClient<Database>(options.supabaseUrl, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const store = createSupabaseJobStore(client);
  const logger = createLogger({
    env: "test",
    fields: { service: "jobs-local" },
    sink: () => undefined,
  });
  const services: JobServices = {
    data: createSupabaseJobData(client),
    mail: createMailpitTransport({ url: options.mailpitUrl, from: options.from }),
    appUrl: options.appUrl,
    objects: options.storage ? createObjectStore(options.storage) : null,
  };
  const dispatchClient = createLocalDispatchClient({ store, services, logger });
  return {
    async runUntilIdle(maxRounds = 10) {
      let ran = 0;
      for (let round = 0; round < maxRounds; round += 1) {
        const summary = await dispatchOutbox({
          store,
          client: dispatchClient,
          registry: jobRegistry,
          logger,
        });
        ran += summary.dispatched;
        if (summary.claimed === 0) break;
      }
      return ran;
    },
  };
}
