import "server-only";

import type { Tables } from "@madeora/database";
import { cache } from "react";

import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";

import {
  noHomeProfileOverrides,
  parseHomeProfile,
  type HomeProfileOverrides,
  type HomeProfilePatch,
} from "./profile-schema";

/** The columns the app reads and writes; the keys and timestamps belong to the database. */
export const HOME_PROFILE_COLUMNS = "nickname, display_name, accent_color";

type HomeProfileRow = Pick<
  Tables<"home_member_profiles">,
  "nickname" | "display_name" | "accent_color"
>;

export function homeProfileFromRow(row: HomeProfileRow): HomeProfileOverrides {
  return parseHomeProfile({
    nickname: row.nickname,
    displayName: row.display_name,
    accentColor: row.accent_color,
  });
}

/** The database columns for a validated change; only the fields present in the change. */
export function homeProfilePatchToColumns(patch: HomeProfilePatch): Partial<HomeProfileRow> {
  const columns: { -readonly [K in keyof HomeProfileRow]?: HomeProfileRow[K] } = {};
  if (patch.nickname !== undefined) columns.nickname = patch.nickname;
  if (patch.displayName !== undefined) columns.display_name = patch.displayName;
  if (patch.accentColor !== undefined) columns.accent_color = patch.accentColor;
  return columns;
}

export type MyHomeProfile =
  | { readonly status: "ok"; readonly overrides: HomeProfileOverrides }
  /** The row could not be read (database unreachable). */
  | { readonly status: "unavailable" };

/**
 * The signed-in person's own presentation in `homeId`, read with their own session so RLS returns
 * it only while they are a member. No row means everything is inherited. Call it only after the
 * membership was checked (`getHomeContext`); for anyone else it returns the defaults. Cached for
 * this request only.
 */
export const getMyHomeProfile = cache(async (homeId: string): Promise<MyHomeProfile> => {
  const parsedId = homeIdSchema.safeParse(homeId);
  const identity = await getVerifiedIdentity();
  if (!parsedId.success || !identity) {
    return { status: "ok", overrides: noHomeProfileOverrides };
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("home_member_profiles")
    .select(HOME_PROFILE_COLUMNS)
    .eq("home_id", parsedId.data)
    .eq("user_id", identity.userId)
    .maybeSingle();
  if (error) {
    // Privacy-safe: the error code only, no account or Home ids.
    console.error(JSON.stringify({ event: "home_profile.read_failed", code: error.code }));
    return { status: "unavailable" };
  }
  return { status: "ok", overrides: data ? homeProfileFromRow(data) : noHomeProfileOverrides };
});
