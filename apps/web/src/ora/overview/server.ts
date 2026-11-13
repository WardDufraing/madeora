import "server-only";

import { decideHomeAction } from "@madeora/domain/permissions";

import { readCalendar } from "@/calendar/data";
import { listChoreSchedule } from "@/chores/data";
import { getHomeContext } from "@/homes/server";
import { getHomeDirectory } from "@/members/directory";
import { getRegionalFormats, getEffectiveTimeZone } from "@/preferences/server";
import { isoDate } from "@/preferences/regional";
import { listTaskCalendar } from "@/tasks/data";

import type { OraToolContext } from "../tools/types";
import { buildOverview, type Source } from "./build";
import { resolveRange } from "./range";
import { defaultOverviewFilters, type Overview, type OverviewRequest } from "./types";

/**
 * Loads one overview for the person asking, in the place they are in (S46). Every read uses their
 * own Supabase session, so the database decides what is theirs to see; a module they may not use in
 * this place is skipped here as well (the permission engine), so the overview never even asks. The
 * place and permissions come from the tool context the server resolved for this request, never from
 * the browser.
 */
export type OverviewLoad =
  { readonly status: "ok"; readonly overview: Overview } | { readonly status: "unavailable" };

type ReadResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "not-found" | "invalid" | "unavailable" };

/** "Not theirs to see" is silent (`off`); only a failure to read is disclosed. */
function source<T>(allowed: boolean, read: ReadResult<T> | null): Source<T> {
  if (!allowed || read === null) return { status: "off" };
  if (read.status === "ok") return { status: "ok", value: read.value };
  // A rejected request is a defect, not "nothing planned": disclose it like any failed read.
  if (read.status === "unavailable" || read.status === "invalid") return { status: "unavailable" };
  return { status: "off" };
}

export async function loadOverview(
  context: OraToolContext,
  request: OverviewRequest,
): Promise<OverviewLoad> {
  const home = context.home;
  const homeId = home?.id ?? null;

  const [homeContext, personalZone, regional] = await Promise.all([
    homeId === null ? Promise.resolve(null) : getHomeContext(homeId),
    getEffectiveTimeZone(),
    getRegionalFormats(),
  ]);
  if (homeContext !== null && homeContext.status !== "ok") return { status: "unavailable" };
  const timeZone =
    homeContext?.status === "ok" ? homeContext.context.home.timeZone : personalZone.timeZone;
  const today = isoDate(new Date(), timeZone);
  const range = resolveRange(request, today, regional.effective.weekStart);

  const allowed = (action: "home.calendar.view" | "home.tasks.view" | "home.chores.view") =>
    home === null || decideHomeAction(home.id, home.membership, action).allowed;
  const canCalendar = allowed("home.calendar.view");
  const canTasks = allowed("home.tasks.view");
  const canChores = home !== null && allowed("home.chores.view");

  const [calendar, tasks, chores, directory] = await Promise.all([
    canCalendar ? readCalendar(homeId, range.from, range.to) : null,
    canTasks
      ? listTaskCalendar(
          homeId,
          { from: range.from, to: range.to },
          { status: "all", priority: [], label: [], assignee: "any" },
        )
      : null,
    canChores && homeId !== null ? listChoreSchedule(homeId, range.from, range.to) : null,
    homeId === null ? Promise.resolve(null) : getHomeDirectory(homeId),
  ]);

  const people =
    directory?.status === "ok" ? directory.members.filter((member) => !member.isInactive) : [];
  const self = people.find((member) => member.isSelf)?.membershipId ?? null;
  // Personal space has no members: assignee filters mean nothing there.
  const filters =
    homeId === null
      ? { ...request.filters, assignee: "anyone" as const, member: undefined }
      : request.filters;

  const overview = buildOverview({
    homeId,
    scope: range.scope,
    from: range.from,
    to: range.to,
    today,
    timeZone,
    filters: { ...defaultOverviewFilters, ...filters },
    selfMembershipId: self,
    members: people.map((member) => ({
      id: member.membershipId,
      name: member.name,
      isSelf: member.isSelf,
      shareable: !member.isSelf && member.isChild !== true,
    })),
    calendar: source(canCalendar, calendar),
    tasks: source(canTasks, tasks),
    chores: source(canChores, chores),
  });
  return { status: "ok", overview };
}
