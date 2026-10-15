import {
  notificationChannels,
  optionalNotificationCategories,
} from "@madeora/domain/notifications";
import { z } from "zod";

import { normalizeTimeZone } from "@/preferences/timezone";

/**
 * The bodies of the notification endpoints (S14), shared by the routes and the settings forms so
 * both refuse the same things. The database validates again (categories, channels, zones, times).
 */

/** `null`: the account's defaults; an id: an override for that Home. */
const scope = z.uuid().nullable();

export const timeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const preferenceSchema = z.strictObject({
  homeId: scope,
  category: z.enum(optionalNotificationCategories),
  channel: z.enum(notificationChannels),
  enabled: z.boolean(),
});
export type PreferenceInput = z.infer<typeof preferenceSchema>;

export const resetPreferenceSchema = preferenceSchema.omit({ enabled: true });
export type ResetPreferenceInput = z.infer<typeof resetPreferenceSchema>;

export const quietHoursSchema = z
  .strictObject({
    homeId: scope,
    enabled: z.boolean(),
    start: timeOfDay,
    end: timeOfDay,
    timeZone: z.string().refine((zone) => normalizeTimeZone(zone) !== null),
  })
  .refine((value) => value.start !== value.end, { path: ["end"] });
export type QuietHoursInput = z.infer<typeof quietHoursSchema>;

export const resetQuietHoursSchema = z.strictObject({ homeId: scope });
export type ResetQuietHoursInput = z.infer<typeof resetQuietHoursSchema>;

/** At most 100 ids at a time, as the database function allows; `all` marks everything read. */
export const markReadSchema = z.union([
  z.strictObject({ ids: z.array(z.uuid()).min(1).max(100) }),
  z.strictObject({ all: z.literal(true) }),
]);
export type MarkReadInput = z.infer<typeof markReadSchema>;
