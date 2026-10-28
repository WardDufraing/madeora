import { describe, expect, it } from "vitest";

import {
  earliestHabitChange,
  habitMonthGrid,
  habitWeekdayOrder,
  habitWeekOf,
  isValidHabitReminder,
  isValidHabitSchedule,
} from "./index";

describe("habit schedules", () => {
  it("accepts the three schedule kinds and nothing in between", () => {
    expect(isValidHabitSchedule({ kind: "daily", weekdays: null, target: null })).toBe(true);
    expect(isValidHabitSchedule({ kind: "weekdays", weekdays: [1, 3, 5], target: null })).toBe(
      true,
    );
    expect(isValidHabitSchedule({ kind: "weekly", weekdays: null, target: 3 })).toBe(true);
    expect(isValidHabitSchedule({ kind: "daily", weekdays: [1], target: null })).toBe(false);
    expect(isValidHabitSchedule({ kind: "weekdays", weekdays: [], target: null })).toBe(false);
    expect(isValidHabitSchedule({ kind: "weekdays", weekdays: [1, 1], target: null })).toBe(false);
    expect(isValidHabitSchedule({ kind: "weekdays", weekdays: [0], target: null })).toBe(false);
    expect(isValidHabitSchedule({ kind: "weekly", weekdays: null, target: 0 })).toBe(false);
    expect(isValidHabitSchedule({ kind: "weekly", weekdays: null, target: 8 })).toBe(false);
    expect(isValidHabitSchedule({ kind: "weekly", weekdays: null, target: 2.5 })).toBe(false);
  });

  it("checks reminder times and weekdays", () => {
    expect(isValidHabitReminder(["07:30", "21:00"], [1, 2, 3, 4, 5])).toBe(true);
    expect(isValidHabitReminder([], [1])).toBe(false);
    expect(isValidHabitReminder(["07:30", "07:30"], [1])).toBe(false);
    expect(isValidHabitReminder(["24:00"], [1])).toBe(false);
    expect(isValidHabitReminder(["07:00", "08:00", "09:00", "10:00"], [1])).toBe(false);
    expect(isValidHabitReminder(["07:00"], [])).toBe(false);
  });
});

describe("habit weeks", () => {
  it("finds the week start for every preference", () => {
    // 2026-10-28 is a Wednesday.
    expect(habitWeekOf("2026-10-28", "monday")).toBe("2026-10-26");
    expect(habitWeekOf("2026-10-28", "sunday")).toBe("2026-10-25");
    expect(habitWeekOf("2026-10-28", "saturday")).toBe("2026-10-24");
    expect(habitWeekOf("2026-10-24", "saturday")).toBe("2026-10-24");
  });

  it("allows schedule changes from tomorrow, or the next week when weekly is involved", () => {
    expect(earliestHabitChange("2026-10-28", "monday", "daily", "weekdays")).toBe("2026-10-29");
    expect(earliestHabitChange("2026-10-28", "monday", "daily", "weekly")).toBe("2026-11-02");
    expect(earliestHabitChange("2026-10-28", "sunday", "weekly", "daily")).toBe("2026-11-01");
    // Across a month and a year boundary.
    expect(earliestHabitChange("2026-12-31", "monday", "weekdays", "daily")).toBe("2027-01-01");
  });

  it("orders weekdays from the week start", () => {
    expect(habitWeekdayOrder("monday")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(habitWeekdayOrder("sunday")).toEqual([7, 1, 2, 3, 4, 5, 6]);
    expect(habitWeekdayOrder("saturday")).toEqual([6, 7, 1, 2, 3, 4, 5]);
  });

  it("lays out a month in whole weeks with the other months' days left empty", () => {
    const weeks = habitMonthGrid("2026-02", "monday");
    expect(weeks).toHaveLength(5);
    expect(weeks[0]?.[6]).toBe("2026-02-01");
    expect(weeks[0]?.[0]).toBeNull();
    const leap = habitMonthGrid("2028-02", "sunday")
      .flat()
      .filter((day) => day !== null);
    expect(leap).toHaveLength(29);
    expect(leap.at(-1)).toBe("2028-02-29");
  });
});
