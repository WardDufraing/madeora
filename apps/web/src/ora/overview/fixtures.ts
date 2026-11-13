import type { CalendarList, Occurrence } from "@/calendar/shapes";
import type { ChoreAgenda, ChoreAgendaItem } from "@/chores/api";
import type { TaskCalendar } from "@/tasks/api";

import type { BuildInput } from "./build";
import { defaultOverviewFilters } from "./types";

/** Test fixtures for overview sources: valid shapes with every irrelevant field filled in. */
export const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
export const ME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a1";
export const OTHER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a2";
let counter = 0;
const uuid = () => `6f2c1f0e-1d7a-4b8e-9c55-${String(++counter).padStart(12, "0")}`;

export function occurrence(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    eventId: uuid(),
    on: null,
    kind: "home",
    sharedBy: null,
    title: "Dentist",
    location: null,
    allDay: false,
    from: "2026-11-16",
    to: "2026-11-16",
    startsAt: "2026-11-16T09:00:00.000Z",
    endsAt: "2026-11-16T10:00:00.000Z",
    timezone: "Europe/Brussels",
    recurring: false,
    changed: false,
    participants: [],
    source: "madeora",
    calendar: null,
    googleState: null,
    ...overrides,
  };
}

export function calendar(
  occurrences: readonly Occurrence[],
  overrides: Partial<CalendarList> = {},
): CalendarList {
  return {
    timezone: "Europe/Brussels",
    today: "2026-11-16",
    level: "manage",
    canCreate: true,
    truncated: false,
    occurrences: [...occurrences],
    showVacations: false,
    showTasks: true,
    showChores: true,
    vacations: [],
    googleWarnings: [],
    ...overrides,
  };
}

type TaskEntry = TaskCalendar["entries"][number];
export function task(overrides: Record<string, unknown> = {}): TaskEntry {
  return {
    kind: "task",
    role: "due",
    date: "2026-11-16",
    listId: uuid(),
    listName: "Home",
    title: "Pay rent",
    priority: null,
    needsReassignment: false,
    labelIds: [],
    assigneeIds: [],
    taskId: uuid(),
    startDate: null,
    dueDate: "2026-11-16",
    completed: false,
    overdue: false,
    recurring: false,
    subtasksDone: 0,
    subtasksTotal: 0,
    canComplete: true,
    revision: 1,
    ...overrides,
  };
}

export function tasks(entries: readonly TaskEntry[], truncated = false): TaskCalendar {
  return { today: "2026-11-16", entries: [...entries], truncated, undated: 0 };
}

export function chore(overrides: Partial<ChoreAgendaItem> = {}): ChoreAgendaItem {
  return {
    id: uuid(),
    choreId: uuid(),
    title: "Vacuum",
    date: "2026-11-16",
    category: null,
    status: "open",
    overdue: false,
    inRework: false,
    needsReassignment: false,
    awaitingVolunteer: false,
    assigneeIds: [],
    minutes: null,
    revision: 1,
    recurring: false,
    projected: false,
    ...overrides,
  };
}

export function chores(items: readonly ChoreAgendaItem[]): ChoreAgenda {
  return { today: "2026-11-16", canManage: false, items: [...items], truncated: false };
}

export function input(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    homeId: HOME,
    scope: "day",
    from: "2026-11-16",
    to: "2026-11-16",
    today: "2026-11-16",
    timeZone: "Europe/Brussels",
    filters: defaultOverviewFilters,
    selfMembershipId: ME,
    members: [],
    calendar: { status: "ok", value: calendar([]) },
    tasks: { status: "ok", value: tasks([]) },
    chores: { status: "ok", value: chores([]) },
    ...overrides,
  };
}
