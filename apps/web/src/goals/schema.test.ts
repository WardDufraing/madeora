import {
  achievementSchema,
  addEntrySchema,
  changeTargetSchema,
  createGoalSchema,
  createSeriesSchema,
  remindersSchema,
  seriesTargetSchema,
  updateEntrySchema,
  updateSeriesSchema,
} from "./schema";
import { GOAL, SERIES } from "./testing";

const measurable = {
  id: GOAL,
  homeId: null,
  kind: "measurable",
  title: "Read books",
  measure: { target: "12", unit: "books", unitKind: "custom" },
};

describe("the create contract", () => {
  it("takes a measurable goal with a custom unit, an initial value and a deadline", () => {
    const parsed = createGoalSchema.parse({ ...measurable, initial: "2", deadline: "2026-12-31" });
    expect(parsed.measure).toEqual({ target: 12, unit: "books", unitKind: "custom" });
    expect(parsed.initial).toBe(2);
    expect(parsed.renewedFrom).toBeNull();
  });

  it("takes a completion goal without a target", () => {
    expect(
      createGoalSchema.safeParse({ id: GOAL, homeId: null, kind: "completion", title: "Paint" })
        .success,
    ).toBe(true);
  });

  it("refuses a zero, negative, too precise or too large target", () => {
    for (const target of ["0", "-1", "1.2345", "1000000000.001", "1,5"]) {
      expect(
        createGoalSchema.safeParse({ ...measurable, measure: { ...measurable.measure, target } })
          .success,
      ).toBe(false);
    }
  });

  it("takes a target of 1,000,000,000 with three decimals elsewhere", () => {
    for (const target of ["1000000000", "0.001", 999.125]) {
      expect(
        createGoalSchema.safeParse({ ...measurable, measure: { ...measurable.measure, target } })
          .success,
      ).toBe(true);
    }
  });

  it("refuses decimals for a whole-number unit, and a measurable goal without a target", () => {
    expect(
      createGoalSchema.safeParse({
        ...measurable,
        measure: { target: "7.5", unit: "pages", unitKind: "preset" },
      }).success,
    ).toBe(false);
    expect(createGoalSchema.safeParse({ ...measurable, measure: null }).success).toBe(false);
    expect(
      createGoalSchema.safeParse({
        id: GOAL,
        homeId: null,
        kind: "completion",
        title: "x",
        initial: "1",
      }).success,
    ).toBe(false);
  });

  it("refuses an unknown preset unit and an empty or too long title", () => {
    expect(
      createGoalSchema.safeParse({
        ...measurable,
        measure: { target: "1", unit: "parsecs", unitKind: "preset" },
      }).success,
    ).toBe(false);
    expect(createGoalSchema.safeParse({ ...measurable, title: "  " }).success).toBe(false);
    expect(createGoalSchema.safeParse({ ...measurable, title: "x".repeat(81) }).success).toBe(
      false,
    );
  });
});

describe("the progress contract", () => {
  it("adds a positive amount and sets a total of 0 or more with the total seen", () => {
    expect(addEntrySchema.parse({ id: GOAL, quantity: "0.1" }).quantity).toBe(0.1);
    expect(addEntrySchema.safeParse({ id: GOAL, quantity: "0" }).success).toBe(false);
    expect(
      addEntrySchema.safeParse({ id: GOAL, mode: "total", quantity: "0", expectedTotal: "3" })
        .success,
    ).toBe(true);
    expect(addEntrySchema.safeParse({ id: GOAL, mode: "total", quantity: "5" }).success).toBe(
      false,
    );
  });

  it("amends with a quantity (an adjustment may be negative) and reverses without one", () => {
    expect(updateEntrySchema.parse({ action: "amend", quantity: "-2.5" }).quantity).toBe(-2.5);
    expect(updateEntrySchema.safeParse({ action: "amend" }).success).toBe(false);
    expect(updateEntrySchema.safeParse({ action: "reverse", quantity: "1" }).success).toBe(false);
    expect(updateEntrySchema.parse({ action: "reverse", reason: "  " }).reason).toBeNull();
  });
});

