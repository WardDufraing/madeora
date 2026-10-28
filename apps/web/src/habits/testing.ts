import type { HabitCheckin, HabitSummary } from "./shapes";

/** Test data for the habit routes and components (S28). Not imported by app code. */

export const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
export const HABIT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0080";
export const CHECKIN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0081";
export const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";

export function habitCheckin(overrides: Partial<HabitCheckin> = {}): HabitCheckin {
  return {
    id: CHECKIN,
    onDate: "2026-11-10",
    by: MEMBER,
    mine: true,
    recordedAt: "2026-11-10T08:00:00Z",
    backdated: false,
    source: "app",
    note: null,
    noteRevision: 0,
    noteUpdatedAt: null,
    status: "active",
    undoneBy: null,
    undoneByMe: false,
    undoneAt: null,
    undoKind: null,
    undoReason: null,
    action: "undo",
    ...overrides,
  };
}

export function habitSummary(overrides: Partial<HabitSummary> = {}): HabitSummary {
  return {
    id: HABIT,
    homeId: HOME,
    name: "Morning walk",
    description: null,
    timeZone: "Europe/Brussels",
    weekStart: "monday",
    revision: 1,
    status: "active",
    archivedAt: null,
    today: "2026-11-10",
    startsOn: "2026-11-01",
    periodStartsOn: "2026-11-01",
    endsOn: null,
    periodCount: 1,
    schedule: { effectiveOn: "2026-11-01", kind: "daily", weekdays: [], target: null },
    nextSchedule: null,
    todayState: "open",
    pausedBy: null,
    todayCheckin: null,
    todayBlock: null,
    week: null,
    streak: { current: 3, unit: "occurrences", longestOccurrences: 5, longestWeeks: 0 },
    pause: null,
    reminders: false,
    myReminders: true,
    access: "manage",
    ...overrides,
  };
}
