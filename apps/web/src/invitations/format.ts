import type { Locale } from "@/i18n/locales";
import type { DateFormat, TimeFormat } from "@/preferences/schema";
import { formatDate, formatTime } from "@/preferences/regional";

/**
 * How the viewer wants dates and times (their effective timezone and regional formats), passed
 * from the server page to the client components so both format alike. Client-safe.
 */
export interface DateTimeFormats {
  readonly timeZone: string;
  readonly dateFormat: DateFormat;
  readonly timeFormat: TimeFormat;
  readonly locale: Locale;
}

/** "21/10/2026 18:00" in the viewer's timezone and formats. */
export function formatDateTime(instant: Date | string, formats: DateTimeFormats): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  return `${formatDate(date, formats.timeZone, formats.dateFormat)} ${formatTime(
    date,
    formats.timeZone,
    formats.timeFormat,
    formats.locale,
  )}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long each expiry choice lasts from the moment of issue. */
export const expiryDurationMs = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS } as const;

/** A name inside a sentence, isolated (FSI … PDI) so a right-to-left name cannot reorder the text
 * around it. */
export function isolate(name: string): string {
  return `\u{2068}${name}\u{2069}`;
}
