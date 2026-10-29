import type {
  GoalDetail,
  GoalEntry,
  GoalList,
  GoalPeriod,
  GoalSeriesDetail,
  GoalSummary,
} from "./shapes";

/** Test data for the goal routes and components (S30). Not imported by app code. */

export const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
export const GOAL = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0090";
export const ENTRY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0091";
export const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
export const SERIES = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0095";

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
    period: null,
    ...overrides,
  };
}

/** The November 2026 period of the monthly series SERIES (S30b), still running. */
export function goalPeriod(overrides: Partial<GoalPeriod> = {}): GoalPeriod {
  return {
    seriesId: SERIES,
    seriesTitle: "Run every month",
    frequency: "monthly",
    start: "2026-11-01",
    end: "2026-11-30",
    ended: false,
    outcome: null,
    finalizedAt: null,
    correctedAt: null,
    needsReview: false,
    ...overrides,
  };
}

/** A monthly measurable Home series (S30b), 7.5 of 10 km this month; the viewer manages it. */
export function goalSeriesDetail(overrides: Partial<GoalSeriesDetail> = {}): GoalSeriesDetail {
  return {
    id: SERIES,
    homeId: HOME,
    kind: "measurable",
    frequency: "monthly",
    weekStart: "monday",
    title: "Run every month",
    state: "active",
    firstPeriodStart: "2026-10-01",
    endsOn: null,
    revision: 1,
    target: 10,
    unit: "km",
    unitKind: "preset",
    current: {
      id: GOAL,
      start: "2026-11-01",
      end: "2026-11-30",
      total: 7.5,
      target: 10,
      unit: "km",
      unitKind: "preset",
      status: "active",
    },
    access: "manage",
    description: null,
    timeZone: "Europe/Brussels",
    today: "2026-11-10",
    createdAt: "2026-10-01T09:00:00Z",
    stoppedAt: null,
    reminder: null,
    currentPeriod: { start: "2026-11-01", end: "2026-11-30" },
    nextPeriod: { start: "2026-12-01", end: "2026-12-31" },
    targets: [
      { effectiveFrom: "2026-10-01", target: 10, unit: "km", unitKind: "preset", past: false },
    ],
    events: [
      {
        id: ENTRY,
        kind: "created",
        by: MEMBER,
        mine: true,
        at: "2026-10-01T09:00:00Z",
        details: null,
      },
    ],
    periodCount: 2,
    actions: { manage: true, changeTarget: true, pause: true, resume: false, stop: true },
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
    series: [],
    ...overrides,
  };
}
