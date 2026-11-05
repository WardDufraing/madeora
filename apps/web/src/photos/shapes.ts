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
  /** In an album: whether the viewer may take it out of this album (S36). */
  canRemove: z.boolean().optional(),
});
export type Photo = z.output<typeof photoSchema>;

export const albumSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  revision: z.int().positive(),
  photoCount: z.int().nonnegative(),
  coverPhotoId: z.uuid().nullable(),
  canEdit: z.boolean(),
  /** How many Homes the album is shared with (S36). */
  shareCount: z.int().nonnegative(),
});
export type Album = z.output<typeof albumSchema>;

/** The selected album and what the viewer may do in it (S36). */
export const albumDetailSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  revision: z.int().positive(),
  /** Whether the album belongs to the library of this page (not shared into it). */
  owned: z.boolean(),
  /** The Home that owns the album; null for a personal album. */
  ownerHomeName: z.string().nullable(),
  access: z.enum(["edit", "contribute", "view"]),
  canContribute: z.boolean(),
  canShare: z.boolean(),
  canRemoveShare: z.boolean(),
  shareCount: z.int().nonnegative(),
  /** Only for those who may change sharing. */
  shares: z.array(
    z.object({ homeId: z.uuid(), homeName: z.string(), access: z.enum(["view", "contribute"]) }),
  ),
});
export type AlbumDetail = z.output<typeof albumDetailSchema>;

/** An album of another library shared with this Home (S36). */
export const sharedAlbumSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  access: z.enum(["view", "contribute"]),
  ownerHomeName: z.string().nullable(),
  photoCount: z.int().nonnegative(),
});
export type SharedAlbum = z.output<typeof sharedAlbumSchema>;

/** An album the viewer may add this library's photos to (S36). */
export const albumTargetSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  ownerHomeName: z.string().nullable(),
  /** People outside this library will see what is added: the viewer is told first. */
  shared: z.boolean(),
});
export type AlbumTarget = z.output<typeof albumTargetSchema>;

export const libraryPageSchema = z.object({
  homeId: z.uuid().nullable(),
  canUpload: z.boolean(),
  canManage: z.boolean(),
  albumId: z.uuid().nullable(),
  albumName: z.string().nullable(),
  total: z.int().nonnegative(),
  photos: z.array(photoSchema),
  albums: z.array(albumSchema),
  album: albumDetailSchema.nullable(),
  sharedAlbums: z.array(sharedAlbumSchema),
  targets: z.array(albumTargetSchema),
});
export type LibraryPage = z.output<typeof libraryPageSchema>;

export const photoDetailSchema = photoSchema.extend({
  homeId: z.uuid().nullable(),
  albums: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type PhotoDetail = z.output<typeof photoDetailSchema>;

/** What deleting photos from their library would affect (S36), without names the viewer cannot see. */
export const deletionImpactShape = z.object({
  deletable: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  libraries: z.array(z.object({ personal: z.boolean(), homeName: z.string().nullable() })),
  albums: z.array(z.string()),
  otherAlbums: z.boolean(),
  sharedHomes: z.array(z.string()),
  otherHomes: z.boolean(),
});
export type DeletionImpact = z.output<typeof deletionImpactShape>;

/** The photos a widget shows to this viewer now (S36). */
export const widgetPhotosShape = z.object({
  available: z.boolean(),
  photos: z.array(
    z.object({ id: z.uuid(), width: z.int().positive(), height: z.int().positive() }),
  ),
  missing: z.int().nonnegative(),
});
export type WidgetPhotos = z.output<typeof widgetPhotosShape>;
