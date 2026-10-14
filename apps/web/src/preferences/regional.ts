import type { Locale } from "@/i18n/locales";

import {
  dateFormats,
  numberFormats,
  timeFormats,
  weekStarts,
  type DateFormat,
  type MeasurementSystem,
  type NumberFormat,
  type RegionalFormats,
  type RegionalOverrides,
  type TimeFormat,
  type WeekStart,
} from "./schema";

/**
 * Regional formats (spec, "Confirmed automatic regional defaults with independent overrides").
 *
 * Automatic values come from the browser's preferred regional language tag (`nl-BE`, `en-GB`),
 * read on the server from `Accept-Language`, so the server and the browser render the same text.
 * They are recomputed for every request and never stored. Formatting only changes how a value is
 * shown, never the value. Independent of the interface language and the timezone.
 */

const MAX_HEADER_LENGTH = 1024;

/**
 * The regional language tag to derive Automatic formats from: the browser's most preferred
 * language that is a valid tag (any language, not only the supported interface languages), else
 * the interface language.
 */
export function regionalTag(acceptLanguage: string | null | undefined, fallback: Locale): string {
  if (acceptLanguage && acceptLanguage.length <= MAX_HEADER_LENGTH) {
    const ranges = acceptLanguage
      .split(",")
      .slice(0, 32)
      .map((entry, index) => {
        const [tag = "", ...params] = entry.trim().split(";");
        let quality = 1;
        for (const param of params) {
          const match = /^\s*q\s*=\s*([01](?:\.\d{1,3})?)\s*$/i.exec(param);
          if (match) quality = Number(match[1]);
        }
        return { tag: tag.trim(), quality, index };
      })
      .filter(({ quality }) => quality > 0)
      .sort((a, b) => b.quality - a.quality || a.index - b.index);
    for (const { tag } of ranges) {
      if (tag === "*") continue;
      try {
        const [canonical] = Intl.getCanonicalLocales(tag);
        if (canonical) return canonical;
      } catch {
        // Not a valid language tag; try the next one.
      }
    }
  }
  return fallback;
}

// A sample with distinct day, month and year, to read a locale's order and separators.
const SAMPLE = new Date(Date.UTC(2026, 11, 31, 12));

function detectDateFormat(tag: string): DateFormat {
  const parts = new Intl.DateTimeFormat(tag, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).formatToParts(SAMPLE);
  const order = parts
    .filter((part) => part.type === "day" || part.type === "month" || part.type === "year")
    .map((part) => part.type[0])
    .join("");
  // Direction marks (as in Arabic) are not separators.
  const separator =
    parts
      .find((part) => part.type === "literal")
      ?.value.replace(/[\u200E\u200F\u061C]/g, "")
      .trim() ?? "";
  if (order === "mdy") return "mdy-slash";
  if (order === "ymd") return "ymd-dash";
  if (separator === "-") return "dmy-dash";
  if (separator === ".") return "dmy-dot";
  return "dmy-slash";
}

function detectTimeFormat(tag: string): TimeFormat {
  const { hourCycle } = new Intl.DateTimeFormat(tag, { hour: "numeric" }).resolvedOptions();
  return hourCycle === "h11" || hourCycle === "h12" ? "12h" : "24h";
}

interface WeekInfo {
  readonly firstDay: number;
}
type LocaleWithWeekInfo = Intl.Locale & {
  readonly getWeekInfo?: () => WeekInfo;
  readonly weekInfo?: WeekInfo;
};

// Regions whose weeks start on Sunday, for runtimes without Intl week data (older Firefox).
// prettier-ignore
const sundayRegions = new Set([
  "AG", "AS", "BD", "BR", "BS", "BT", "BW", "BZ", "CA", "CN", "CO", "DM", "DO", "ET", "GT", "GU",
  "HK", "HN", "ID", "IL", "IN", "JM", "JP", "KE", "KH", "KR", "LA", "MH", "MM", "MO", "MT", "MX",
  "MZ", "NI", "NP", "PA", "PE", "PH", "PK", "PR", "PT", "PY", "SA", "SG", "SV", "TH", "TT", "TW",
  "UM", "US", "VE", "VI", "WS", "YE", "ZA", "ZW",
]);
// prettier-ignore
const saturdayRegions = new Set([
  "AE", "AF", "BH", "DJ", "DZ", "EG", "IQ", "IR", "JO", "KW", "LY", "OM", "QA", "SD", "SY",
]);

