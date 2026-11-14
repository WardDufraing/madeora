import { defaultOraPalette, oraPaletteKeys, type OraPaletteKey } from "@madeora/design-tokens";
import { z } from "zod";

import { defaultOraMotion, oraMotionModes, type OraIntroState, type OraMotionMode } from "./types";

/**
 * A person's Ora settings (S45). Client-safe: the forms, the API route and the server reads share
 * this module. The database checks the same values (supabase/migrations/20261206090000_*.sql).
 */

export const oraFrequencies = ["quiet", "balanced", "active"] as const;
export type OraFrequency = (typeof oraFrequencies)[number];

export interface OraCategories {
  readonly reminders: boolean;
  readonly suggestions: boolean;
  readonly celebrations: boolean;
}

/** `HH:MM`, 24-hour, in the person's own time zone. */
export interface OraQuietHours {
  readonly start: string;
  readonly end: string;
}

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export interface OraSettings {
  /** Hidden and disabled by the person; everything else below is kept while it is off. */
  readonly enabled: boolean;
  /** One personal setting for Personal space and every Home. */
  readonly motion: OraMotionMode;
  readonly intro: OraIntroState;
  /** No unsolicited teasers, in every Home, until the person turns them back on (S47). */
  readonly teasersMuted: boolean;
  /** How often Ora may bring things up on its own (S47b). */
  readonly frequency: OraFrequency;
  /** Switches for what Ora may raise unprompted; off suppresses that kind everywhere. */
  readonly categories: OraCategories;
  /** Quiet hours in the person's own time, or null. May cross midnight. */
  readonly quietHours: OraQuietHours | null;
  /** The colour in Personal space. */
  readonly personalPalette: OraPaletteKey;
  /** The colour chosen in each Home; a Home without an entry uses Heather. */
  readonly homePalettes: Readonly<Record<string, OraPaletteKey>>;
}

export const defaultOraSettings: OraSettings = {
  enabled: true,
  motion: defaultOraMotion,
  intro: null,
  teasersMuted: false,
  frequency: "balanced",
  categories: { reminders: true, suggestions: true, celebrations: true },
  quietHours: null,
  personalPalette: defaultOraPalette,
  homePalettes: {},
};

export function isOraFrequency(value: string): value is OraFrequency {
  return (oraFrequencies as readonly string[]).includes(value);
}

const paletteSchema = z.enum(oraPaletteKeys);

/** A change to the signed-in person's own settings; only the fields sent change. */
export const oraPatchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    motion: z.enum(oraMotionModes).optional(),
    intro: z.enum(["completed", "skipped"]).optional(),
    teasersMuted: z.boolean().optional(),
    frequency: z.enum(oraFrequencies).optional(),
    categories: z
      .strictObject({
        reminders: z.boolean().optional(),
        suggestions: z.boolean().optional(),
        celebrations: z.boolean().optional(),
      })
      .optional(),
    /** `null` turns quiet hours off; a window needs two different times. */
    quietHours: z
      .strictObject({ start: timeSchema, end: timeSchema })
      .refine((window) => window.start !== window.end, { error: "empty window" })
      .nullable()
      .optional(),
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

/**
 * Whether `now` (a `Date`) is inside the quiet hours when read in `timeZone`. A window that ends
 * before it starts crosses midnight (22:00 to 07:00). The start is inside, the end is outside.
 */
export function inQuietHours(quiet: OraQuietHours | null, now: Date, timeZone: string): boolean {
  if (quiet === null) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const at = minute(parts);
  const start = minute(quiet.start);
  const end = minute(quiet.end);
  return start < end ? at >= start && at < end : at >= start || at < end;
}
