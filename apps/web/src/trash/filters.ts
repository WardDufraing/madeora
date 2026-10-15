import { z } from "zod";

import { trashItemTypes, trashModules, type ListQuery } from "./schema";

/**
 * The trash page's filters as they appear in its address (`?module=&type=&from=&to=`), and their
 * conversion to the list query. Deletion dates are calendar days in the viewer's own time zone, so
 * "from 15 October" starts at that zone's midnight, not UTC's. Client-safe.
 */
export interface TrashFilters {
  readonly module: string;
  readonly itemType: string;
  readonly from: string;
  readonly to: string;
}

const dateOnly = z.iso.date();

export function parseTrashFilters(
  params: Readonly<Record<string, string | string[] | undefined>>,
): TrashFilters {
  const one = (name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : "";
  };
  const date = (name: string) => (dateOnly.safeParse(one(name)).success ? one(name) : "");
  return {
    module: (trashModules as readonly string[]).includes(one("module")) ? one("module") : "",
    itemType: (trashItemTypes as readonly string[]).includes(one("type")) ? one("type") : "",
    from: date("from"),
    to: date("to"),
  };
}

export function hasTrashFilters(filters: TrashFilters): boolean {
  return Boolean(filters.module || filters.itemType || filters.from || filters.to);
}

/** The offset of `timeZone` from UTC at `instant`, in milliseconds (east of UTC positive). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const wall = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The first instant of calendar day `isoDate` (YYYY-MM-DD) in `timeZone`. A day whose midnight does
 * not exist (a clock change at midnight) starts at the first instant after the gap.
 */
export function startOfDayInZone(isoDate: string, timeZone: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, day);
  let instant = wall;
  for (let round = 0; round < 3; round += 1) {
    instant = wall - zoneOffsetMs(instant, timeZone);
  }
  return new Date(instant);
}

function nextDay(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** The list query for these filters in this scope: `to` is a whole day, so the range ends the day after. */
export function trashQuery(
  filters: TrashFilters,
  timeZone: string,
  homeId: string | null,
): ListQuery {
  return {
    ...(homeId ? { homeId } : {}),
    ...(filters.module ? { module: filters.module as ListQuery["module"] } : {}),
    ...(filters.itemType ? { itemType: filters.itemType as ListQuery["itemType"] } : {}),
    ...(filters.from
      ? { deletedFrom: startOfDayInZone(filters.from, timeZone).toISOString() }
      : {}),
    ...(filters.to
      ? { deletedTo: startOfDayInZone(nextDay(filters.to), timeZone).toISOString() }
      : {}),
  };
}
