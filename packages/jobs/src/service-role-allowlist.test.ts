// S15-M3 / owner decision 3 (review M-5): the background jobs hold the service-role key too, so their
// reach is an explicit allowlist checked here, like apps/web's (apps/web/src/auth/service-role.test.ts,
// which also scans the whole repository for the key). Adding a function to a job means adding it here,
// in review.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** Every database function the jobs call with the service-role key: service_role-only functions. */
const JOB_SERVICE_ROLE_RPCS = [
  "advance_all_pet_care",
  "advance_habit_reminders",
  "advance_reminder_series",
  "begin_data_export",
  "begin_home_copy_files",
  "begin_job_execution",
  "claim_job_outbox",
  "collect_data_export",
  "complete_job_outbox",
  "complete_storage_object_deletion",
  "deliver_account_recovery_ready",
  "deliver_calendar_reminder",
  "deliver_chore_reminder",
  "deliver_goal_reminder",
  "deliver_habit_pause_end",
  "deliver_habit_reminder",
  "deliver_habit_snooze",
  "deliver_pet_care_reminder",
  "deliver_recovery_ready",
  "deliver_task_reminder",
  "deliver_vacation_reminder",
  "expire_upload",
  "fail_data_export",
  "fail_job_outbox",
  "finish_data_export",
  "finish_home_copy_files",
  "finish_job_execution",
  "get_invitation_email",
  "get_notification_email",
  "get_security_email",
  "get_storage_object_deletion",
  "google_push_changes",
  "google_push_result",
  "google_sync_apply_events",
  "google_sync_begin",
  "google_sync_calendars",
  "google_sync_finish",
  "google_sync_finish_calendar",
  "job_batch_failures",
  "job_outbox_stats",
  "process_sign_in_events",
  "purge_account_activity",
  "purge_due_deletions",
  "purge_expired_trash_entry",
  "purge_stored_file",
  "queue_google_calendar_syncs",
  "record_invitation_email",
  "record_notification_email",
  "record_security_email",
  "release_job_outbox",
  "release_overdue_chore_claim",
  "roll_goal_periods",
  "send_chore_summaries",
  "send_inactivity_reminders",
  "sweep_data_exports",
  "sweep_home_copies",
] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) && !/\.test\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));
const where = (test: (text: string) => boolean) =>
  files
    .filter((file) => test(file.text))
    .map((file) => file.path)
    .sort();

describe("the jobs' service-role allowlist (S15-M3)", () => {
  it("reads the secret key only in the Trigger.dev environment and the task entry point", () => {
    expect(where((text) => text.includes("SUPABASE_SERVICE_ROLE_KEY"))).toEqual([
      "trigger/env.ts",
      "trigger/tasks.ts",
    ]);
  });

  it("creates a Supabase client only for the deployed and the local runner", () => {
    expect(
      where((text) => /from "@supabase\/supabase-js"/.test(text) && /\bcreateClient\b/.test(text)),
    ).toEqual(["local.ts", "trigger/tasks.ts"]);
  });

  it("calls only listed functions, each by its literal name, and lists nothing unused", () => {
    const allowed = new Set<string>(JOB_SERVICE_ROLE_RPCS);
    const called = new Set<string>();
    for (const file of files) {
      // A call whose name is not a string literal could reach anything: none is allowed.
      expect(file.text, file.path).not.toMatch(/\.rpc\(\s*[^\s")]/);
      for (const match of file.text.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)) {
        const name = match[1] ?? "";
        expect(allowed.has(name), `${file.path}: ${name}`).toBe(true);
        called.add(name);
      }
    }
    expect([...called].sort()).toEqual([...JOB_SERVICE_ROLE_RPCS].sort());
  });
});
