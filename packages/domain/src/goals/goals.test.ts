import { describe, expect, it } from "vitest";

import {
  GOAL_LIMITS,
  goalPeriodStart,
  goalProgress,
  goalStatus,
  isGoalFrequencyAllowed,
  nextGoalPeriodStart,
  isValidGoalReminder,
  isValidGoalThousandths,
  parseGoalQuantity,
} from "./index";

const km = { unit: "km", kind: "preset" } as const;
const pages = { unit: "pages", kind: "preset" } as const;
const euro = { unit: "€", kind: "custom" } as const;

describe("parseGoalQuantity", () => {
  it("reads decimals in Dutch and English", () => {
    expect(parseGoalQuantity("1,5", "nl", km)).toEqual({ ok: true, thousandths: 1500 });
    expect(parseGoalQuantity("1.5", "en", km)).toEqual({ ok: true, thousandths: 1500 });
    expect(parseGoalQuantity("1.5", "nl", km)).toEqual({ ok: false, problem: "separator" });
    expect(parseGoalQuantity("1,5", "en", km)).toEqual({ ok: false, problem: "separator" });
  });

  it("allows goal-sized amounts up to a billion, not beyond", () => {
    expect(parseGoalQuantity("2000000", "en", euro)).toEqual({ ok: true, thousandths: 2e9 });
    expect(parseGoalQuantity("1000000000", "en", euro)).toEqual({ ok: true, thousandths: 1e12 });
    expect(parseGoalQuantity("1000000000.001", "en", euro)).toEqual({
      ok: false,
      problem: "range",
    });
    expect(parseGoalQuantity("99999999999", "en", euro)).toEqual({ ok: false, problem: "range" });
  });

  it("refuses 0 unless asked for an initial value or a total", () => {
    expect(parseGoalQuantity("0", "en", km)).toEqual({ ok: false, problem: "not-positive" });
    expect(parseGoalQuantity("0", "en", km, { zero: true })).toEqual({ ok: true, thousandths: 0 });
  });

  it("keeps discrete units whole and refuses a fourth decimal", () => {
    expect(parseGoalQuantity("2,5", "nl", pages)).toEqual({ ok: false, problem: "whole" });
    expect(parseGoalQuantity("0.0001", "en", km)).toEqual({ ok: false, problem: "precision" });
  });
});

describe("goalStatus", () => {
  const base = { archivedAt: null, achievedAt: null, deadline: null };
  it("is active without a deadline, overdue only after it", () => {
    expect(goalStatus(base, "2026-10-29")).toBe("active");
    expect(goalStatus({ ...base, deadline: "2026-10-29" }, "2026-10-29")).toBe("active");
    expect(goalStatus({ ...base, deadline: "2026-10-28" }, "2026-10-29")).toBe("overdue");
  });
  it("puts archived before achieved before overdue", () => {
    expect(goalStatus({ ...base, deadline: "2026-01-01", achievedAt: "x" }, "2026-10-29")).toBe(
      "achieved",
    );
    expect(goalStatus({ ...base, achievedAt: "x", archivedAt: "y" }, "2026-10-29")).toBe(
      "archived",
    );
  });
});

describe("goalProgress", () => {
  it("never caps the numbers, only the bar", () => {
    expect(goalProgress(125_000, 100_000)).toEqual({
      total: 125_000,
      target: 100_000,
      percent: 125,
      fraction: 1,
      reached: true,
      overTarget: 25_000,
    });
  });
  it("adds decimals exactly and floors the percentage", () => {
    const progress = goalProgress(100 + 200, 1000);
    expect(progress.total).toBe(300);
    expect(progress.percent).toBe(30);
    expect(goalProgress(999, 1000).percent).toBe(99);
    expect(goalProgress(999, 1000).reached).toBe(false);
  });
});

describe("validation", () => {
  it("checks thousandths like the database", () => {
    expect(isValidGoalThousandths(1, km)).toBe(true);
    expect(isValidGoalThousandths(0, km)).toBe(false);
    expect(isValidGoalThousandths(0, km, { zero: true })).toBe(true);
    expect(isValidGoalThousandths(1500, pages)).toBe(false);
    expect(isValidGoalThousandths(GOAL_LIMITS.max * 1000 + 1, euro)).toBe(false);
  });
  it("checks reminder settings", () => {
    expect(isValidGoalReminder({ leadDays: 3, overdueDays: null, atTime: "09:00" })).toBe(true);
    expect(isValidGoalReminder({ leadDays: null, overdueDays: 0, atTime: "18:30" })).toBe(true);
    expect(isValidGoalReminder({ leadDays: null, overdueDays: null, atTime: "09:00" })).toBe(false);
    expect(isValidGoalReminder({ leadDays: 91, overdueDays: null, atTime: "09:00" })).toBe(false);
    expect(isValidGoalReminder({ leadDays: 1, overdueDays: 31, atTime: "09:00" })).toBe(false);
    expect(isValidGoalReminder({ leadDays: 1, overdueDays: null, atTime: "24:00" })).toBe(false);
  });
});

describe("recurring goals", () => {
  it("shows an ended period as ended, never overdue", () => {
    const period = {
      archivedAt: null,
      achievedAt: null,
      deadline: "2026-10-31",
      periodEnd: "2026-10-31",
    };
    expect(goalStatus(period, "2026-10-31")).toBe("active");
    expect(goalStatus(period, "2026-11-01")).toBe("ended");
    expect(goalStatus({ ...period, achievedAt: "2026-10-30T10:00:00Z" }, "2026-11-01")).toBe(
      "achieved",
    );
  });

  it("lets completion goals repeat monthly or yearly, measurable goals also weekly", () => {
    expect(isGoalFrequencyAllowed("measurable", "weekly")).toBe(true);
    expect(isGoalFrequencyAllowed("completion", "weekly")).toBe(false);
    expect(isGoalFrequencyAllowed("completion", "monthly")).toBe(true);
    expect(isGoalFrequencyAllowed("completion", "yearly")).toBe(true);
  });
});

describe("goalPeriodStart", () => {
  it("finds the week by its week start, across New Year", () => {
    expect(goalPeriodStart("weekly", "monday", "2027-01-01")).toBe("2026-12-28");
    expect(goalPeriodStart("weekly", "sunday", "2027-01-01")).toBe("2026-12-27");
    expect(goalPeriodStart("weekly", "saturday", "2027-01-01")).toBe("2026-12-26");
    expect(goalPeriodStart("weekly", "monday", "2026-12-28")).toBe("2026-12-28");
  });

  it("finds the calendar month and year", () => {
    expect(goalPeriodStart("monthly", "monday", "2028-02-29")).toBe("2028-02-01");
    expect(goalPeriodStart("yearly", "monday", "2028-02-29")).toBe("2028-01-01");
  });

  it("steps to the next period", () => {
    expect(nextGoalPeriodStart("weekly", "2026-12-28")).toBe("2027-01-04");
    expect(nextGoalPeriodStart("monthly", "2026-12-01")).toBe("2027-01-01");
    expect(nextGoalPeriodStart("monthly", "2028-01-01")).toBe("2028-02-01");
    expect(nextGoalPeriodStart("yearly", "2026-01-01")).toBe("2027-01-01");
  });
});
