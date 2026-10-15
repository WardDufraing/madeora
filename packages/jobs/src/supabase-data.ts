/**
 * The email jobs' view of Postgres: only the `service_role`-only functions of the S14 migration,
 * through `supabase.rpc()`. The service key could do far more, so nothing here reads a table; each
 * function checks the current state itself (membership, choices, invitation status) and returns
 * just what the job needs. Errors carry the Postgres code only (see `JobStoreError`).
 */
import type { Json } from "@madeora/database";

import type {
  EmailLanguage,
  EmailRecordStatus,
  InvitationEmailRead,
  JobDataPort,
  NotificationEmailRead,
  StoredFileStatus,
} from "./services.ts";
import { JobStoreError, type JobsSupabaseClient } from "./supabase-store.ts";

function language(value: string | null): EmailLanguage {
  return value === "nl" ? "nl" : "en";
}

function isObject(value: Json): value is Readonly<Record<string, Json | undefined>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const notificationSkips = [
  "not_found",
  "already_done",
  "not_member",
  "disabled",
  "no_address",
  "cannot_receive",
] as const;

const invitationSkips = ["not_found", "superseded", "not_active"] as const;

const fileStatuses = ["pending", "ready", "failed", "deleted", "purged", "missing"] as const;

function fileStatus(operation: string, value: string | null): StoredFileStatus {
  const status = oneOf(fileStatuses, value);
  if (!status) throw new JobStoreError(operation, "unexpected_result");
  return status;
}

function oneOf<T extends string>(list: readonly T[], value: string | null | undefined): T | null {
  return list.find((item) => item === value) ?? null;
}

export function createSupabaseJobData(client: JobsSupabaseClient): JobDataPort {
  return {
    async getNotificationEmail(notificationId): Promise<NotificationEmailRead> {
      const { data, error } = await client.rpc("get_notification_email", {
        p_notification_id: notificationId,
      });
      if (error) throw new JobStoreError("get_notification_email", error.code);
      const [row] = data;
      if (row?.outcome === "ok") {
        if (!row.recipient_email || !row.kind) {
          throw new JobStoreError("get_notification_email", "unexpected_result");
        }
        return {
          outcome: "ok",
          to: row.recipient_email,
          locale: language(row.locale),
          kind: row.kind,
          homeId: row.home_id,
          homeName: row.home_name,
          homeTimeZone: row.home_time_zone,
          params: row.params !== null && isObject(row.params) ? row.params : {},
        };
      }
      const outcome = oneOf(notificationSkips, row?.outcome);
      if (!outcome) throw new JobStoreError("get_notification_email", "unexpected_result");
      return { outcome };
    },

    async recordNotificationEmail(notificationId, status, errorCode) {
      const { data, error } = await client.rpc("record_notification_email", {
        p_notification_id: notificationId,
        p_status: status,
        ...(errorCode === null ? {} : { p_error_code: errorCode }),
      });
      if (error) throw new JobStoreError("record_notification_email", error.code);
      return data;
    },

    async getInvitationEmail(invitationId, send): Promise<InvitationEmailRead> {
      const { data, error } = await client.rpc("get_invitation_email", {
        p_invitation_id: invitationId,
        p_send: send,
      });
      if (error) throw new JobStoreError("get_invitation_email", error.code);
      const [row] = data;
      if (row?.outcome === "ok") {
        const role = row.role === "administrator" ? "administrator" : "member";
        if (
          !row.recipient_email ||
          !row.token ||
          !row.expires_at ||
          !row.home_name ||
          !row.home_time_zone
        ) {
          throw new JobStoreError("get_invitation_email", "unexpected_result");
        }
        return {
          outcome: "ok",
          to: row.recipient_email,
          locale: language(row.email_locale),
          role,
          token: row.token,
          expiresAt: new Date(row.expires_at),
          homeName: row.home_name,
          homeTimeZone: row.home_time_zone,
        };
      }
      const outcome = oneOf(invitationSkips, row?.outcome);
      if (!outcome) throw new JobStoreError("get_invitation_email", "unexpected_result");
      return { outcome };
    },

    async recordInvitationEmail(invitationId, send, status) {
      const { data, error } = await client.rpc("record_invitation_email", {
        p_invitation_id: invitationId,
        p_send: send,
        p_status: status satisfies Exclude<EmailRecordStatus, "skipped">,
      });
      if (error) throw new JobStoreError("record_invitation_email", error.code);
      return data;
    },

    async deliverRecoveryReady(recoveryId, objectionEndsAt) {
      const { data, error } = await client.rpc("deliver_recovery_ready", {
        p_recovery_id: recoveryId,
        p_objection_ends_at: objectionEndsAt.toISOString(),
      });
      if (error) throw new JobStoreError("deliver_recovery_ready", error.code);
      return data === "notified" ? "notified" : "not_ready";
    },

    async expireUpload(fileId) {
      const { data, error } = await client.rpc("expire_upload", { p_file_id: fileId });
      if (error) throw new JobStoreError("expire_upload", error.code);
      return fileStatus("expire_upload", data);
    },

    async purgeStoredFile(fileId) {
      const { data, error } = await client.rpc("purge_stored_file", { p_file_id: fileId });
      if (error) throw new JobStoreError("purge_stored_file", error.code);
      return fileStatus("purge_stored_file", data);
    },

    async getStorageObjectDeletion(deletionId) {
      const { data, error } = await client.rpc("get_storage_object_deletion", {
        p_deletion_id: deletionId,
      });
      if (error) throw new JobStoreError("get_storage_object_deletion", error.code);
      const [row] = data;
      if (!row) return null;
      return { objectKey: row.object_key, done: row.done };
    },

    async completeStorageObjectDeletion(deletionId) {
      const { data, error } = await client.rpc("complete_storage_object_deletion", {
        p_deletion_id: deletionId,
      });
      if (error) throw new JobStoreError("complete_storage_object_deletion", error.code);
      return data;
    },
  };
}
