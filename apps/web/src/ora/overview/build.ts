import { eventPath, googleEventPath } from "@/calendar/format";
import type { CalendarList, Occurrence } from "@/calendar/shapes";
import { choresPath } from "@/chores/format";
import type { ChoreAgenda } from "@/chores/api";
import { addDays, daysBetween } from "@/tasks/calendar";
import { tasksPath } from "@/tasks/format";
import type { TaskCalendar } from "@/tasks/api";

import {
  overviewModules,
  type Overview,
  type OverviewDay,
  type OverviewFilters,
  type OverviewItem,
  type OverviewModule,
  type OverviewNotice,
} from "./types";

/**
 * Builds an overview from what the viewer's own reads returned (S46). Pure: it never fetches, so
 * it can only arrange records the caller was already allowed to read, and every rule of the spec
 * that is about content (de-duplication, completed and cancelled records, busy days, partial data,
 * empty states) lives here and is tested without a database.
 *
 * A source is `off` when the viewer may not use that module here (it is then left out silently,
 * with no hint it exists) and `unavailable` when the read failed (that is disclosed).
 */
export type Source<T> =
  | { readonly status: "off" }
  | { readonly status: "unavailable" }
  | { readonly status: "ok"; readonly value: T };

export interface BuildInput {
  readonly homeId: string | null;
  readonly scope: "day" | "week";
  readonly from: string;
  readonly to: string;
  readonly today: string;
  readonly timeZone: string;
  readonly filters: OverviewFilters;
  /** The viewer's membership id in the Home; null in Personal. */
  readonly selfMembershipId: string | null;
  readonly members: Overview["members"];
  readonly calendar: Source<CalendarList>;
  readonly tasks: Source<TaskCalendar>;
  readonly chores: Source<ChoreAgenda>;
}

const emptyCounts = (): { [M in OverviewModule]: number } => ({
  calendar: 0,
  tasks: 0,
  chores: 0,
});

function matchesAssignee(
  filters: OverviewFilters,
  self: string | null,
  assignees: readonly (string | null)[],
): boolean {
  if (filters.assignee === "anyone") return true;
  const wanted = filters.assignee === "me" ? self : (filters.member ?? null);
  return wanted !== null && assignees.includes(wanted);
}

function matchesCompletion(filters: OverviewFilters, done: boolean): boolean {
  return filters.completion === "all" || (filters.completion === "done") === done;
}

function eventItems(input: BuildInput, list: CalendarList): OverviewItem[] {
  const items: OverviewItem[] = [];
  // Only a Google event that mirrors a Madeora event (same title and times) is collapsed into it;
  // two separate Madeora events at the same time both count.
  const key = (occurrence: Occurrence) =>
    [
      occurrence.title.trim().toLowerCase(),
      occurrence.startsAt ?? occurrence.from,
      occurrence.endsAt ?? occurrence.to,
    ].join("|");
  const mirrored = new Set(list.occurrences.filter((entry) => entry.source !== "google").map(key));
  for (const occurrence of list.occurrences) {
    if (!matchesAssignee(input.filters, input.selfMembershipId, occurrence.participants)) continue;
    // Calendar entries have no completion state: a "done" filter leaves them out.
    if (input.filters.completion === "done") continue;
    if (occurrence.source === "google" && mirrored.has(key(occurrence))) continue;
    for (let date = occurrence.from > input.from ? occurrence.from : input.from; ;) {
      if (date > occurrence.to || date > input.to) break;
      items.push(eventItem(input, occurrence, date));
      date = addDays(date, 1);
    }
  }
  return items;
}

function eventItem(input: BuildInput, occurrence: Occurrence, date: string): OverviewItem {
  // A timed event is "timed" on the day it starts; its later days read as all-day continuation.
  const timed = !occurrence.allDay && occurrence.startsAt !== null && occurrence.from === date;
  return {
    key: `calendar:${occurrence.eventId}:${occurrence.on ?? ""}:${date}`,
    module: "calendar",
    title: occurrence.title,
    day: date,
    allDay: !timed,
    startsAt: timed ? occurrence.startsAt : null,
    endsAt: timed ? occurrence.endsAt : null,
    timeZone: input.timeZone,
    status: "open",
    href:
      occurrence.source === "google"
        ? googleEventPath(input.homeId, occurrence.eventId)
        : eventPath(input.homeId, occurrence.eventId, occurrence.on),
    origin:
      occurrence.source === "google"
        ? "google"
        : occurrence.kind === "home"
          ? "own"
          : occurrence.kind === "shared"
            ? "shared"
            : "personal",
    assigneeIds: occurrence.participants,
    canComplete: false,
  };
}

function taskItems(input: BuildInput, calendar: TaskCalendar): OverviewItem[] {
  const items: OverviewItem[] = [];
  for (const entry of calendar.entries) {
    if (entry.role !== "due") continue;
    if (entry.date < input.from || entry.date > input.to) continue;
    const done = entry.kind === "task" && entry.completed;
    if (!matchesAssignee(input.filters, input.selfMembershipId, entry.assigneeIds)) continue;
    if (!matchesCompletion(input.filters, done)) continue;
    const taskId = entry.taskId;
    items.push({
      key: `tasks:${taskId ?? entry.title}:${entry.date}`,
      module: "tasks",
      title: entry.title,
      day: entry.date,
      allDay: false,
      startsAt: null,
      endsAt: null,
      timeZone: input.timeZone,
      status: done ? "done" : entry.kind === "task" && entry.overdue ? "overdue" : "open",
      href: taskId ? `${tasksPath(input.homeId)}/${taskId}` : tasksPath(input.homeId),
      origin: "own",
      assigneeIds: entry.assigneeIds,
      canComplete: entry.kind === "task" && entry.canComplete && !entry.completed,
    });
  }
  return items;
}

