import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";

/** A paired Household Display as its Home's managers see it (S43). */
export interface HouseholdDisplay {
  readonly id: string;
  readonly name: string;
  readonly status: "active" | "revoked";
  readonly deviceKind: string;
  readonly browser: string;
  readonly platform: string;
  readonly pairedByMembershipId: string | null;
  readonly pairedAt: string;
  readonly lastSeenAt: string | null;
  readonly revokedAt: string | null;
}

/** The Home's displays, for its managers; `null` for anyone else (the database decides). */
export const getHouseholdDisplays = cache(
  async (homeId: string): Promise<readonly HouseholdDisplay[] | null> => {
    if (!homeIdSchema.safeParse(homeId).success) return null;
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("home_household_displays", { p_home_id: homeId });
    if (error) {
      if (error.code !== "42501") {
        console.error(
          JSON.stringify({ event: "household_displays.read_failed", code: error.code }),
        );
      }
      return null;
    }
    return data.map((row) => ({
      id: row.display_id,
      name: row.name,
      status: row.status === "active" ? "active" : "revoked",
      deviceKind: row.device_kind,
      browser: row.browser,
      platform: row.platform,
      pairedByMembershipId: row.paired_by_membership_id,
      pairedAt: row.paired_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
    }));
  },
);

export interface DisplaySession {
  readonly displayId: string;
  readonly displayName: string;
  readonly homeName: string;
  readonly homeTimezone: string;
}

/**
 * This request's display session (`public.display_me`): `ok` with what the screen may show,
 * `refused` when the database no longer accepts it (revoked, Home closed, not registered), or
 * `unavailable` when it cannot be asked now (the screen then stays harmless and retries).
 */
export type DisplaySessionResult =
  | { readonly kind: "ok"; readonly session: DisplaySession }
  | { readonly kind: "refused" }
  | { readonly kind: "unavailable" };

const REFUSED_CODES = new Set(["42501", "PT401", "PT403", "PGRST301", "PGRST303"]);

export const getDisplaySession = cache(async (): Promise<DisplaySessionResult> => {
  const supabase = await createSupabaseServerClient();
  const { data, error, status } = await supabase.rpc("display_me");
  if (error) {
    if (status === 401 || status === 403 || REFUSED_CODES.has(error.code)) {
      return { kind: "refused" };
    }
    console.error(JSON.stringify({ event: "display_session.read_failed", code: error.code }));
    return { kind: "unavailable" };
  }
  const row = data[0];
  if (!row) return { kind: "refused" };
  return {
    kind: "ok",
    session: {
      displayId: row.display_id,
      displayName: row.display_name,
      homeName: row.home_name,
      homeTimezone: row.home_timezone,
    },
  };
});