function detectWeekStart(locale: Intl.Locale): WeekStart {
  const withInfo = locale as LocaleWithWeekInfo;
  const firstDay =
    typeof withInfo.getWeekInfo === "function"
      ? withInfo.getWeekInfo().firstDay
      : withInfo.weekInfo?.firstDay;
  if (firstDay === 7) return "sunday";
  if (firstDay === 6) return "saturday";
  if (firstDay !== undefined) return "monday";
  const region = locale.region ?? "";
  if (sundayRegions.has(region)) return "sunday";
  if (saturdayRegions.has(region)) return "saturday";
  return "monday";
}

function detectNumberFormat(tag: string): NumberFormat {
  const parts = new Intl.NumberFormat(tag, { numberingSystem: "latn" }).formatToParts(12345.6);
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  const group = parts.find((part) => part.type === "group")?.value ?? ",";
  if (decimal !== ",") return "comma-dot";
  return /\s/u.test(group) ? "space-comma" : "dot-comma";
}

// Where US customary units are the everyday system.
const usCustomaryRegions = new Set(["US", "LR", "MM", "PR", "GU", "VI", "AS", "MP", "UM"]);

function detectMeasurementSystem(locale: Intl.Locale): MeasurementSystem {
  return usCustomaryRegions.has(locale.region ?? "") ? "us-customary" : "metric";
}

/** Automatic regional formats for a language tag such as `nl-BE`. */
export function detectRegionalFormats(tag: string): RegionalFormats {
  let given: Intl.Locale;
  try {
    given = new Intl.Locale(tag);
  } catch {
    given = new Intl.Locale("en");
  }
  // Format with the tag as given: with an added script (`en-Latn-GB`) ICU falls back to other
  // conventions. The maximized form only supplies the likely region (`nl` → NL).
  const base = given.baseName;
  const locale = given.maximize();
  return {
    dateFormat: detectDateFormat(base),
    timeFormat: detectTimeFormat(base),
    weekStart: detectWeekStart(locale),
    numberFormat: detectNumberFormat(base),
    measurementSystem: detectMeasurementSystem(locale),
  };
}

/** The formats in effect: each custom choice, else the detected default. */
export function resolveRegionalFormats(
  overrides: RegionalOverrides,
  detected: RegionalFormats,
): RegionalFormats {
  return {
    dateFormat: overrides.dateFormat ?? detected.dateFormat,
    timeFormat: overrides.timeFormat ?? detected.timeFormat,
    weekStart: overrides.weekStart ?? detected.weekStart,
    numberFormat: overrides.numberFormat ?? detected.numberFormat,
    measurementSystem: overrides.measurementSystem ?? detected.measurementSystem,
  };
}

// Formatting --------------------------------------------------------------------------------------

/** The calendar date of `instant` in `timeZone`, numeric, in the chosen order and separators. */
export function formatDate(instant: Date, timeZone: string, format: DateFormat): string {
  const parts = new Intl.DateTimeFormat("en-US-u-nu-latn", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  }).formatToParts(instant);
  const value = (type: "day" | "month" | "year") =>
    parts.find((part) => part.type === type)?.value ?? "";
  const [d, m, y] = [value("day"), value("month"), value("year")];
  switch (format) {
    case "dmy-slash":
      return `${d}/${m}/${y}`;
    case "dmy-dash":
      return `${d}-${m}-${y}`;
    case "dmy-dot":
      return `${d}.${m}.${y}`;
    case "mdy-slash":
      return `${m}/${d}/${y}`;
    case "ymd-dash":
      return `${y}-${m}-${d}`;
  }
}

/** The date as ISO `YYYY-MM-DD` in `timeZone`, for `<time dateTime>`. */
export function isoDate(instant: Date, timeZone: string): string {
  return formatDate(instant, timeZone, "ymd-dash");
}

/** The clock time of `instant` in `timeZone`, with day-period words in the interface language. */
export function formatTime(
  instant: Date,
  timeZone: string,
  format: TimeFormat,
  locale: Locale,
): string {
  return new Intl.DateTimeFormat(`${locale}-u-nu-latn`, {
    hour: format === "24h" ? "2-digit" : "numeric",
    minute: "2-digit",
    hourCycle: format === "24h" ? "h23" : "h12",
    timeZone,
  }).format(instant);
}

/** The weekday name of `instant` in `timeZone`, in the interface language. */
export function formatWeekday(instant: Date, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone }).format(instant);
}

const separators: Readonly<Record<NumberFormat, { group: string; decimal: string }>> = {
  "comma-dot": { group: ",", decimal: "." },
  "dot-comma": { group: ".", decimal: "," },
  // A no-break space, so a number never wraps across lines.
  "space-comma": { group: "\u00a0", decimal: "," },
};

/**
 * Formats a number, optionally with a unit, in the interface language, then applies the chosen
 * group and decimal separators. Digits are always Latin.
 */
