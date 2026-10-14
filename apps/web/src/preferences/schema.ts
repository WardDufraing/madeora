import { z } from "zod";

import { isLocale, locales, type Locale } from "@/i18n/locales";

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
};

/** Error message keys, translated in the `Settings` namespace. */
export type DisplayNameError = "displayNameTooLong" | "displayNameInvalid";

// At least one letter, digit, symbol (emoji included) or punctuation mark, so a name can never be
// made only of invisible characters (zero-width spaces, fillers, lone combining marks).
const visibleCharacter = /[\p{L}\p{N}\p{S}\p{P}]/u;
// Hangul fillers count as letters but show nothing.
const fillers = /[\u115F\u1160\u3164\uFFA0]/gu;

// Control characters, line and paragraph separators, and the direction marks, overrides and
// isolates that could make a name look like someone else's. Zero-width joiners stay allowed: emoji
// sequences need them. The database's check constraint lists exactly the same code points.
const forbiddenInName =
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/u;

/**
 * A display name as typed: NFC-normalized and trimmed. An empty result clears the name (`null`).
 * Length counts characters (code points), as the database does, not bytes.
 */
export const displayNameSchema = z
  .string()
  .max(1000, { error: "displayNameTooLong" satisfies DisplayNameError })
  .transform((value) => value.normalize("NFC").trim())
  .refine((value) => Array.from(value).length <= DISPLAY_NAME_MAX_LENGTH, {
    error: "displayNameTooLong" satisfies DisplayNameError,
  })
  .refine((value) => !forbiddenInName.test(value), {
    error: "displayNameInvalid" satisfies DisplayNameError,
  })
  .refine((value) => value === "" || visibleCharacter.test(value.replace(fillers, "")), {
    error: "displayNameInvalid" satisfies DisplayNameError,
  })
  .transform((value) => (value === "" ? null : value));

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
  };
}
