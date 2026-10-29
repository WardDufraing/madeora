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

const trashStatuses = ["trashed", "restored", "purged", "missing"] as const;

const claimReleaseOutcomes = ["released", "stale", "missing"] as const;

const reminderOutcomes = ["notified", "not_sent", "stale", "not_due"] as const;
const habitReminderOutcomes = [
  "notified",
  "not_needed",
  "late",
  "inactive",
  "stale",
  "not_due",
] as const;
const habitSnoozeOutcomes = ["notified", "cancelled", "stale", "not_due"] as const;
const habitPauseEndOutcomes = ["notified", "still_paused", "stale", "not_due"] as const;
const goalReminderOutcomes = ["notified", "late", "inactive", "stale", "not_due"] as const;

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

    async deliverTaskReminder(taskId, revision) {
      const { data, error } = await client.rpc("deliver_task_reminder", {
        p_task_id: taskId,
        p_revision: revision,
      });
      if (error) throw new JobStoreError("deliver_task_reminder", error.code);
      const outcome = oneOf(reminderOutcomes, data);
      if (!outcome) throw new JobStoreError("deliver_task_reminder", "unexpected_result");
      return outcome;
    },

    async advanceReminderSeries(limit) {
      const { data, error } = await client.rpc("advance_reminder_series", { p_limit: limit });
      if (error) throw new JobStoreError("advance_reminder_series", error.code);
      return data;
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

    async purgeExpiredTrashEntry(entryId) {
      const { data, error } = await client.rpc("purge_expired_trash_entry", {
        p_entry_id: entryId,
      });
      if (error) throw new JobStoreError("purge_expired_trash_entry", error.code);
      const status = oneOf(trashStatuses, data);
      if (!status) throw new JobStoreError("purge_expired_trash_entry", "unexpected_result");
      return status;
    },

    async releaseOverdueChoreClaim(occurrenceId, claim) {
      const { data, error } = await client.rpc("release_overdue_chore_claim", {
        p_occurrence_id: occurrenceId,
        p_claim: claim,
      });
      if (error) throw new JobStoreError("release_overdue_chore_claim", error.code);
      const outcome = oneOf(claimReleaseOutcomes, data);
      if (!outcome) throw new JobStoreError("release_overdue_chore_claim", "unexpected_result");
      return outcome;
    },

    async deliverChoreReminder(occurrenceId, userId, revision) {
      const { data, error } = await client.rpc("deliver_chore_reminder", {
        p_occurrence_id: occurrenceId,
        p_user_id: userId,
        p_revision: revision,
      });
      if (error) throw new JobStoreError("deliver_chore_reminder", error.code);
      const outcome = oneOf(reminderOutcomes, data);
      if (!outcome) throw new JobStoreError("deliver_chore_reminder", "unexpected_result");
      return outcome;
    },

    async deliverVacationReminder(vacationId, startsOn, days) {
      const { data, error } = await client.rpc("deliver_vacation_reminder", {
        p_vacation_id: vacationId,
        p_starts_on: startsOn,
        p_days: days,
      });
      if (error) throw new JobStoreError("deliver_vacation_reminder", error.code);
      const outcome = oneOf(reminderOutcomes, data);
      if (!outcome) throw new JobStoreError("deliver_vacation_reminder", "unexpected_result");
      return outcome;
    },

    async sendChoreSummaries(limit) {
      const { data, error } = await client.rpc("send_chore_summaries", { p_limit: limit });
      if (error) throw new JobStoreError("send_chore_summaries", error.code);
      return data;
    },

    async deliverHabitReminder(habitId, revision, at) {
      const { data, error } = await client.rpc("deliver_habit_reminder", {
        p_habit_id: habitId,
        p_revision: revision,
        p_at: at,
      });
      if (error) throw new JobStoreError("deliver_habit_reminder", error.code);
      const outcome = oneOf(habitReminderOutcomes, data);
      if (!outcome) throw new JobStoreError("deliver_habit_reminder", "unexpected_result");
      return outcome;
    },

    async advanceHabitReminders(limit) {
      const { data, error } = await client.rpc("advance_habit_reminders", { p_limit: limit });
      if (error) throw new JobStoreError("advance_habit_reminders", error.code);
      return data;
    },

    async deliverHabitSnooze(notificationId) {
      const { data, error } = await client.rpc("deliver_habit_snooze", {
        p_notification_id: notificationId,
      });
      if (error) throw new JobStoreError("deliver_habit_snooze", error.code);
      const outcome = oneOf(habitSnoozeOutcomes, data);
      if (!outcome) throw new JobStoreError("deliver_habit_snooze", "unexpected_result");
      return outcome;
    },

    async deliverHabitPauseEnd(pauseId, resumesOn) {
      const { data, error } = await client.rpc("deliver_habit_pause_end", {
        p_pause_id: pauseId,
        p_resumes_on: resumesOn,
      });
      if (error) throw new JobStoreError("deliver_habit_pause_end", error.code);
      const outcome = oneOf(habitPauseEndOutcomes, data);
      if (!outcome) throw new JobStoreError("deliver_habit_pause_end", "unexpected_result");
      return outcome;
    },

    async rollGoalPeriods(limit) {
      const { data, error } = await client.rpc("roll_goal_periods", { p_limit: limit });
      if (error) throw new JobStoreError("roll_goal_periods", error.code);
      return data;
    },

    async deliverGoalReminder(goalId, revision, kind, at) {
      const { data, error } = await client.rpc("deliver_goal_reminder", {
        p_goal_id: goalId,
        p_revision: revision,
        p_kind: kind,
        p_at: at,
      });
      if (error) throw new JobStoreError("deliver_goal_reminder", error.code);
      const outcome = oneOf(goalReminderOutcomes, data);
      if (!outcome) throw new JobStoreError("deliver_goal_reminder", "unexpected_result");
      return outcome;
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
