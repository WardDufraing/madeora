import type { GoalDetail, GoalEntry, GoalList, GoalSummary } from "./shapes";

/** Test data for the goal routes and components (S30). Not imported by app code. */

export const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
export const GOAL = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0090";
export const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0091";
export const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";

/** A measurable Home goal: 7.5 of 10 km, the viewer manages it. */
export function goalSummary(overrides: Partial<GoalSummary> = {}): GoalSummary {
  return {
    id: GOAL,
    homeId: HOME,
    kind: "measurable",
    title: "Walk to the coast",
    description: null,
    timeZone: "Europe/Brussels",
    today: "2026-11-10",
    revision: 3,
    status: "active",
    deadline: "2026-12-31",
    target: 10,
    unit: "km",
    unitKind: "preset",
    total: 7.5,
    reached: false,
    achievedAt: null,
    achievedBy: null,
    achievedByMe: false,
    archivedAt: null,
    createdAt: "2026-11-01T09:00:00Z",
    renewedFrom: null,
    reminders: false,
    myReminders: true,
    access: "manage",
    actions: { contribute: true, setTotal: true, achieve: false, reopen: false, manage: true },
    ...overrides,
  };
}

export function goalDetail(overrides: Partial<GoalDetail> = {}): GoalDetail {
  return { ...goalSummary(), achievements: [], reminder: null, entryCount: 2, ...overrides };
}

export function goalEntry(overrides: Partial<GoalEntry> = {}): GoalEntry {
  return {
    id: ENTRY,
    kind: "contribution",
    quantity: 2.5,
    originalQuantity: null,
    unit: "km",
    unitKind: "preset",
    note: null,
    by: MEMBER,
    mine: true,
    recordedAt: "2026-11-09T18:00:00Z",
    source: "app",
    status: "active",
    amendedAt: null,
    reversedAt: null,
    corrections: [],
    action: "correct",
    ...overrides,
  };
}

export function goalList(overrides: Partial<GoalList> = {}): GoalList {
  return {
    goals: [goalSummary()],
    counts: { active: 1, completed: 0, archived: 0 },
    access: "manage",
    memberAccess: "contribute",
    timeZone: "Europe/Brussels",
    ...overrides,
  };
}
