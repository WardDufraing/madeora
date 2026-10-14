import { z } from "zod";

import { accentColorSchema, parseAccentColor, type AccentColor } from "@/accent/accent";
import { isLocale, locales, type Locale } from "@/i18n/locales";
import { nameProblem, normalizeName } from "@/names/visible-name";

import { normalizeTimeZone } from "./timezone";

/**
 * The account's global preferences (S07): the same on every device and in every Home. The allowed
 * values mirror the check constraints in supabase/migrations/20261014120000_user_preferences.sql;
 * change both together. `null` means "not chosen" for the language and "Automatic" for the
 * formats and the timezone. Client-safe: the settings forms and the API route share it.
 */

export const DISPLAY_NAME_MAX_LENGTH = 50;

export const dateFormats = ["dmy-slash", "dmy-dash", "dmy-dot", "mdy-slash", "ymd-dash"] as const;
export type DateFormat = (typeof dateFormats)[number];

export const timeFormats = ["24h", "12h"] as const;
export type TimeFormat = (typeof timeFormats)[number];

export const weekStarts = ["monday", "saturday", "sunday"] as const;
export type WeekStart = (typeof weekStarts)[number];

export const numberFormats = ["comma-dot", "dot-comma", "space-comma"] as const;
export type NumberFormat = (typeof numberFormats)[number];

export const measurementSystems = ["metric", "us-customary"] as const;
export type MeasurementSystem = (typeof measurementSystems)[number];

export interface RegionalFormats {
  readonly dateFormat: DateFormat;
  readonly timeFormat: TimeFormat;
  readonly weekStart: WeekStart;
  readonly numberFormat: NumberFormat;
  readonly measurementSystem: MeasurementSystem;
}

/** Each regional setting as chosen by the person; `null` is Automatic. */
export type RegionalOverrides = {
  readonly [K in keyof RegionalFormats]: RegionalFormats[K] | null;
};

export const regionalSettings = [
  "dateFormat",
  "timeFormat",
  "weekStart",
  "numberFormat",
  "measurementSystem",
] as const satisfies readonly (keyof RegionalFormats)[];

export const regionalOptions = {
  dateFormat: dateFormats,
  timeFormat: timeFormats,
  weekStart: weekStarts,
  numberFormat: numberFormats,
  measurementSystem: measurementSystems,
} as const satisfies { readonly [K in keyof RegionalFormats]: readonly RegionalFormats[K][] };

export interface StoredPreferences extends RegionalOverrides {
  readonly displayName: string | null;
  readonly locale: Locale | null;
  /** A chosen IANA timezone, or `null` for Automatic (this device's zone). */
  readonly timeZone: string | null;
  /** The global personal accent (S11), or `null` for the default accent. */
  readonly accentColor: AccentColor | null;
}

export const noPreferences: StoredPreferences = {
  displayName: null,
  locale: null,
  dateFormat: null,
  timeFormat: null,
  weekStart: null,
  numberFormat: null,
  measurementSystem: null,
  timeZone: null,
  accentColor: null,
};

/** Error message keys, translated in the `Settings` namespace. */
export type DisplayNameError = "displayNameTooLong" | "displayNameInvalid";

/**
 * An optional name other people see, as typed: a display name, nickname or Home display name.
 * NFC-normalized and trimmed; an empty result clears it (`null`). Otherwise it must pass the
 * visible-name rule (S11; the S09 Home-name policy in `@/names/visible-name`, which the database
 * checks too): no zero-width, direction or padding characters, emoji allowed. Length counts
 * characters (code points), as the database does, not bytes.
 */
export const optionalNameSchema = z
  .string()
  .max(1000, { error: "displayNameTooLong" satisfies DisplayNameError })
  .transform((value, context) => {
    const name = normalizeName(value);
    if (name === "") return null;
    const problem = nameProblem(name, DISPLAY_NAME_MAX_LENGTH);
    if (problem) {
      context.addIssue({
        code: "custom",
        message: (problem === "tooLong"
          ? "displayNameTooLong"
          : "displayNameInvalid") satisfies DisplayNameError,
      });
      return z.NEVER;
    }
    return name;
  });

/** The account's global display name (S07, stricter from S11). */
export const displayNameSchema = optionalNameSchema;

const timeZoneSchema = z
  .string()
  .max(64)
  .transform((value, context) => {
    const zone = normalizeTimeZone(value);
    if (zone === null) {
      context.addIssue({ code: "custom", message: "invalidTimeZone" });
      return z.NEVER;
    }
    return zone;
  });

/** A change to some preferences. Unknown fields are refused; at least one field is required. */
export const preferencesPatchSchema = z
  .strictObject({
    displayName: z.union([z.null(), displayNameSchema]).optional(),
    locale: z.enum(locales).optional(),
    dateFormat: z.enum(dateFormats).nullable().optional(),
    timeFormat: z.enum(timeFormats).nullable().optional(),
    weekStart: z.enum(weekStarts).nullable().optional(),
    numberFormat: z.enum(numberFormats).nullable().optional(),
    measurementSystem: z.enum(measurementSystems).nullable().optional(),
    timeZone: z.union([z.null(), timeZoneSchema]).optional(),
    accentColor: accentColorSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { error: "empty" });

export type PreferencesPatchInput = z.input<typeof preferencesPatchSchema>;
export type PreferencesPatch = z.output<typeof preferencesPatchSchema>;

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/**
 * Reads stored preferences defensively. Anything unexpected (a value written directly through the
 * Data API, or by a newer version of the app) counts as not chosen instead of breaking a page.
 */
export function parseStoredPreferences(
  value: Readonly<Record<string, unknown>>,
): StoredPreferences {
  const name = value.displayName;
  const parsedName = typeof name === "string" ? displayNameSchema.safeParse(name) : null;
  const zone = value.timeZone;
  return {
    displayName: parsedName?.success ? parsedName.data : null,
    locale: isLocale(value.locale) ? value.locale : null,
    dateFormat: oneOf(dateFormats, value.dateFormat),
    timeFormat: oneOf(timeFormats, value.timeFormat),
    weekStart: oneOf(weekStarts, value.weekStart),
    numberFormat: oneOf(numberFormats, value.numberFormat),
    measurementSystem: oneOf(measurementSystems, value.measurementSystem),
    timeZone: typeof zone === "string" ? normalizeTimeZone(zone) : null,
    accentColor: parseAccentColor(value.accentColor),
  };
}