describe("the other contracts", () => {
  it("takes a reason only when reopening", () => {
    expect(
      achievementSchema.safeParse({ revision: 1, achieved: false, reason: "Oops" }).success,
    ).toBe(true);
    expect(
      achievementSchema.safeParse({ revision: 1, achieved: true, reason: "Yes" }).success,
    ).toBe(false);
  });

  it("checks reminder ranges and needs one moment when on", () => {
    const base = { expectedRevision: 0, enabled: true, atTime: "09:00" };
    expect(remindersSchema.safeParse({ ...base, leadDays: 3 }).success).toBe(true);
    expect(remindersSchema.safeParse({ ...base, overdueDays: 0 }).success).toBe(true);
    expect(remindersSchema.safeParse(base).success).toBe(false);
    expect(remindersSchema.safeParse({ ...base, leadDays: 91 }).success).toBe(false);
    expect(remindersSchema.safeParse({ ...base, overdueDays: 31 }).success).toBe(false);
    expect(remindersSchema.safeParse({ ...base, leadDays: 1, atTime: "9:00" }).success).toBe(false);
    expect(remindersSchema.safeParse({ expectedRevision: 2, enabled: false }).success).toBe(true);
  });

  it("checks a target change like a new target", () => {
    expect(
      changeTargetSchema.safeParse({ revision: 1, target: "12", unit: "km", unitKind: "preset" })
        .success,
    ).toBe(true);
    expect(
      changeTargetSchema.safeParse({ revision: 1, target: "0", unit: "km", unitKind: "preset" })
        .success,
    ).toBe(false);
  });
});

describe("the recurring series contracts (S30b)", () => {
  const series = {
    ...measurable,
    id: SERIES,
    frequency: "weekly",
    firstPeriod: "2026-11-10",
  };

  it("takes a weekly measurable series with defaults and a reminder", () => {
    const parsed = createSeriesSchema.parse({ ...series, reminder: { leadDays: 2 } });
    expect(parsed).toMatchObject({
      weekStart: "monday",
      endsOn: null,
      timeZone: null,
      preview: false,
      reminder: { leadDays: 2, atTime: "09:00" },
    });
  });

  it("refuses weekly completion series, a missing measure and an end before the first period", () => {
    const completion = { id: SERIES, homeId: null, kind: "completion", title: "Paint" };
    expect(
      createSeriesSchema.safeParse({
        ...completion,
        frequency: "weekly",
        firstPeriod: "2026-11-10",
      }).success,
    ).toBe(false);
    expect(
      createSeriesSchema.safeParse({
        ...completion,
        frequency: "monthly",
        firstPeriod: "2026-11-10",
      }).success,
    ).toBe(true);
    expect(createSeriesSchema.safeParse({ ...series, measure: null }).success).toBe(false);
    expect(createSeriesSchema.safeParse({ ...series, endsOn: "2026-11-09" }).success).toBe(false);
    expect(createSeriesSchema.safeParse({ ...series, firstPeriod: "2026-02-30" }).success).toBe(
      false,
    );
    expect(createSeriesSchema.safeParse({ ...series, weekStart: "friday" }).success).toBe(false);
    expect(createSeriesSchema.safeParse({ ...series, reminder: { leadDays: 91 } }).success).toBe(
      false,
    );
  });

  it("checks edits and target changes", () => {
    expect(updateSeriesSchema.safeParse({ revision: 1, title: "Run" }).success).toBe(true);
    expect(updateSeriesSchema.safeParse({ revision: 1, title: "" }).success).toBe(false);
    const target = {
      revision: 1,
      effectiveFrom: "2026-12-01",
      target: "40",
      unit: "km",
      unitKind: "preset",
    };
    expect(seriesTargetSchema.parse(target)).toMatchObject({
      target: 40,
      confirmUnit: false,
      confirmStatus: false,
      preview: false,
    });
    expect(seriesTargetSchema.safeParse({ ...target, target: "0" }).success).toBe(false);
    expect(seriesTargetSchema.safeParse({ ...target, effectiveFrom: "next" }).success).toBe(false);
  });
});
