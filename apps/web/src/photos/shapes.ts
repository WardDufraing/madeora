import { z } from "zod";

/**
 * The shapes the photo reads answer with (S35), checked on the server before anything is shown, so a
 * database change cannot reach the interface unnoticed. Client-safe.
 */

export const photoSchema = z.object({
  id: z.uuid(),
  width: z.int().positive(),
  height: z.int().positive(),
  createdAt: z.string(),
  canDelete: z.boolean(),
});
export type Photo = z.output<typeof photoSchema>;

export const albumSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  revision: z.int().positive(),
  photoCount: z.int().nonnegative(),
  coverPhotoId: z.uuid().nullable(),
  canEdit: z.boolean(),
});
export type Album = z.output<typeof albumSchema>;

export const libraryPageSchema = z.object({
  homeId: z.uuid().nullable(),
  canUpload: z.boolean(),
  canManage: z.boolean(),
  albumId: z.uuid().nullable(),
  albumName: z.string().nullable(),
  total: z.int().nonnegative(),
  photos: z.array(photoSchema),
  albums: z.array(albumSchema),
});
export type LibraryPage = z.output<typeof libraryPageSchema>;

export const photoDetailSchema = photoSchema.extend({
  homeId: z.uuid().nullable(),
  albums: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type PhotoDetail = z.output<typeof photoDetailSchema>;
