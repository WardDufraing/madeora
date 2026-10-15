/**
 * What the email jobs (S14) need from the outside world, behind small interfaces so every rule is
 * unit-tested with fakes. The production implementations are `createSupabaseJobData` (narrow
 * `service_role` functions through `supabase.rpc()`, never a table) and an `EmailTransport` from
 * `@madeora/email`.
 */
import type { EmailTransport } from "@madeora/email";
import type { ObjectStore } from "@madeora/storage";

export type EmailLanguage = "en" | "nl";

/** What an email job reads about one notification, re-checked by the database at send time. */
export type NotificationEmailRead =
  | {
      readonly outcome: "ok";
      readonly to: string;
      readonly locale: EmailLanguage;
      readonly kind: string;
      readonly homeId: string | null;
      readonly homeName: string | null;
      readonly homeTimeZone: string | null;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | {
      readonly outcome:
        "not_found" | "already_done" | "not_member" | "disabled" | "no_address" | "cannot_receive";
    };

export type InvitationEmailRead =
  | {
      readonly outcome: "ok";
      readonly to: string;
      readonly locale: EmailLanguage;
      readonly role: "member" | "administrator";
      /** The secret part of the link; only ever in memory, never logged. */
      readonly token: string;
      readonly expiresAt: Date;
      readonly homeName: string;
      readonly homeTimeZone: string;
    }
  | { readonly outcome: "not_found" | "superseded" | "not_active" };

export type EmailRecordStatus = "sent" | "failed" | "skipped" | "not_configured";

export interface JobDataPort {
  getNotificationEmail(notificationId: string): Promise<NotificationEmailRead>;
  /** False when the notification is no longer waiting for an email outcome. */
  recordNotificationEmail(
    notificationId: string,
    status: EmailRecordStatus,
    errorCode: string | null,
  ): Promise<boolean>;
  getInvitationEmail(invitationId: string, send: number): Promise<InvitationEmailRead>;
  /** False when a newer send has taken over the invitation's status. */
  recordInvitationEmail(
    invitationId: string,
    send: number,
    status: Exclude<EmailRecordStatus, "skipped">,
  ): Promise<boolean>;
  deliverRecoveryReady(
    recoveryId: string,
    objectionEndsAt: Date,
  ): Promise<"notified" | "not_ready">;
  /** storage-upload-expire (S15): settles an upload after its intent ended; its status afterwards. */
  expireUpload(fileId: string): Promise<StoredFileStatus>;
  /** storage-file-purge (S15): purges a deleted file past its recovery window; its status afterwards. */
  purgeStoredFile(fileId: string): Promise<StoredFileStatus>;
  /** storage-object-delete (S15): the key to remove, or null when the row is gone. */
  getStorageObjectDeletion(
    deletionId: string,
  ): Promise<{ readonly objectKey: string; readonly done: boolean } | null>;
  /** False when it was already done. */
  completeStorageObjectDeletion(deletionId: string): Promise<boolean>;
}

export type StoredFileStatus = "pending" | "ready" | "failed" | "deleted" | "purged" | "missing";

export interface JobServices {
  readonly data: JobDataPort;
  /** Null when the environment sends no email (`EMAIL_TRANSPORT` off): in-app delivery goes on. */
  readonly mail: EmailTransport | null;
  /** The web app's address, for the links in emails; null when `mail` is. */
  readonly appUrl: string | null;
  /** The object store (S15), or null where storage is off (`STORAGE_DRIVER` unset or `off`). */
  readonly objects: ObjectStore | null;
}
