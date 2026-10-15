import { delegableCapabilities } from "@madeora/domain/permissions";
import { z } from "zod";

/**
 * Client-safe request schemas for managing members (S12): role changes, Administrator
 * capabilities, removal and ownership transfer. The server parses every body with these again and
 * the database functions re-check everything under a lock.
 */

/** The roles a role change can set. Never Owner: ownership changes only through a transfer. */
export const assignableRoles = ["member", "administrator"] as const;
export type AssignableRole = (typeof assignableRoles)[number];

/** Every role a member can have now, as the remover saw it (used to detect stale confirmations). */
const currentRole = z.enum(["owner", "administrator", "member"]);

export const roleChangeSchema = z.strictObject({
  role: z.enum(assignableRoles),
  /** The target's role when the Owner opened the confirmation; a change meanwhile is refused. */
  expectedRole: z.enum(assignableRoles),
});
export type RoleChangeInput = z.infer<typeof roleChangeSchema>;

export const capabilitiesSchema = z.strictObject({
  capabilities: z
    .array(z.enum(delegableCapabilities))
    .max(delegableCapabilities.length)
    .refine((list) => new Set(list).size === list.length, { message: "duplicate" }),
});
export type CapabilitiesInput = z.infer<typeof capabilitiesSchema>;

export const removalSchema = z.strictObject({ expectedRole: currentRole });
export type RemovalInput = z.infer<typeof removalSchema>;

export const startTransferSchema = z.strictObject({
  membershipId: z.uuid(),
  /** Generated once per confirmation, so a retry returns the same transfer. */
  requestId: z.uuid(),
});
export type StartTransferInput = z.infer<typeof startTransferSchema>;

export const transferActions = ["accept", "decline", "cancel"] as const;
export type TransferAction = (typeof transferActions)[number];

/** How a transfer ends when someone answers it on the banner; the dashboard's `?transfer=` value. */
export const transferAnswers = ["accepted", "declined", "cancelled"] as const;
export type TransferAnswer = (typeof transferAnswers)[number];

export const emptyBodySchema = z.strictObject({});
