/**
 * In-memory stand-ins for the email jobs' services (S14). Test-only; the real database functions
 * are covered by tests/db/rls/notifications.test.sql.
 */
import type { EmailTransport, OutgoingEmail, SendResult } from "@madeora/email";
import {
  StorageUnavailableError,
  type ObjectFacts,
  type ObjectRead,
  type ObjectStore,
  type PresignedUpload,
} from "@madeora/storage";

import type {
  EmailRecordStatus,
  InvitationEmailRead,
  JobDataPort,
  JobServices,
  NotificationEmailRead,
  StoredFileStatus,
  TrashEntryStatus,
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
  /** Storage (S15): file statuses the database functions return, and the deletion queue. */
  expireStatus: StoredFileStatus = "failed";
  purgeStatus: StoredFileStatus = "purged";
  trashStatus: TrashEntryStatus = "purged";
  readonly trashCalls: string[] = [];
  readonly fileCalls: { operation: "expire" | "purge"; fileId: string }[] = [];
  readonly deletions = new Map<string, { objectKey: string; done: boolean }>();

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

  expireUpload(fileId: string): Promise<StoredFileStatus> {
    this.check();
    this.fileCalls.push({ operation: "expire", fileId });
    return Promise.resolve(this.expireStatus);
  }

  purgeStoredFile(fileId: string): Promise<StoredFileStatus> {
    this.check();
    this.fileCalls.push({ operation: "purge", fileId });
    return Promise.resolve(this.purgeStatus);
  }

  purgeExpiredTrashEntry(entryId: string): Promise<TrashEntryStatus> {
    this.check();
    this.trashCalls.push(entryId);
    return Promise.resolve(this.trashStatus);
  }

  getStorageObjectDeletion(id: string): Promise<{ objectKey: string; done: boolean } | null> {
    this.check();
    const deletion = this.deletions.get(id);
    return Promise.resolve(deletion ? { ...deletion } : null);
  }

  completeStorageObjectDeletion(id: string): Promise<boolean> {
    this.check();
    const deletion = this.deletions.get(id);
    if (!deletion || deletion.done) return Promise.resolve(false);
    deletion.done = true;
    return Promise.resolve(true);
  }
}

/** An in-memory object store; `down` makes every call fail like an outage. */
export class FakeObjects implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  down = false;

  private check(): void {
    if (this.down) throw new StorageUnavailableError("network");
  }

  presignPut(key: string): PresignedUpload {
    return { url: `https://store.test/${key}?signed`, headers: {} };
  }

  presignGet(key: string): string {
    return `https://store.test/${key}?signed`;
  }

  head(key: string): Promise<ObjectFacts | null> {
    this.check();
    const bytes = this.objects.get(key);
    return Promise.resolve(bytes ? { size: bytes.byteLength, contentType: null } : null);
  }

  get(key: string): Promise<ObjectRead> {
    this.check();
    const bytes = this.objects.get(key);
    return Promise.resolve(
      bytes ? { status: "ok", bytes, contentType: null } : { status: "missing" },
    );
  }

  put(key: string, bytes: Uint8Array): Promise<void> {
    this.check();
    this.objects.set(key, bytes);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.check();
    this.objects.delete(key);
    this.deleted.push(key);
    return Promise.resolve();
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
    objects: null,
    ...overrides,
  } as JobServices & { data: FakeJobData; mail: FakeMail | null };
}
