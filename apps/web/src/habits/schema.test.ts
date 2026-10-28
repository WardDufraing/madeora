import {
  completeSchema,
  createHabitSchema,
  reactivateSchema,
  remindersSchema,
  settingsSchema,
  snoozeSchema,
  updatePauseSchema,
} from "./schema";

const ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0080";

describe("habit request schemas", () => {
  it("accepts each schedule kind only with its own fields", () => {
    const base = {
      id: ID,
      homeId: null,
      name: "Walk",
      startsOn: "2026-11-10",
      weekStart: "monday",
    };
    const ok = [
      { kind: "daily" },
      { kind: "weekdays", weekdays: [1, 7] },
      { kind: "weekly", target: 3 },
    ];
    for (const schedule of ok) {
      expect(createHabitSchema.safeParse({ ...base, schedule }).success).toBe(true);
    }
    const bad = [
      { kind: "weekdays" },
      { kind: "weekdays", weekdays: [0] },
      { kind: "weekly", target: 0 },
      { kind: "daily", weekdays: [1] },
      { kind: "monthly" },
    ];
    for (const schedule of bad) {
      expect(createHabitSchema.safeParse({ ...base, schedule }).success).toBe(false);
    }
    expect(createHabitSchema.safeParse({ ...base, name: "   ", schedule: ok[0] }).success).toBe(
      false,
    );
  });

  it("treats an empty note as none and limits it", () => {
    expect(completeSchema.parse({ id: ID, note: "  " })).toEqual({
      id: ID,
      onDate: null,
      note: null,
      source: "app",
    });
    expect(completeSchema.safeParse({ id: ID, note: "x".repeat(281) }).success).toBe(false);
    expect(completeSchema.safeParse({ id: ID, onDate: "2026-13-01" }).success).toBe(false);
  });

  it("needs times and weekdays for a reminder that is on, at most three times", () => {
    expect(remindersSchema.safeParse({ expectedRevision: 0, enabled: false }).success).toBe(true);
    expect(remindersSchema.safeParse({ expectedRevision: 0, enabled: true }).success).toBe(false);
    expect(
      remindersSchema.safeParse({
        expectedRevision: 1,
        enabled: true,
        times: ["07:00", "12:00", "18:00", "21:00"],
        weekdays: [1],
      }).success,
    ).toBe(false);
    expect(
      remindersSchema.safeParse({
        expectedRevision: 1,
        enabled: true,
        times: ["07:00"],
        weekdays: [1, 2, 3],
      }).success,
    ).toBe(true);
  });

  it("needs a new reminder only when reactivating with a changed one", () => {
    const base = {
      revision: 2,
      startsOn: "2026-11-10",
      schedule: { kind: "daily" },
    };
    expect(reactivateSchema.safeParse({ ...base, reminder: { mode: "keep" } }).success).toBe(true);
    expect(reactivateSchema.safeParse({ ...base, reminder: { mode: "change" } }).success).toBe(
      false,
    );
  });

  it("needs a resume day to change a pause, not to resume it", () => {
    expect(updatePauseSchema.safeParse({ revision: 1, action: "resume" }).success).toBe(true);
    expect(updatePauseSchema.safeParse({ revision: 1, action: "change" }).success).toBe(false);
  });

  it("snoozes only by 15, 30 or 60 minutes", () => {
    expect([15, 30, 60, 45].map((minutes) => snoozeSchema.safeParse({ minutes }).success)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("sets either member access or celebrations, never both", () => {
    expect(settingsSchema.safeParse({ celebrations: true }).success).toBe(true);
    expect(settingsSchema.safeParse({ homeId: ID, memberAccess: "complete" }).success).toBe(true);
    expect(
      settingsSchema.safeParse({ homeId: ID, memberAccess: "view", celebrations: true }).success,
    ).toBe(false);
  });
});
