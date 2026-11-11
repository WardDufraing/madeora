import { z } from "zod";

import { COPY_ITEM_TYPES } from "./catalogue";

/**
 * Bodies of the copy endpoints (S40 part 2). Client-safe; the server validates again and the
 * database decides every Home on its own.
 */
export const copyRequestSchema = z.strictObject({
  itemType: z.enum(COPY_ITEM_TYPES),
  itemId: z.uuid(),
  homeIds: z
    .array(z.uuid())
    .min(1)
    .max(50)
    .refine((value) => new Set(value).size === value.length, { message: "duplicate" }),
});
export type CopyRequestInput = z.infer<typeof copyRequestSchema>;

export const copyDecisionSchema = z.strictObject({ approve: z.boolean() });
export type CopyDecisionInput = z.infer<typeof copyDecisionSchema>;
