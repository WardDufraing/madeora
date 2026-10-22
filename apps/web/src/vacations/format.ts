import type { DateTimeFormats } from "@/invitations/format";
import { formatTaskDate } from "@/tasks/format";

import type { DateRange } from "./api";

export function vacationsPath(homeId: string): string {
  return `/homes/${homeId}/vacations`;
}

export function absencesPath(homeId: string): string {
  return `/homes/${homeId}/chores/absences`;
}

/** "3/11/2026" for one day, "3/11/2026 – 9/11/2026" for more. */
export function rangeText(
  startsOn: string,
  endsOn: string,
  formats: Pick<DateTimeFormats, "dateFormat">,
): string {
  const start = formatTaskDate(startsOn, formats);
  return startsOn === endsOn ? start : `${start} \u{2013} ${formatTaskDate(endsOn, formats)}`;
}

export function rangesText(
  ranges: readonly DateRange[],
  formats: Pick<DateTimeFormats, "dateFormat">,
): string {
  return ranges.map((range) => rangeText(range.from, range.to, formats)).join(", ");
}
