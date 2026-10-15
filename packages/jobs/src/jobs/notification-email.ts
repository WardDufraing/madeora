import { z } from "zod";

import { defineJob } from "../definition.ts";
import { PermanentJobError, RetryableJobError } from "../errors.ts";
import { buildNotificationEmail } from "./notification-email-content.ts";
import { sendJobEmail } from "./send-email.ts";

/**
 * Emails one notification (S14). The payload is the notification's id and nothing else; the job
 * asks the database for the address, language, kind and Home, which re-checks the recipient's
 * membership, their current email choice and their confirmed address (an essential security notice
 * always passes). Whatever happens here, the in-app notification already exists and stays: email
 * only ever updates the notification's `email_status`.
 *
 * - Nothing to send any more (choice off, membership gone, no address): recorded as skipped.
 * - No email transport in this environment: recorded as not_configured, the job succeeds.
 * - The provider is down or limiting: recorded as failed and retried; the same idempotency key
 *   goes to the provider on every attempt, so a retry after a lost answer cannot send twice.
 * - The provider refuses, or the kind has no template: recorded as failed, not retried.
 */
export const notificationEmail = defineJob({
  name: "notification-email",
  version: 1,
  payload: z.strictObject({ notificationId: z.uuid() }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 120,
  async handle(data, { services, logger, idempotencyKey }) {
    const read = await services.data.getNotificationEmail(data.notificationId);
    if (read.outcome === "not_found") {
      logger.warn("jobs.notification_email.not_found");
      throw new PermanentJobError("notification_not_found");
    }
    if (read.outcome === "already_done") {
      logger.info("jobs.notification_email.already_done");
      return;
    }
    if (read.outcome !== "ok") {
      await services.data.recordNotificationEmail(data.notificationId, "skipped", null);
      logger.info("jobs.notification_email.skipped", { reason: read.outcome });
      return;
    }
    if (!services.mail || !services.appUrl) {
      await services.data.recordNotificationEmail(data.notificationId, "not_configured", null);
      logger.info("jobs.notification_email.not_configured");
      return;
    }

    let email;
    try {
      email = await buildNotificationEmail({ ...read, appUrl: services.appUrl });
    } catch (error) {
      const code = error instanceof PermanentJobError ? error.code : "render_failed";
      await services.data.recordNotificationEmail(data.notificationId, "failed", code);
      logger.error("jobs.notification_email.not_rendered", { kind: read.kind, errorCode: code });
      throw new PermanentJobError(code);
    }

    try {
      await sendJobEmail(services.mail, read.to, email, idempotencyKey);
    } catch (error) {
      const retryable = error instanceof RetryableJobError;
      await services.data.recordNotificationEmail(
        data.notificationId,
        "failed",
        retryable ? "email_unavailable" : "email_rejected",
      );
      logger.warn("jobs.notification_email.send_failed", {
        kind: read.kind,
        retryable,
      });
      throw error;
    }
    await services.data.recordNotificationEmail(data.notificationId, "sent", null);
    logger.info("jobs.notification_email.sent", { kind: read.kind });
  },
});
