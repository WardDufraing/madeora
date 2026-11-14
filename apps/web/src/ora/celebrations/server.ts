import "server-only";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { getOraSettings } from "@/ora/server";
import { inQuietHours } from "@/ora/settings";
import type { OraToolContext } from "@/ora/tools/types";
import { getEffectiveTimeZone } from "@/preferences/server";

import { celebrationAnswerSchema, type OraCelebration } from "./types";

export type CelebrationResult =
  | {
      readonly status: "ok";
      readonly celebration: OraCelebration | null;
      /** Held back (quiet hours, unknown settings): ask again later, nothing was claimed. */
      readonly deferred?: true;
    }
  | { readonly status: "unavailable" };

/**
 * The celebration Ora may show now for chore points the person was just awarded in this Home. The
 * database does the claiming (`claim_ora_celebrations`): only the person's own, unreversed awards of
 * the last 15 minutes, each at most once across tabs, devices and retries, none while Ora is off,
 * Quiet is chosen or the celebrations switch is off. Quiet hours are held here, without claiming, so
 * the cheer still appears once they end. Personal space has no points ledger and celebrates nothing.
 */
export async function claimCelebration(context: OraToolContext): Promise<CelebrationResult> {
  if (context.home === null) return { status: "ok", celebration: null };
  const settings = await getOraSettings();
  // Unknown settings (a failed read): say nothing and claim nothing, so nothing is used up.
  if (settings === null) return { status: "ok", celebration: null, deferred: true };
  if (!settings.enabled || !settings.categories.celebrations || settings.frequency === "quiet") {
    return { status: "ok", celebration: null };
  }
  const zone = await getEffectiveTimeZone();
  if (inQuietHours(settings.quietHours, new Date(), zone.timeZone)) {
    return { status: "ok", celebration: null, deferred: true };
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("claim_ora_celebrations", {
    p_home_id: context.home.id,
  });
  if (error) {
    console.error(JSON.stringify({ event: "ora.celebration_claim_failed", code: error.code }));
    return { status: "unavailable" };
  }
  if (data === null) return { status: "ok", celebration: null };
  const parsed = celebrationAnswerSchema.safeParse(data);
  if (!parsed.success) {
    console.error(JSON.stringify({ event: "ora.celebration_answer_invalid" }));
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    celebration: {
      count: parsed.data.count,
      points: parsed.data.points,
      title: parsed.data.count === 1 ? parsed.data.title : null,
    },
  };
}
