import "server-only";

import { isOraPaletteKey, type OraPaletteKey } from "@madeora/design-tokens";
import { cache } from "react";

import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";

import { defaultOraSettings, type OraSettings } from "./settings";
import { isOraMotionMode } from "./types";

/**
 * The signed-in person's Ora settings, read with their own session (RLS limits every row to
 * them). Rows are per request and never cached across people. If they cannot be read the
 * result is `null`: Ora stays hidden (the person may have disabled it) and the page is unaffected.
 */
export const getOraSettings = cache(async (): Promise<OraSettings | null> => {
  const identity = await getVerifiedIdentity();
  if (!identity) return null;
  const supabase = await createSupabaseServerClient();
  const [own, homes] = await Promise.all([
    supabase
      .from("ora_preferences")
      .select("enabled, motion, intro, personal_palette")
      .eq("user_id", identity.userId)
      .maybeSingle(),
    supabase.from("ora_home_palettes").select("home_id, palette").eq("user_id", identity.userId),
  ]);
  if (own.error || homes.error) {
    console.error(
      JSON.stringify({
        event: "ora.settings_read_failed",
        code: (own.error ?? homes.error)?.code ?? null,
      }),
    );
    // Unknown whether the person disabled Ora: stay hidden rather than show it against their
    // choice. The settings page still opens (with defaults) so it can be changed.
    return null;
  }
  const homePalettes: Record<string, OraPaletteKey> = {};
  for (const row of homes.data) {
    if (isOraPaletteKey(row.palette)) homePalettes[row.home_id] = row.palette;
  }
  const row = own.data;
  if (!row) return { ...defaultOraSettings, homePalettes };
  return {
    enabled: row.enabled,
    motion: isOraMotionMode(row.motion) ? row.motion : defaultOraSettings.motion,
    intro: row.intro === "completed" || row.intro === "skipped" ? row.intro : null,
    personalPalette: isOraPaletteKey(row.personal_palette)
      ? row.personal_palette
      : defaultOraSettings.personalPalette,
    homePalettes,
  };
});
