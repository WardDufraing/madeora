import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isNotificationKind, notificationKinds, notificationPath } from "./index.ts";

const homeId = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

describe("notificationPath", () => {
  it("opens the recovery page for the person who asked and the Home for the rest", () => {
    expect(notificationPath("recovery.claimant_ready", homeId)).toBe(`/homes/${homeId}/recovery`);
    expect(notificationPath("recovery.claimant_rejected", homeId)).toBe(`/homes/${homeId}`);
    expect(notificationPath("recovery.owner_approved", homeId)).toBe(`/homes/${homeId}`);
    expect(notificationPath("recovery.member_requested", homeId)).toBe(`/homes/${homeId}`);
    expect(notificationPath("join_request.received", homeId)).toBe(`/homes/${homeId}/invitations`);
  });

  it("falls back to the dashboard or the recoveries page when there is no Home", () => {
    expect(notificationPath("recovery.claimant_ready", null)).toBe("/");
    expect(notificationPath("recovery.former_owner_completed_removed", null)).toBe(
      "/settings/recoveries",
    );
    expect(notificationPath("recovery.former_owner_completed", homeId)).toBe(
      "/settings/recoveries",
    );
    expect(notificationPath("join_request.decided", null)).toBe("/");
  });

  it("leads a reminder to its task, in its Home or the personal space", () => {
    const taskId = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";
    expect(notificationPath("task.reminder", "h1", { taskId })).toBe(`/homes/h1/tasks/${taskId}`);
    expect(notificationPath("task.reminder", null, { taskId })).toBe(`/tasks/${taskId}`);
    expect(notificationPath("task.reminder", null, { taskId: 7 })).toBe("/tasks");
  });

  it("encodes the Home id", () => {
    expect(notificationPath("recovery.member_ended", "a/b")).toBe("/homes/a%2Fb");
  });
});

describe("notificationKinds", () => {
  it("recognises exactly its kinds", () => {
    expect(isNotificationKind("join_request.received")).toBe(true);
    expect(isNotificationKind("chores.assigned")).toBe(false);
    expect(isNotificationKind(7)).toBe(false);
  });

  it("lists every kind the database writes, and no other", () => {
    const migrations = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../supabase/migrations",
    );
    const sql = readdirSync(migrations)
      .filter(
        (name) =>
          name.endsWith("_notifications.sql") ||
          name.endsWith("_file_storage.sql") ||
          name.endsWith("_task_reminders_templates_bulk.sql"),
      )
      .map((name) => readFileSync(join(migrations, name), "utf8"))
      .join("\n");
    // Task kinds share their prefix with audit actions, so only those written with the reminders
    // category count.
    const written = new Set([
      ...[...sql.matchAll(/'((?:recovery|join_request|storage)\.[a-z_]+)'/g)].map((m) => m[1]),
      ...[...sql.matchAll(/'reminders', '(task\.[a-z_]+)'/g)].map((m) => m[1]),
    ]);
    expect([...written].sort()).toEqual([...notificationKinds].sort());
  });
});
