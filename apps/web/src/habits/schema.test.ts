import {
  addContributionSchema,
  changeTrackingSchema,
  completeSchema,
  createHabitSchema,
  dayNoteSchema,
  quantitySchema,
  quickAddsSchema,
  reactivateSchema,
  remindersSchema,
  settingsSchema,
  snoozeSchema,
  updateContributionSchema,
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

describe("numeric habit schemas (S29)", () => {
  const base = {
    id: ID,
    homeId: null,
    name: "Water",
    startsOn: "2026-11-10",
    weekStart: "monday",
    schedule: { kind: "daily" },
  };
  const tracking = { target: "2000", unit: "ml", unitKind: "preset", quickAdds: ["250", "500"] };

  it("reads a quantity as a decimal string with at most three decimals", () => {
    expect(quantitySchema.parse("1500")).toBe(1500);
    expect(quantitySchema.parse("0.1")).toBe(0.1);
    expect(quantitySchema.parse("1.125")).toBe(1.125);
    // A number is accepted when it is already exact in three decimals, so a parsed body can be resent.
    expect(quantitySchema.parse(1.5)).toBe(1.5);
    for (const bad of [
      "1,5",
      "1.5555",
      "1e3",
      "-1",
      "+1",
      " 1",
      "1.",
      ".5",
      "",
      "12345678",
      "abc",
    ]) {
      expect(quantitySchema.safeParse(bad).success, bad).toBe(false);
    }
    for (const bad of [0.1 + 0.2, -1, Number.NaN, Infinity, 1_000_001]) {
      expect(quantitySchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it("creates a numeric habit with a valid tracking, and none by default", () => {
    expect(createHabitSchema.parse(base).tracking).toBeNull();
    const parsed = createHabitSchema.parse({ ...base, tracking });
    expect(parsed.tracking).toEqual({
      target: 2000,
      unit: "ml",
      unitKind: "preset",
      quickAdds: [250, 500],
    });
    // The parsed body can be sent again (the form posts what it parsed).
    expect(createHabitSchema.safeParse({ ...base, tracking: parsed.tracking }).success).toBe(true);
  });

  it("refuses a numeric target on a weekly schedule, a fraction of a whole unit and bad presets", () => {
    const weekly = { ...base, schedule: { kind: "weekly", target: 3 } };
    expect(createHabitSchema.safeParse({ ...weekly, tracking }).success).toBe(false);
    expect(createHabitSchema.safeParse({ ...weekly, tracking: null }).success).toBe(true);
    const glasses = { ...tracking, unit: "glasses", quickAdds: [] };
    expect(
      createHabitSchema.safeParse({ ...base, tracking: { ...glasses, target: "8" } }).success,
    ).toBe(true);
    expect(
      createHabitSchema.safeParse({ ...base, tracking: { ...glasses, target: "7.5" } }).success,
    ).toBe(false);
    for (const bad of [
      { ...tracking, quickAdds: ["250", "250"] },
      { ...tracking, quickAdds: ["1", "2", "3", "4", "5", "6"] },
      { ...tracking, unit: "stone" },
      { ...tracking, unit: "", unitKind: "custom" },
      { ...tracking, unit: "x".repeat(21), unitKind: "custom" },
      { ...tracking, target: "0" },
    ]) {
      expect(createHabitSchema.safeParse({ ...base, tracking: bad }).success).toBe(false);
    }
    expect(
      createHabitSchema.safeParse({
        ...base,
        tracking: { ...tracking, unit: "cups of tea", unitKind: "custom", quickAdds: ["1"] },
      }).success,
    ).toBe(true);
  });

  it("changes tracking from a day, and a chosen date needs its date", () => {
    const base = { revision: 3, tracking, when: "next" };
    expect(changeTrackingSchema.parse(base)).toMatchObject({
      when: "next",
      effectiveOn: null,
      expectedTotal: null,
      confirmStatus: false,
      confirmUnit: false,
      preview: false,
    });
    expect(changeTrackingSchema.safeParse({ ...base, when: "date" }).success).toBe(false);
    expect(
      changeTrackingSchema.safeParse({ ...base, when: "date", effectiveOn: "2026-11-12" }).success,
    ).toBe(true);
    expect(changeTrackingSchema.safeParse({ ...base, tracking: null }).success).toBe(true);
    expect(changeTrackingSchema.safeParse({ ...base, when: "yesterday" }).success).toBe(false);
  });

  it("adds a contribution with a client id, and corrects only with a quantity", () => {
    expect(addContributionSchema.parse({ id: ID, quantity: "250" })).toEqual({
      id: ID,
      quantity: 250,
      onDate: null,
      enteredUnit: null,
      source: "app",
      revision: null,
    });
    expect(addContributionSchema.safeParse({ id: ID, quantity: "-250" }).success).toBe(false);
    expect(addContributionSchema.safeParse({ quantity: "250" }).success).toBe(false);
    expect(updateContributionSchema.safeParse({ action: "undo" }).success).toBe(true);
    expect(updateContributionSchema.safeParse({ action: "amend" }).success).toBe(false);
    expect(updateContributionSchema.safeParse({ action: "amend", quantity: "300" }).success).toBe(
      true,
    );
    expect(updateContributionSchema.safeParse({ action: "delete" }).success).toBe(false);
  });

  it("limits the quick-add presets and a day note", () => {
    expect(quickAddsSchema.safeParse({ revision: 1, quickAdds: [] }).success).toBe(true);
    expect(
      quickAddsSchema.safeParse({ revision: 1, quickAdds: ["1", "2", "3", "4", "5", "6"] }).success,
    ).toBe(false);
    expect(dayNoteSchema.parse({ revision: 0, note: "  " }).note).toBeNull();
    expect(dayNoteSchema.safeParse({ revision: 0, note: "x".repeat(281) }).success).toBe(false);
  });
});
