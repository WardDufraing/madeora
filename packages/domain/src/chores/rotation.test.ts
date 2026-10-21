import { describe, expect, it } from "vitest";

import { addDays, firstOnOrAfter, type RecurrencePattern } from "../tasks/recurrence";
import { rotationAssignments, rotationTurn } from "./rotation";
import vectors from "./rotation-vectors.json" with { type: "json" };

/** The turn counted day by day: the reference the fast version must match. */
function bruteTurn(pattern: RecurrencePattern, rotationFrom: string, date: string): number {
  let turn = 0;
  for (let day = rotationFrom; day < date; day = addDays(day, 1)) {
    if (firstOnOrAfter(pattern, day) === day) turn += 1;
  }
  return turn;
}

const weekly: RecurrencePattern = {
  frequency: "weekly",
  interval: 1,
  weekdays: [1],
  startsOn: "2026-10-19",
};

describe("rotationTurn", () => {
  it("answers every shared vector (the database test runs the same file)", () => {
    for (const vector of vectors) {
      const pattern = vector.pattern as RecurrencePattern;
      expect(rotationTurn(pattern, vector.rotationFrom, vector.date), JSON.stringify(vector)).toBe(
        vector.expected,
      );
      expect(bruteTurn(pattern, vector.rotationFrom, vector.date)).toBe(vector.expected);
    }
  });

  it("starts at 0 on the rotation's first date and counts every later date", () => {
    expect(rotationTurn(weekly, "2026-10-19", "2026-10-19")).toBe(0);
    expect(rotationTurn(weekly, "2026-10-19", "2026-10-26")).toBe(1);
    expect(rotationTurn(weekly, "2026-10-19", "2026-11-23")).toBe(5);
    // A date between two scheduled dates counts the ones before it.
    expect(rotationTurn(weekly, "2026-10-19", "2026-10-28")).toBe(2);
  });

  it("counts from the first scheduled date on or after where the rotation starts", () => {
    expect(rotationTurn(weekly, "2026-10-21", "2026-10-26")).toBe(0);
    expect(rotationTurn(weekly, "2026-10-21", "2026-11-02")).toBe(1);
  });
});

describe("rotationAssignments", () => {
  const rule = { ...weekly, endsOn: null, count: null };

  it("deals the dates to the places in order and wraps around", () => {
    expect(rotationAssignments(rule, "2026-10-19", 3, "2026-10-19", 5)).toEqual([
      { date: "2026-10-19", position: 0 },
      { date: "2026-10-26", position: 1 },
      { date: "2026-11-02", position: 2 },
      { date: "2026-11-09", position: 0 },
      { date: "2026-11-16", position: 1 },
    ]);
  });

  it("keeps the order when the preview starts later (a skip or a miss never shifts it)", () => {
    expect(rotationAssignments(rule, "2026-10-19", 3, "2026-11-03", 2)).toEqual([
      { date: "2026-11-09", position: 0 },
      { date: "2026-11-16", position: 1 },
    ]);
  });

  it("stops at the rule's end", () => {
    expect(
      rotationAssignments({ ...rule, count: 2 }, "2026-10-19", 2, "2026-10-19", 5).map(
        (entry) => entry.date,
      ),
    ).toEqual(["2026-10-19", "2026-10-26"]);
  });

  it("refuses an empty order", () => {
    expect(() => rotationAssignments(rule, "2026-10-19", 0, "2026-10-19", 1)).toThrow(RangeError);
  });
});
