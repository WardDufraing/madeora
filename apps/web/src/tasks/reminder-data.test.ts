import { describe, expect, it } from "vitest";

import { reminderViewSchema } from "./reminder-data";

// The shapes `get_task_reminder` answers for each status (tests/db/rls/task-reminders.test.sql checks the
// key lists on the database side). A status the schema refuses would make the task page unusable (S19b B1).

const TASK = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";

const reminderKeys = [
  "daysBefore",
  "dst",
  "fireAt",
  "localAt",
  "mode",
  "own",
  "reviewDst",
  "reviewFireAt",
  "revision",
  "status",
  "time",
  "timeZone",
];

function view(reminder: Record<string, unknown> | null, extra: Record<string, unknown> = {}) {
  return {
    taskId: TASK,
    dueDate: "2026-11-20",
    completed: false,
    recurring: false,
    canEdit: true,
    canEditSeries: false,
    timeZone: "Europe/Brussels",
    reminder,
    seriesReminder: null,
    recipients: null,
    recipientsAreAssignees: false,
    channels: { inApp: true, email: false },
    ...extra,
  };
}

const base = {
  mode: "relative",
  localAt: null,
  daysBefore: 1,
  time: "09:00",
  timeZone: "Europe/Brussels",
  fireAt: "2026-11-19T08:00:00+00:00",
  dst: null,
  own: true,
  revision: 2,
  reviewFireAt: null,
  reviewDst: null,
};

describe("reminderViewSchema against the database answers", () => {
  it.each([
    ["scheduled", { ...base, status: "scheduled" }],
    ["sent", { ...base, status: "sent" }],
    ["not_sent", { ...base, status: "not_sent" }],
    [
      "needs_review",
      {
        ...base,
        status: "needs_review",
        fireAt: null,
        reviewFireAt: "2026-11-22T08:00:00+00:00",
        reviewDst: "gap",
      },
    ],
    [
      "off",
      {
        ...base,
        status: "off",
        mode: null,
        localAt: null,
        daysBefore: null,
        time: null,
        timeZone: null,
        fireAt: null,
      },
    ],
  ])("parses a %s reminder", (_status, reminder) => {
    expect(Object.keys(reminder).sort()).toEqual(reminderKeys);
    expect(reminderViewSchema.safeParse(view(reminder)).success).toBe(true);
  });

  it("parses a task with no reminder and a series reminder", () => {
    const parsed = reminderViewSchema.safeParse(
      view(null, {
        recurring: true,
        seriesReminder: { active: true, daysBefore: 0, time: "23:30", revision: 3 },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses an unknown status and a missing key", () => {
    expect(reminderViewSchema.safeParse(view({ ...base, status: "paused" })).success).toBe(false);
    const { fireAt: _omitted, ...withoutFireAt } = { ...base, status: "sent" };
    expect(reminderViewSchema.safeParse(view(withoutFireAt)).success).toBe(false);
  });
});
