import "server-only";

import { cache } from "react";

import { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";

import {
  displayClockFormats,
  displayDensities,
  displayOrientations,
  displayThemes,
  readDisplayLayout,
  type DisplayLayout,
  type DisplayPreferences,
} from "./layout";

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

/** A display's configuration as its Home's managers edit it (S44). */
export interface HouseholdDisplayConfig {
  /** `null`: the default layout. */
  readonly layout: DisplayLayout | null;
  readonly preferences: DisplayPreferences;
  readonly revision: number;
  readonly locked: boolean;
  readonly lockMessage: string | null;
  readonly lockedAt: string | null;
  /** Whether the display has read the latest change (an offline display has not). */
  readonly applied: boolean;
  /** The Home's active shopping lists, for the shopping widget's settings. */
  readonly shoppingLists: readonly { readonly id: string; readonly name: string }[];
}

const configSchema = z.object({
  layout: z.unknown(),
  orientation: z.enum(displayOrientations),
  theme: z.enum(displayThemes),
  density: z.enum(displayDensities),
  clock_format: z.enum(displayClockFormats),
  revision: z.number().int(),
  locked: z.boolean(),
  lock_message: z.string().nullable(),
  locked_at: z.string().nullable(),
  applied: z.boolean(),
  shopping_lists: z.array(z.object({ list_id: z.uuid(), name: z.string() })),
});

/**
 * A display's configuration for its Home's managers: `null` for anyone else, an unknown or revoked
 * display, or when it cannot be read (the database decides who may).
 */
export const getHouseholdDisplayConfig = cache(
  async (homeId: string, displayId: string): Promise<HouseholdDisplayConfig | null> => {
    if (!homeIdSchema.safeParse(homeId).success || !z.uuid().safeParse(displayId).success) {
      return null;
    }
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("household_display_config", {
      p_home_id: homeId,
      p_display_id: displayId,
    });
    if (error) {
      if (error.code !== "42501") {
        console.error(
          JSON.stringify({ event: "household_display_config.read_failed", code: error.code }),
        );
      }
      return null;
    }
    if (data === null) return null;
    const parsed = configSchema.safeParse(data);
    if (!parsed.success) {
      console.error(JSON.stringify({ event: "household_display_config.shape", code: null }));
      return null;
    }
    const row = parsed.data;
    return {
      layout: row.layout === null ? null : readDisplayLayout(row.layout),
      preferences: {
        orientation: row.orientation,
        theme: row.theme,
        density: row.density,
        clockFormat: row.clock_format,
      },
      revision: row.revision,
      locked: row.locked,
      lockMessage: row.lock_message,
      lockedAt: row.locked_at,
      applied: row.applied,
      shoppingLists: row.shopping_lists.map((list) => ({ id: list.list_id, name: list.name })),
    };
  },
);
