import { renderSecurityEmail } from "@madeora/email";
import { z } from "zod";

import { defineJob } from "../definition.ts";
import { PermanentJobError, RetryableJobError } from "../errors.ts";
import { sendJobEmail } from "./send-email.ts";

const paths = {
  backup_verify: "/auth/confirm-backup-email",
  recovery_link: "/account-recovery/continue",
  recovery_ready: "/account-recovery/finish",
} as const;

/**
 * Emails a backup or new address (S37): the link that verifies a backup address, and the account
 * recovery messages to the backup address. The payload is only the email's id; the address and the
 * link's secret are read at send time and the secret is erased once the outcome is recorded, so it
 * is never in a payload, a log or the Trigger.dev dashboard. An expired or already sent email sends
 * nothing.
 */
export const securityEmail = defineJob({
  name: "security-email",
  version: 1,
  payload: z.strictObject({ emailId: z.uuid() }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 120,
  async handle(data, { services, logger, idempotencyKey, attempt }) {
    const read = await services.data.getSecurityEmail(data.emailId);
    if (read.outcome !== "ok") {
      logger.info("jobs.security_email.skipped");
      return;
    }
    if (!services.mail || !services.appUrl) {
      await services.data.recordSecurityEmail(data.emailId, "not_configured");
      logger.info("jobs.security_email.not_configured");
      return;
    }

    let email;
    try {
      const url =
        read.kind === "recovery_started" || read.token === null
          ? null
          : (() => {
              const link = new URL(paths[read.kind], services.appUrl);
              link.searchParams.set("token", read.token);
              return link.toString();
            })();
      email = await renderSecurityEmail({
        kind: read.kind,
        locale: read.locale,
        url,
        expiresAt: read.expiresAt,
      });
    } catch {
      await services.data.recordSecurityEmail(data.emailId, "failed");
      logger.error("jobs.security_email.not_rendered", { kind: read.kind });
      throw new PermanentJobError("render_failed");
    }

    try {
      await sendJobEmail(services.mail, read.to, email, idempotencyKey);
    } catch (error) {
      const retryable = error instanceof RetryableJobError;
      if (!retryable || attempt >= securityEmail.retry.maxAttempts) {
        await services.data.recordSecurityEmail(data.emailId, "failed");
      }
      logger.warn("jobs.security_email.send_failed", { kind: read.kind, retryable });
      throw error;
    }
    await services.data.recordSecurityEmail(data.emailId, "sent");
    logger.info("jobs.security_email.sent", { kind: read.kind });
  },
});

/**
 * The end of an account recovery's 72-hour wait (S37). Queued when the wait starts, to run at its
 * end. The database re-checks that the recovery is still waiting for that time (not cancelled by
 * the account holder) and then queues the finishing link to the backup address itself.
 */
export const accountRecoveryReady = defineJob({
  name: "account-recovery-ready",
  version: 1,
  payload: z.strictObject({ recoveryId: z.uuid(), readyAt: z.iso.datetime({ offset: true }) }),
  retry: { maxAttempts: 5 },
  leaseSeconds: 60,
  async handle(data, { services, logger }) {
    const outcome = await services.data.deliverAccountRecoveryReady(
      data.recoveryId,
      new Date(data.readyAt),
    );
    logger.info("jobs.account_recovery_ready.done", { outcome });
  },
});
