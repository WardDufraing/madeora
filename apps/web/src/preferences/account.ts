import "server-only";

import type { Tables } from "@madeora/database";
import { cache } from "react";

import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";

import {
  noPreferences,
  parseStoredPreferences,
  type PreferencesPatch,
  type StoredPreferences,
} from "./schema";

/** The columns the app reads and writes; created_at and updated_at belong to the database. */
export const PREFERENCE_COLUMNS =
  "display_name, locale, date_format, time_format, week_start, number_format, measurement_system, timezone";

type PreferenceRow = Pick<
  Tables<"user_preferences">,
  | "display_name"
  | "locale"
  | "date_format"
  | "time_format"
  | "week_start"
  | "number_format"
  | "measurement_system"
  | "timezone"
>;

export function preferencesFromRow(row: PreferenceRow): StoredPreferences {
  return parseStoredPreferences({
    displayName: row.display_name,
    locale: row.locale,
    dateFormat: row.date_format,
    timeFormat: row.time_format,
    weekStart: row.week_start,
    numberFormat: row.number_format,
    measurementSystem: row.measurement_system,
    timeZone: row.timezone,
  });
}

export type AccountPreferences =
  | { readonly status: "signed-out" }
  /** The row could not be read (database unreachable, or the migration is missing). */
  | { readonly status: "unavailable" }
  | { readonly status: "ok"; readonly preferences: StoredPreferences };

/**
 * The signed-in account's saved preferences, read with the person's own session so RLS applies.
 * An account that has never saved anything has no row and gets the defaults. Cached for this
 * request only (React `cache`), so the layout, the page and next-intl share one read.
 */
export const getAccountPreferences = cache(async (): Promise<AccountPreferences> => {
  const identity = await getVerifiedIdentity();
  if (!identity) return { status: "signed-out" };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("user_preferences")
    .select(PREFERENCE_COLUMNS)
    .eq("user_id", identity.userId)
    .maybeSingle();
  if (error) {
    // Privacy-safe: the error code only, no account id or values.
    console.error(JSON.stringify({ event: "preferences.read_failed", code: error.code }));
    return { status: "unavailable" };
  }
  return { status: "ok", preferences: data ? preferencesFromRow(data) : noPreferences };
});

/** The saved preferences, or the defaults when signed out or unavailable. */
export async function getStoredPreferences(): Promise<StoredPreferences> {
  const account = await getAccountPreferences();
  return account.status === "ok" ? account.preferences : noPreferences;
}

/** The database columns for a validated change; only the fields present in the change. */
export function patchToColumns(patch: PreferencesPatch): Partial<PreferenceRow> {
  const columns: { -readonly [K in keyof PreferenceRow]?: PreferenceRow[K] } = {};
  if (patch.displayName !== undefined) columns.display_name = patch.displayName;
  if (patch.locale !== undefined) columns.locale = patch.locale;
  if (patch.dateFormat !== undefined) columns.date_format = patch.dateFormat;
  if (patch.timeFormat !== undefined) columns.time_format = patch.timeFormat;
  if (patch.weekStart !== undefined) columns.week_start = patch.weekStart;
  if (patch.numberFormat !== undefined) columns.number_format = patch.numberFormat;
  if (patch.measurementSystem !== undefined) columns.measurement_system = patch.measurementSystem;
  if (patch.timeZone !== undefined) columns.timezone = patch.timeZone;
  return columns;
}
