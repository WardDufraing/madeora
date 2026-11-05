import { z } from "zod";

/**
 * The photos contract (S35, versioned for later mobile clients). Client-safe. Every limit matches the
 * database (`private.photo_limit`, `private.upload_max_bytes`, `private.upload_type_allowed` in
 * supabase/migrations/*_photos.sql), which checks everything again. The formats and sizes are the
 * owner's decision of S35 (recorded in the S35 brief).
 */
export const photoUploadTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
] as const;
export type PhotoUploadType = (typeof photoUploadTypes)[number];

export function isPhotoUploadType(value: unknown): value is PhotoUploadType {
  return typeof value === "string" && (photoUploadTypes as readonly string[]).includes(value);
}

export const PHOTO_LIMITS = {
  /** One upload, as the browser sends it. */
  uploadBytes: 25 * 1024 * 1024,
  /** Refused from the header before any pixel is decoded. */
  maxPixels: 50_000_000,
  maxSide: 12_000,
  /** The long side of what is stored: an optimized master and three derivatives, all WebP. */
  masterSide: 2560,
  fullSide: 1920,
  displaySide: 1024,
  thumbSide: 320,
  albumName: 80,
  albumsPerOwner: 200,
  photosPerAlbum: 2000,
  page: 60,
  maxOffset: 100_000,
  batch: 100,
} as const;

export const photoVariants = ["master", "full", "display", "thumb"] as const;
export type PhotoVariant = (typeof photoVariants)[number];

export const photoOwnerSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("personal") }),
  z.strictObject({ scope: z.literal("home"), homeId: z.uuid() }),
]);
export type PhotoOwnerInput = z.infer<typeof photoOwnerSchema>;

export const photoUploadIntentSchema = z.strictObject({
  owner: photoOwnerSchema,
  contentType: z.enum(photoUploadTypes),
  size: z.number().int().min(1).max(PHOTO_LIMITS.uploadBytes),
  /** A fresh random id per attempt, so a repeated request opens no second upload. */
  requestId: z.uuid(),
});
export type PhotoUploadIntentInput = z.infer<typeof photoUploadIntentSchema>;

/** An album name: one line, trimmed, not blank. */
export const albumNameSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1).max(PHOTO_LIMITS.albumName));

export const createAlbumSchema = z.strictObject({
  id: z.uuid(),
  owner: photoOwnerSchema,
  name: albumNameSchema,
});
export type CreateAlbumInput = z.infer<typeof createAlbumSchema>;

export const renameAlbumSchema = z.strictObject({
  name: albumNameSchema,
  expectedRevision: z.number().int().min(1),
});

export const deleteAlbumSchema = z.strictObject({ expectedRevision: z.number().int().min(1) });

export const albumPhotosSchema = z.strictObject({
  photoIds: z.array(z.uuid()).min(1).max(PHOTO_LIMITS.batch),
});
export type AlbumPhotosInput = z.infer<typeof albumPhotosSchema>;

export const photoListQuerySchema = z.strictObject({
  scope: z.enum(["personal", "home"]),
  homeId: z.uuid().optional(),
  albumId: z.uuid().optional(),
  offset: z.coerce.number().int().min(0).max(PHOTO_LIMITS.maxOffset).default(0),
});
export type PhotoListQuery = z.infer<typeof photoListQuerySchema>;

export const photoVariantSchema = z.enum(photoVariants);

/** Photo ids to delete: each goes to the trash and counts against storage for seven days. */
export const deletePhotosSchema = z.strictObject({
  photoIds: z.array(z.uuid()).min(1).max(PHOTO_LIMITS.batch),
});

export const photoFinalizeSchema = z.strictObject({});
