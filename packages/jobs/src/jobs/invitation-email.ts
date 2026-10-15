import { renderHomeInvitationEmail } from "@madeora/email";
import { z } from "zod";

import { defineJob } from "../definition.ts";
import { PermanentJobError, RetryableJobError } from "../errors.ts";
import { sendJobEmail } from "./send-email.ts";

/**
 * Emails one Home invitation (S10, moved to the outbox in S14). The payload is the invitation id
 * and the send number (first send, resend or renewal); the job reads the address, language, role
 * and link from the database at send time, so the secret link is never in a payload, a log or the
 * Trigger.dev dashboard. A revoked, used, expired or superseded invitation sends nothing.
 *
 * The outcome is written to the invitation's delivery status (`sent`, `failed`, `not_configured`),
 * which the manager sees, and only for the send that is still current.
 */
export const invitationEmail = defineJob({
  name: "invitation-email",
  version: 1,
  payload: z.strictObject({ invitationId: z.uuid(), send: z.int().min(1).max(10_000) }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 120,
  async handle(data, { services, logger, idempotencyKey, attempt }) {
    const read = await services.data.getInvitationEmail(data.invitationId, data.send);
    if (read.outcome !== "ok") {
      logger.info("jobs.invitation_email.skipped", { reason: read.outcome });
      return;
    }
    if (!services.mail || !services.appUrl) {
      await services.data.recordInvitationEmail(data.invitationId, data.send, "not_configured");
      logger.info("jobs.invitation_email.not_configured");
      return;
    }

    let email;
    try {
      email = await renderHomeInvitationEmail({
        locale: read.locale,
        homeName: read.homeName,
        role: read.role,
        recipientEmail: read.to,
        url: new URL(`/join/${encodeURIComponent(read.token)}`, services.appUrl).toString(),
        expiresAt: read.expiresAt,
        timeZone: read.homeTimeZone,
      });
    } catch {
      await services.data.recordInvitationEmail(data.invitationId, data.send, "failed");
      logger.error("jobs.invitation_email.not_rendered");
      throw new PermanentJobError("render_failed");
    }

    try {
      await sendJobEmail(services.mail, read.to, email, idempotencyKey);
    } catch (error) {
      // The manager sees "Sending" while a retry is still to come, and "Not sent" only once the
      // email is refused or the attempts are used up.
      const retryable = error instanceof RetryableJobError;
      if (!retryable || attempt >= invitationEmail.retry.maxAttempts) {
        await services.data.recordInvitationEmail(data.invitationId, data.send, "failed");
      }
      logger.warn("jobs.invitation_email.send_failed", { retryable });
      throw error;
    }
    await services.data.recordInvitationEmail(data.invitationId, data.send, "sent");
    logger.info("jobs.invitation_email.sent");
  },
});
