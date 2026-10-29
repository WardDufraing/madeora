import type { HabitCheckin, HabitDetail, HabitNumericDay, HabitSummary } from "./shapes";

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
    tracking: {
      effectiveOn: null,
      mode: "once",
      target: null,
      unit: null,
      unitKind: null,
      quickAdds: [],
    },
    nextTracking: null,
    progress: null,
    contributionBlock: "not_numeric",
    ...overrides,
  };
}

/** A numeric habit: 2,000 ml a day with two quick-add presets, 500 ml done today. */
export function numericHabitSummary(overrides: Partial<HabitSummary> = {}): HabitSummary {
  return habitSummary({
    name: "Drink water",
    tracking: {
      effectiveOn: "2026-11-01",
      mode: "numeric",
      target: 2000,
      unit: "ml",
      unitKind: "preset",
      quickAdds: [250, 500],
    },
    progress: {
      onDate: "2026-11-10",
      total: 500,
      target: 2000,
      unit: "ml",
      unitKind: "preset",
      met: false,
      above: false,
    },
    contributionBlock: null,
    ...overrides,
  });
}

/** A numeric day of the daily totals: 2,250 of 2,000 ml. */
export function numericDay(overrides: Partial<HabitNumericDay> = {}): HabitNumericDay {
  return {
    onDate: "2026-11-09",
    state: "completed",
    pausedBy: null,
    target: 2000,
    unit: "ml",
    unitKind: "preset",
    total: 2250,
    met: true,
    above: true,
    note: null,
    noteRevision: 0,
    block: null,
    ...overrides,
  };
}

/** A numeric habit as its page reads it. */
export function numericHabitDetail(overrides: Partial<HabitDetail> = {}): HabitDetail {
  const summary = numericHabitSummary();
  return {
    ...summary,
    trackings: [summary.tracking],
    numericRecent: [],
    periods: [{ id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0082", startsOn: "2026-11-01", endsOn: null }],
    schedules: summary.schedule ? [summary.schedule] : [],
    pauses: [],
    vacationDays: [],
    recent: [],
    weeks: [],
    milestones: [],
    reminder: null,
    celebrations: true,
    ...overrides,
  };
}
