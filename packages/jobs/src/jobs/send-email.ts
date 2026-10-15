/**
 * Sending one rendered email from a job, the same way for every email job: the job's idempotency
 * key goes to the provider, so a retried job (a crash after the provider accepted the email and
 * before the outcome was recorded, a Trigger.dev retry) cannot send a duplicate; a refusal is
 * permanent, an outage is retried. Nothing here logs an address, a subject or a body.
 */
import type { EmailTransport, RenderedEmail } from "@madeora/email";

import { PermanentJobError, RetryableJobError } from "../errors.ts";

export type SendOutcome = "sent";

/**
 * Sends `email` to `to`. Resolves when the provider accepted it. Throws `RetryableJobError`
 * (`email_unavailable`) when the provider could not be reached or is limiting us, and
 * `PermanentJobError` (`email_rejected`) when it refused this email.
 */
export async function sendJobEmail(
  mail: EmailTransport,
  to: string,
  email: RenderedEmail,
  idempotencyKey: string,
): Promise<SendOutcome> {
  const result = await mail.send({ to, idempotencyKey, ...email });
  if (result.ok) return "sent";
  if (result.reason === "unavailable") throw new RetryableJobError("email_unavailable");
  throw new PermanentJobError("email_rejected");
}
