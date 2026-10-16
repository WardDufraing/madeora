import { z } from "zod";

/**
 * The trash contract (S16, versioned for later mobile clients). Client-safe. The database checks
 * every one of these again (`public.list_trash`, `restore_trash_entries`, ...).
 */

/** Each module step adds its own value here and in the database check constraints. */
export const trashModules = ["sample", "dashboard"] as const;
export type TrashModule = (typeof trashModules)[number];
export const trashItemTypes = ["sample", "dashboard_template"] as const;
export type TrashItemType = (typeof trashItemTypes)[number];

export function isTrashModule(value: unknown): value is TrashModule {
  return typeof value === "string" && (trashModules as readonly string[]).includes(value);
}
export function isTrashItemType(value: unknown): value is TrashItemType {
  return typeof value === "string" && (trashItemTypes as readonly string[]).includes(value);
}

/** What the person may choose to resolve a restore conflict (the database names the options). */
export const trashResolutions = ["clear_slot", "detach_parent"] as const;
export type TrashResolution = (typeof trashResolutions)[number];

/** Same limit as the database (`private.trash_limit('batch')`). */
export const TRASH_BATCH_LIMIT = 100;

const entryId = z.uuid();
const entryIds = z.array(entryId).min(1).max(TRASH_BATCH_LIMIT);

export const restoreSchema = z.strictObject({
  entryIds,
  /** Entry id → the resolution chosen for that entry; only for entries that reported a conflict. */
  resolutions: z.record(entryId, z.enum(trashResolutions)).optional(),
});
export type RestoreInput = z.infer<typeof restoreSchema>;

/** `confirm: true` is the explicit "this cannot be undone" the spec requires before any early delete. */
export const purgeSchema = z.strictObject({
  entryIds,
  confirm: z.literal(true),
});
export type PurgeInput = z.infer<typeof purgeSchema>;

export const emptySchema = z.strictObject({
  /** Null or absent: the personal trash. */
  homeId: z.uuid().nullish(),
  /** When the page that showed the list was loaded: nothing deleted after it is touched. */
  deletedBefore: z.iso.datetime(),
  confirm: z.literal(true),
});
export type EmptyInput = z.infer<typeof emptySchema>;

/** The list filters, as a query string or search params give them. */
export const listQuerySchema = z.strictObject({
  homeId: z.uuid().optional(),
  module: z.enum(trashModules).optional(),
  itemType: z.enum(trashItemTypes).optional(),
  /** Instants (inclusive start, exclusive end) of the deletion-date filter. */
  deletedFrom: z.iso.datetime().optional(),
  deletedTo: z.iso.datetime().optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
