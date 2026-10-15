import { z } from "zod";

/**
 * What a browser may upload (S15; brief defaults, owner may change). The database checks the same
 * limits again (`private.upload_max_bytes`, `private.upload_type_allowed`). Client-safe.
 */
export const avatarUploadTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export type AvatarUploadType = (typeof avatarUploadTypes)[number];

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export function isAvatarUploadType(value: unknown): value is AvatarUploadType {
  return typeof value === "string" && (avatarUploadTypes as readonly string[]).includes(value);
}

export const uploadIntentSchema = z.strictObject({
  purpose: z.literal("avatar"),
  contentType: z.enum(avatarUploadTypes),
  size: z.number().int().min(1).max(AVATAR_MAX_BYTES),
  /** A fresh random id per attempt, so a repeated request opens no second upload. */
  requestId: z.uuid(),
});
export type UploadIntentInput = z.infer<typeof uploadIntentSchema>;

export const avatarChoiceSchema = z.strictObject({
  /** A ready avatar file of the caller's own, or null to remove (global) or inherit (a Home). */
  fileId: z.uuid().nullable(),
});
export type AvatarChoiceInput = z.infer<typeof avatarChoiceSchema>;

export const fileIdSchema = z.uuid();

/** Exactly an empty JSON object: finalize takes no input. */
export const emptyBodySchema = z.strictObject({});
