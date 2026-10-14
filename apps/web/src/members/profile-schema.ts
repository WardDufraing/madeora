import { z } from "zod";

import { accentColorSchema, parseAccentColor, type AccentColor } from "@/accent/accent";
import { optionalNameSchema } from "@/preferences/schema";

/**
 * A member's own presentation in one Home (S11; spec "Confirmed global adult avatar and display
 * name with per-Home overrides", "Confirmed optional per-Home nicknames", "Confirmed personal accent
 * color with per-Home overrides"). Each field is optional; `null` means "inherit". The database
 * checks the same rules (supabase/migrations/20261018090000_member_profiles.sql). Client-safe.
 */
export interface HomeProfileOverrides {
  /** The preferred label in this Home; wins over every other name. */
  readonly nickname: string | null;
  /** This Home's version of the global display name. */
  readonly displayName: string | null;
  /** The colour that identifies this member here; else the global accent. */
  readonly accentColor: AccentColor | null;
}

export const noHomeProfileOverrides: HomeProfileOverrides = {
  nickname: null,
  displayName: null,
  accentColor: null,
};

/**
 * `PATCH /api/v1/homes/{homeId}/profile`: some of the three fields. `null` (or an empty name)
 * resets that field to inherit; fields not sent stay as they are, so each saves on its own.
 */
export const homeProfilePatchSchema = z
  .strictObject({
    nickname: z.union([z.null(), optionalNameSchema]).optional(),
    displayName: z.union([z.null(), optionalNameSchema]).optional(),
    accentColor: accentColorSchema.nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { error: "empty" });

export type HomeProfilePatchInput = z.input<typeof homeProfilePatchSchema>;
export type HomeProfilePatch = z.output<typeof homeProfilePatchSchema>;

/** Reads a stored or returned profile defensively: anything unexpected counts as "inherit". */
export function parseHomeProfile(value: Readonly<Record<string, unknown>>): HomeProfileOverrides {
  const name = (field: unknown) => {
    if (typeof field !== "string") return null;
    const parsed = optionalNameSchema.safeParse(field);
    return parsed.success ? parsed.data : null;
  };
  return {
    nickname: name(value.nickname),
    displayName: name(value.displayName),
    accentColor: parseAccentColor(value.accentColor),
  };
}

export type HomeNameSource = "nickname" | "homeName" | "global" | "none";

/**
 * The single name other members see in this Home, and where it comes from: the nickname, else the
 * Home display name, else the global display name. `none` when the person has no name at all.
 */
export function effectiveHomeName(
  overrides: Pick<HomeProfileOverrides, "nickname" | "displayName">,
  globalName: string | null,
): { readonly name: string | null; readonly source: HomeNameSource } {
  if (overrides.nickname !== null) return { name: overrides.nickname, source: "nickname" };
  if (overrides.displayName !== null) return { name: overrides.displayName, source: "homeName" };
  if (globalName !== null) return { name: globalName, source: "global" };
  return { name: null, source: "none" };
}
