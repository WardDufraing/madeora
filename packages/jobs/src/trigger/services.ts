import { createMailpitTransport, createResendTransport, type EmailTransport } from "@madeora/email";

import type { JobsSupabaseClient } from "../supabase-store.ts";
import { createSupabaseJobData } from "../supabase-data.ts";
import type { JobServices } from "../services.ts";
import type { WorkerEnv } from "./env.ts";

/** The email transport this environment is configured for, or null when it sends no email. */
export function createWorkerMail(env: WorkerEnv): EmailTransport | null {
  if (env.EMAIL_TRANSPORT === "resend" && env.RESEND_API_KEY && env.EMAIL_FROM) {
    return createResendTransport({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM });
  }
  if (env.EMAIL_TRANSPORT === "mailpit" && env.MAILPIT_URL && env.EMAIL_FROM) {
    return createMailpitTransport({ url: env.MAILPIT_URL, from: env.EMAIL_FROM });
  }
  return null;
}

/** What the email jobs run with: narrow database functions, the transport and the app address. */
export function createJobServices(client: JobsSupabaseClient, env: WorkerEnv): JobServices {
  const mail = createWorkerMail(env);
  return { data: createSupabaseJobData(client), mail, appUrl: mail ? (env.APP_URL ?? null) : null };
}
