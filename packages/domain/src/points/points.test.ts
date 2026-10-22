import { describe, expect, it } from "vitest";

import {
  canOnRedemption,
  choreAward,
  competitionRanks,
  isLateCompletion,
  targetProgress,
  validChorePoints,
} from "./index.ts";

describe("choreAward", () => {
  it("pays the base value on time, whatever the policy", () => {
    expect(choreAward({ points: 10, latePolicy: "zero", latePoints: null }, false)).toBe(10);
    expect(choreAward({ points: 10, latePolicy: "reduced", latePoints: 4 }, false)).toBe(10);
  });

  it("applies the late policy: full, reduced, zero", () => {
    expect(choreAward({ points: 10, latePolicy: "full", latePoints: null }, true)).toBe(10);
    expect(choreAward({ points: 10, latePolicy: "reduced", latePoints: 4 }, true)).toBe(4);
    expect(choreAward({ points: 10, latePolicy: "zero", latePoints: null }, true)).toBe(0);
  });

  it("never pays a reduced amount above the base value", () => {
    expect(choreAward({ points: 3, latePolicy: "reduced", latePoints: 8 }, true)).toBe(3);
  });
});

describe("isLateCompletion", () => {
  it("compares Home-local dates: the due day itself is on time", () => {
    expect(isLateCompletion("2026-10-20", "2026-10-20")).toBe(false);
    expect(isLateCompletion("2026-10-20", "2026-10-21")).toBe(true);
    expect(isLateCompletion("2026-10-20", "2026-10-19")).toBe(false);
  });
});

describe("validChorePoints", () => {
  it("accepts whole points 0-1000 and a reduced amount up to them", () => {
    expect(validChorePoints({ points: 0, latePolicy: "full", latePoints: null })).toBe(true);
    expect(validChorePoints({ points: 1000, latePolicy: "reduced", latePoints: 1000 })).toBe(true);
  });

  it("refuses out-of-range, fractional and inconsistent settings", () => {
    expect(validChorePoints({ points: 1001, latePolicy: "full", latePoints: null })).toBe(false);
    expect(validChorePoints({ points: -1, latePolicy: "full", latePoints: null })).toBe(false);
    expect(validChorePoints({ points: 2.5, latePolicy: "full", latePoints: null })).toBe(false);
    expect(validChorePoints({ points: 5, latePolicy: "reduced", latePoints: null })).toBe(false);
    expect(validChorePoints({ points: 5, latePolicy: "zero", latePoints: 2 })).toBe(false);
    expect(validChorePoints({ points: 5, latePolicy: "reduced", latePoints: 6 })).toBe(false);
  });
});

describe("competitionRanks", () => {
  it("ranks by earned points, then completed chores, sharing equal ranks (1, 1, 3)", () => {
    const ranked = competitionRanks([
      { id: "a", earned: 10, completed: 2 },
      { id: "b", earned: 20, completed: 1 },
      { id: "c", earned: 10, completed: 2 },
      { id: "d", earned: 10, completed: 3 },
    ]);
    expect(ranked.map((row) => [row.id, row.rank])).toEqual([
      ["b", 1],
      ["d", 2],
      ["a", 3],
      ["c", 3],
    ]);
  });

  it("gives everyone rank 1 when nobody has activity", () => {
    expect(
      competitionRanks([
        { earned: 0, completed: 0 },
        { earned: 0, completed: 0 },
      ]).map((row) => row.rank),
    ).toEqual([1, 1]);
  });
});

describe("targetProgress", () => {
  it("is none without a target or with a zero target", () => {
    expect(targetProgress(5, null)).toBeNull();
    expect(targetProgress(5, 0)).toBeNull();
  });

  it("caps the ratio at 1 and never goes below 0", () => {
    expect(targetProgress(30, 20)?.ratio).toBe(1);
    expect(targetProgress(-5, 20)?.ratio).toBe(0);
    expect(targetProgress(5, 20)).toEqual({ earned: 5, target: 20, ratio: 0.25 });
  });
});

describe("canOnRedemption", () => {
  const reviewer = { manageRewards: false, approveRewards: true };
  const owner = { manageRewards: true, approveRewards: true };
  const member = { manageRewards: false, approveRewards: false };

  it("never lets a requester approve or reject their own request, whatever they hold", () => {
    for (const action of ["approve", "reject"] as const) {
      expect(canOnRedemption(owner, { status: "pending", own: true }, action)).toBe(false);
      expect(canOnRedemption(reviewer, { status: "pending", own: false }, action)).toBe(true);
      expect(canOnRedemption(member, { status: "pending", own: false }, action)).toBe(false);
    }
  });

  it("lets the requester or a rewards manager cancel while pending", () => {
    expect(canOnRedemption(member, { status: "pending", own: true }, "cancel")).toBe(true);
    expect(canOnRedemption(owner, { status: "pending", own: false }, "cancel")).toBe(true);
    expect(canOnRedemption(reviewer, { status: "pending", own: false }, "cancel")).toBe(false);
  });

  it("allows nothing once decided", () => {
    for (const status of ["redeemed", "rejected", "cancelled"] as const) {
      for (const action of ["approve", "reject", "cancel"] as const) {
        expect(canOnRedemption(owner, { status, own: false }, action)).toBe(false);
      }
    }
  });
});
