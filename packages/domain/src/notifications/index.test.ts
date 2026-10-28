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
    expect(notificationPath("chore.approval_requested", homeId)).toBe(
      `/homes/${homeId}/chores/approvals`,
    );
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

  it("leads a habit notice to its habit, in its Home or the personal space", () => {
    const habitId = "8e3c5fb7-0c6b-4a88-8d6b-5c9d4b3f5702";
    for (const kind of ["habit.reminder", "habit.paused", "habit.resumed"]) {
      expect(notificationPath(kind, "h1", { habitId })).toBe(`/homes/h1/habits/${habitId}`);
    }
    expect(notificationPath("habit.reminder", null, { habitId })).toBe(`/habits/${habitId}`);
    expect(notificationPath("habit.paused", "h1", { habitId: 7 })).toBe("/homes/h1/habits");
  });

  it("leads a claim or reassignment notice to its occurrence, or to the chores page", () => {
    const occurrenceId = "7c1e2a3b-4d5f-4a6b-8c7d-9e0f1a2b3c4d";
    for (const kind of [
      "chore.claim_released",
      "chore.reassignment_requested",
      "chore.reassignment_answered",
      "chore.reassignment_confirmation_needed",
      "chore.reassignment_decided",
      "chore.reassignment_invalidated",
      "chore.volunteer_invited",
      "chore.volunteer_accepted",
      "chore.assignment_corrected",
      "chore.reminder",
    ]) {
      expect(notificationPath(kind, homeId, { occurrenceId })).toBe(
        `/homes/${homeId}/chores/${occurrenceId}`,
      );
      expect(notificationPath(kind, homeId, { occurrenceId: 7 })).toBe(`/homes/${homeId}/chores`);
    }
  });

  it("leads a proposal decision to the proposals page", () => {
    expect(notificationPath("chore.proposal_decided", homeId, { decision: "approved" })).toBe(
      `/homes/${homeId}/chores/proposals`,
    );
  });

  it("leads vacation invitations and proposals to the Vacations page, a reminder to its vacation", () => {
    const vacationId = "3b4c5d6e-7f80-4a1b-9c2d-3e4f5a6b7c8d";
    for (const kind of ["vacation.invited", "vacation.dates_proposed"]) {
      expect(notificationPath(kind, homeId, { vacationId })).toBe(`/homes/${homeId}/vacations`);
    }
    expect(notificationPath("vacation.reminder", homeId, { vacationId })).toBe(
      `/homes/${homeId}/vacations/${vacationId}`,
    );
    expect(notificationPath("vacation.reminder", homeId, { vacationId: 7 })).toBe(
      `/homes/${homeId}/vacations`,
    );
  });

  it("leads points notices to the points page and reward notices to the rewards pages", () => {
    for (const kind of ["points.awarded", "points.reversed", "points.bonus", "points.corrected"]) {
      expect(notificationPath(kind, homeId, { amount: 5 })).toBe(`/homes/${homeId}/points`);
    }
    expect(notificationPath("reward.requested", homeId)).toBe(`/homes/${homeId}/rewards/approvals`);
    for (const kind of ["reward.approved", "reward.refunded", "reward.unable"]) {
      expect(notificationPath(kind, homeId)).toBe(`/homes/${homeId}/rewards`);
    }
  });

  it("leads a manager summary to the live Summary page", () => {
    expect(notificationPath("chore.manager_summary", homeId, { overdueAssigned: 2 })).toBe(
      `/homes/${homeId}/chores/summary`,
    );
  });

  it("encodes the Home id", () => {
    expect(notificationPath("recovery.member_ended", "a/b")).toBe("/homes/a%2Fb");
  });
});

describe("notificationKinds", () => {
  it("recognises exactly its kinds", () => {
    expect(isNotificationKind("join_request.received")).toBe(true);
    expect(isNotificationKind("chores.assigned")).toBe(false);
    expect(isNotificationKind("chore.approval_requested")).toBe(true);
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
          name.endsWith("_task_reminders_templates_bulk.sql") ||
          name.endsWith("_chores.sql") ||
          name.endsWith("_chore_pool_claims.sql") ||
          name.endsWith("_chore_proposals_volunteers.sql") ||
          name.endsWith("_chore_overview_reminders.sql") ||
          name.endsWith("_home_vacations.sql") ||
          name.endsWith("_points_rewards.sql") ||
          name.endsWith("_habits.sql"),
      )
      .map((name) => readFileSync(join(migrations, name), "utf8"))
      .join("\n");
    // Task and chore kinds share their prefix with audit actions, so only those written with a
    // notification category count.
    const written = new Set([
      ...[...sql.matchAll(/'((?:recovery|join_request|storage)\.[a-z_]+)'/g)].map((m) => m[1]),
      ...[...sql.matchAll(/'reminders', '((?:task|chore|habit)\.[a-z_]+)'/g)].map((m) => m[1]),
      ...[...sql.matchAll(/'approvals', '(chore\.[a-z_]+)'/g)].map((m) => m[1]),
      ...[...sql.matchAll(/'chores', '(chore\.[a-z_]+)'/g)].map((m) => m[1]),
      ...[...sql.matchAll(/'(?:chores|reminders)', '(vacation\.[a-z_]+)'/g)].map((m) => m[1]),
      // S23 audit actions use other prefixes (rewards., point_entry.), so these are all notices.
      ...[...sql.matchAll(/'((?:points|reward)\.[a-z_]+)'/g)].map((m) => m[1]),
      // S28 habit audit actions share the prefix; pause notices go through habit_notify_pause.
      ...[...sql.matchAll(/habit_notify_pause\(v_habit, '(habit\.[a-z_]+)'/g)].map((m) => m[1]),
    ]);
    expect([...written].sort()).toEqual([...notificationKinds].sort());
  });
});