function choreItems(input: BuildInput, agenda: ChoreAgenda): OverviewItem[] {
  const homeId = input.homeId;
  if (homeId === null) return [];
  const items: OverviewItem[] = [];
  for (const item of agenda.items) {
    if (item.date < input.from || item.date > input.to) continue;
    // Skipped, expired and paused chores are not commitments any more.
    if (item.status === "skipped" || item.status === "expired" || item.status === "paused")
      continue;
    const done = item.status === "completed";
    if (!matchesAssignee(input.filters, input.selfMembershipId, item.assigneeIds)) continue;
    if (!matchesCompletion(input.filters, done)) continue;
    items.push({
      key: `chores:${item.id ?? item.choreId}:${item.date}`,
      module: "chores",
      title: item.title,
      day: item.date,
      allDay: false,
      startsAt: null,
      endsAt: null,
      timeZone: input.timeZone,
      status: done
        ? "done"
        : item.status === "pending_approval"
          ? "pending"
          : item.overdue
            ? "overdue"
            : "open",
      href: item.id ? `${choresPath(homeId)}/${item.id}` : choresPath(homeId),
      origin: "own",
      assigneeIds: item.assigneeIds,
      canComplete: false,
    });
  }
  return items;
}

function noticesFor(input: BuildInput): OverviewNotice[] {
  const notices: OverviewNotice[] = [];
  if (input.calendar.status === "unavailable") {
    notices.push({ kind: "unavailable", module: "calendar", source: null, lastSyncedAt: null });
  }
  if (input.tasks.status === "unavailable") {
    notices.push({ kind: "unavailable", module: "tasks", source: null, lastSyncedAt: null });
  }
  if (input.chores.status === "unavailable") {
    notices.push({ kind: "unavailable", module: "chores", source: null, lastSyncedAt: null });
  }
  if (input.calendar.status === "ok") {
    for (const warning of input.calendar.value.googleWarnings) {
      notices.push({
        kind: warning.lastSyncedAt === null ? "unverified" : "stale",
        module: "calendar",
        // Someone else's calendar is only ever "out of date": its name is not ours to show.
        source: warning.own ? warning.calendar : null,
        lastSyncedAt: warning.lastSyncedAt,
      });
    }
  }
  return notices;
}

/** Days that look visibly busier than the rest; relative, never a fixed workload threshold. */
function busyDays(days: readonly { readonly date: string; readonly total: number }[]): Set<string> {
  if (days.length < 3) return new Set();
  const totals = days.map((day) => day.total).sort((a, b) => a - b);
  const mean = totals.reduce((sum, value) => sum + value, 0) / totals.length;
  const median = totals[Math.floor(totals.length / 2)] ?? 0;
  return new Set(
    days
      .filter((day) => day.total >= 3 && day.total > mean * 1.5 && day.total >= median + 2)
      .map((day) => day.date),
  );
}

export function buildOverview(input: BuildInput): Overview {
  const modules = overviewModules.filter((module) => input[module].status !== "off");
  const wanted = (module: OverviewModule) =>
    input.filters.modules.length === 0 || input.filters.modules.includes(module);

  const all: OverviewItem[] = [];
  if (wanted("calendar") && input.calendar.status === "ok") {
    all.push(...eventItems(input, input.calendar.value));
  }
  if (wanted("tasks") && input.tasks.status === "ok")
    all.push(...taskItems(input, input.tasks.value));
  if (wanted("chores") && input.chores.status === "ok") {
    all.push(...choreItems(input, input.chores.value));
  }

  const dayCount = daysBetween(input.from, input.to) + 1;
  const dates = Array.from({ length: dayCount }, (_, index) => addDays(input.from, index));
  const withTotals = dates.map((date) => ({
    date,
    items: all.filter((item) => item.day === date),
  }));

  const notices = noticesFor(input);
  const truncated =
    (input.calendar.status === "ok" && input.calendar.value.truncated) ||
    (input.tasks.status === "ok" && input.tasks.value.truncated) ||
    (input.chores.status === "ok" && input.chores.value.truncated);
  const incomplete = notices.length > 0 || truncated;
  const filtered =
    input.filters.modules.length > 0 ||
    input.filters.assignee !== "anyone" ||
    input.filters.completion !== "all";

  // A comparison between days is only honest on the full, complete set.
  const busy =
    input.scope === "week" && !incomplete && !filtered
      ? busyDays(withTotals.map((day) => ({ date: day.date, total: day.items.length })))
      : new Set<string>();

  const days: OverviewDay[] = withTotals.map(({ date, items }) => {
    const counts = emptyCounts();
    for (const item of items) counts[item.module] += 1;
    const timed = items
      .filter((item) => !item.allDay && item.startsAt !== null)
      .sort(
        (a, b) =>
          (a.startsAt ?? "").localeCompare(b.startsAt ?? "") || a.title.localeCompare(b.title),
      );
    const untimed = items
      .filter((item) => item.allDay || item.startsAt === null)
      .sort(
        (a, b) =>
          overviewModules.indexOf(a.module) - overviewModules.indexOf(b.module) ||
          a.title.localeCompare(b.title),
      );
    return { date, timed, untimed, counts, busier: busy.has(date) };
  });

  const total = all.length;
  return {
    homeId: input.homeId,
    scope: input.scope,
    from: input.from,
    to: input.to,
    today: input.today,
    timeZone: input.timeZone,
    filters: input.filters,
    members: input.members,
    modules,
    days,
    notices,
    incomplete,
    empty: total > 0 ? null : incomplete ? "incomplete" : filtered ? "filtered" : "none",
    truncated,
  };
}