export function formatNumber(
  value: number,
  format: NumberFormat,
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
): string {
  const { group, decimal } = separators[format];
  return new Intl.NumberFormat(locale, { ...options, numberingSystem: "latn" })
    .formatToParts(value)
    .map((part) => {
      if (part.type === "group") return group;
      if (part.type === "decimal") return decimal;
      return part.value;
    })
    .join("");
}

const weekdayIndex: Readonly<Record<WeekStart, number>> = { sunday: 0, monday: 1, saturday: 6 };

/** The seven weekday names in display order, starting on `weekStart`. */
export function weekdayNames(
  weekStart: WeekStart,
  locale: Locale,
  width: "short" | "long" = "short",
): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" });
  // 2026-01-04 is a Sunday.
  return Array.from({ length: 7 }, (_, offset) => {
    const day = (weekdayIndex[weekStart] + offset) % 7;
    return formatter.format(new Date(Date.UTC(2026, 0, 4 + day, 12)));
  });
}

/** Representative measurements for the preview, in each system's everyday units. */
export function sampleMeasurements(
  system: MeasurementSystem,
  format: NumberFormat,
  locale: Locale,
): { distance: string; temperature: string; weight: string } {
  const unit = (value: number, name: string) =>
    formatNumber(value, format, locale, { style: "unit", unit: name, maximumFractionDigits: 1 });
  return system === "metric"
    ? {
        distance: unit(5.5, "kilometer"),
        temperature: unit(21, "celsius"),
        weight: unit(1.5, "kilogram"),
      }
    : {
        distance: unit(3.4, "mile"),
        temperature: unit(70, "fahrenheit"),
        weight: unit(3.3, "pound"),
      };
}

/** The sample instant of the settings preview: 31 December 2026, 14:30, shown as UTC. */
export const PREVIEW_INSTANT = new Date(Date.UTC(2026, 11, 31, 14, 30));

export interface RegionalPreview {
  readonly date: string;
  readonly time: string;
  readonly week: string;
  readonly number: string;
  readonly units: string;
}

type Samples<K extends string> = Readonly<Record<K, string>>;

/**
 * Every example the regional settings show, for each option, made on the server. The settings
 * form only looks them up: if the browser formatted them with its own ICU data, small differences
 * (such as the space before "PM") would make its first render differ from the server's.
 */
export interface RegionalSamples {
  readonly date: Samples<DateFormat>;
  readonly time: Samples<TimeFormat>;
  readonly firstDay: Samples<WeekStart>;
  readonly week: Samples<WeekStart>;
  /** A short number for option labels, and a long one for the preview. */
  readonly numberLabel: Samples<NumberFormat>;
  readonly number: Samples<NumberFormat>;
  readonly units: Readonly<Record<MeasurementSystem, Samples<NumberFormat>>>;
}

function samplesOf<K extends string>(keys: readonly K[], make: (key: K) => string): Samples<K> {
  return Object.fromEntries(keys.map((key) => [key, make(key)])) as Record<K, string>;
}

export function regionalSamples(locale: Locale): RegionalSamples {
  const units = (system: MeasurementSystem) =>
    samplesOf(numberFormats, (format) => {
      const { distance, temperature, weight } = sampleMeasurements(system, format, locale);
      return `${distance} · ${temperature} · ${weight}`;
    });
  return {
    date: samplesOf(dateFormats, (format) => formatDate(PREVIEW_INSTANT, "UTC", format)),
    time: samplesOf(timeFormats, (format) => formatTime(PREVIEW_INSTANT, "UTC", format, locale)),
    firstDay: samplesOf(weekStarts, (start) => weekdayNames(start, locale, "long")[0] ?? start),
    week: samplesOf(weekStarts, (start) => weekdayNames(start, locale).join(" ")),
    numberLabel: samplesOf(numberFormats, (format) =>
      formatNumber(1234.5, format, locale, { minimumFractionDigits: 1 }),
    ),
    number: samplesOf(numberFormats, (format) =>
      formatNumber(1234567.89, format, locale, { minimumFractionDigits: 2 }),
    ),
    units: { metric: units("metric"), "us-customary": units("us-customary") },
  };
}

/** The preview for the given formats, looked up in the server-made samples. */
export function regionalPreview(
  samples: RegionalSamples,
  formats: RegionalFormats,
): RegionalPreview {
  return {
    date: samples.date[formats.dateFormat],
    time: samples.time[formats.timeFormat],
    week: samples.week[formats.weekStart],
    number: samples.number[formats.numberFormat],
    units: samples.units[formats.measurementSystem][formats.numberFormat],
  };
}
