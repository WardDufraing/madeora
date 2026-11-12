import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";

/** A child's move to an independent account as one of their guardians sees it (S42 part 3). */
export interface ChildTransitionState {
  readonly open: boolean;
  readonly claimExpiresAt: string | null;
  readonly emailGiven: boolean;
  readonly requiredAge: number;
  readonly canStart: boolean;
}

/** For the child's guardians in this Home only; `null` for anyone else (the database decides). */
export const getChildTransitionState = cache(
  async (homeId: string, membershipId: string): Promise<ChildTransitionState | null> => {
    if (!homeIdSchema.safeParse(homeId).success || !homeIdSchema.safeParse(membershipId).success) {
      return null;
    }
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("child_transition_state", {
      p_home_id: homeId,
      p_child_membership_id: membershipId,
    });
    if (error) {
      if (error.code !== "42501") {
        console.error(JSON.stringify({ event: "child_transition.state_failed", code: error.code }));
      }
      return null;
    }
    const row = data[0];
    if (!row) return null;
    return {
      open: row.open,
      claimExpiresAt: row.open ? row.claim_expires_at : null,
      emailGiven: row.email_given,
      requiredAge: row.required_age,
      canStart: row.can_start,
    };
  },
);
