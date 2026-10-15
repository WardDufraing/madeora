/**
 * In-memory stand-ins for the email jobs' services (S14). Test-only; the real database functions
 * are covered by tests/db/rls/notifications.test.sql.
 */
import type { EmailTransport, OutgoingEmail, SendResult } from "@madeora/email";

import type {
  EmailRecordStatus,
  InvitationEmailRead,
  JobDataPort,
  JobServices,
  NotificationEmailRead,
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

  deliverRecoveryReady(recoveryId: string, endsAt: Date): Promise<"notified" | "not_ready"> {
    this.check();
    this.readyCalls.push({ recoveryId, endsAt });
    return Promise.resolve(this.readyOutcome);
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
    ...overrides,
  } as JobServices & { data: FakeJobData; mail: FakeMail | null };
}
