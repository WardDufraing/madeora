import { defaultOraPalette, oraPaletteKeys, type OraPaletteKey } from "@madeora/design-tokens";
import { z } from "zod";

import { defaultOraMotion, oraMotionModes, type OraIntroState, type OraMotionMode } from "./types";

/**
 * A person's Ora settings (S45). Client-safe: the forms, the API route and the server reads share
 * this module. The database checks the same values (supabase/migrations/20261206090000_*.sql).
 */

export interface OraSettings {
  /** Hidden and disabled by the person; everything else below is kept while it is off. */
  readonly enabled: boolean;
  /** One personal setting for Personal space and every Home. */
  readonly motion: OraMotionMode;
  readonly intro: OraIntroState;
  /** The colour in Personal space. */
  readonly personalPalette: OraPaletteKey;
  /** The colour chosen in each Home; a Home without an entry uses Heather. */
  readonly homePalettes: Readonly<Record<string, OraPaletteKey>>;
}

export const defaultOraSettings: OraSettings = {
  enabled: true,
  motion: defaultOraMotion,
  intro: null,
  personalPalette: defaultOraPalette,
  homePalettes: {},
};

const paletteSchema = z.enum(oraPaletteKeys);

/** A change to the signed-in person's own settings; only the fields sent change. */
export const oraPatchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    motion: z.enum(oraMotionModes).optional(),
    intro: z.enum(["completed", "skipped"]).optional(),
    personalPalette: paletteSchema.optional(),
    homePalette: z.strictObject({ homeId: z.uuid(), palette: paletteSchema }).optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    error: "empty",
  });

export type OraPatch = z.infer<typeof oraPatchSchema>;

/** The palette in force for one place: the Home's colour, or Personal's, or Heather. */
export function paletteFor(settings: OraSettings, homeId: string | null): OraPaletteKey {
  if (homeId === null) return settings.personalPalette;
  return settings.homePalettes[homeId] ?? defaultOraPalette;
}
