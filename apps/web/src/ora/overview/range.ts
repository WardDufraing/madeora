import type { WeekStart } from "@/preferences/schema";
import { addDays, startOfWeek } from "@/tasks/calendar";

import type { OverviewRequest } from "./types";

/**
 * The calendar dates an overview covers, as local dates in the context's timezone (never the
 * browser's). "This week" and "next week" follow the person's first day of the week; a week that
 * crosses a month, a year or a daylight-saving change is still seven calendar dates because
 * everything here counts dates, not hours.
 */
export function resolveRange(
  request: Pick<OverviewRequest, "target" | "date">,
  today: string,
  weekStart: WeekStart,
): { readonly scope: "day" | "week"; readonly from: string; readonly to: string } {
  switch (request.target) {
    case "today":
      return { scope: "day", from: today, to: today };
    case "tomorrow": {
      const day = addDays(today, 1);
      return { scope: "day", from: day, to: day };
    }
    case "day": {
      const day = request.date ?? today;
      return { scope: "day", from: day, to: day };
    }
    case "this-week":
    case "next-week":
    case "week": {
      const anchor =
        request.target === "week"
          ? (request.date ?? today)
          : request.target === "next-week"
            ? addDays(today, 7)
            : today;
      const from = startOfWeek(anchor, weekStart);
      return { scope: "week", from, to: addDays(from, 6) };
    }
  }
}
