import "server-only";

import { isHomeRole } from "@madeora/domain/permissions";
import { cache } from "react";

import { parseAccentColor } from "@/accent/accent";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";
import { optionalNameSchema } from "@/preferences/schema";

import type { DirectoryMember } from "./directory-view";

export type HomeDirectory =
  | { readonly status: "ok"; readonly members: readonly DirectoryMember[] }
  /** Not a current member, or no such Home: deliberately indistinguishable. */
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

function nameOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = optionalNameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The current members of `homeId` with what every member may see (S11), read through
 * `public.home_directory` with the person's own session: the function itself refuses anyone who
 * is not a current member of that Home. Names are re-checked on the way out, so a value that
 * slipped past an older rule shows as "no name" rather than as invisible text. Cached for this
 * request only.
 */
export const getHomeDirectory = cache(async (homeId: string): Promise<HomeDirectory> => {
  const parsedId = homeIdSchema.safeParse(homeId);
  if (!parsedId.success) return { status: "not-found" };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("home_directory", { p_home_id: parsedId.data });
  if (error?.code === "42501") return { status: "not-found" };
  if (error) {
    console.error(JSON.stringify({ event: "home_directory.read_failed", code: error.code }));
    return { status: "unavailable" };
  }
  const members = data.flatMap((row): DirectoryMember[] =>
    isHomeRole(row.role)
      ? [
          {
            membershipId: row.membership_id,
            role: row.role,
            joinedAt: row.joined_at,
            isSelf: row.is_self,
            name: nameOrNull(row.name),
            accentColor: parseAccentColor(row.accent_color),
            avatarFileId: row.avatar_file_id,
          },
        ]
      : [],
  );
  return { status: "ok", members };
});
