import type { PhotoVariant } from "./schema";

export type { Album, LibraryPage, Photo, PhotoDetail } from "./shapes";

/**
 * The HTTP contract of photos (S35). Every mutation is same-origin JSON, checked again by the
 * database with the person's own session. Ids of new albums come from the client, so a retry returns
 * the same album. Revision-checked changes answer `409 conflict` when the album changed meanwhile.
 *
 * - `POST /api/v1/photos/upload-intents` `{ owner, contentType, size, requestId }` → `201 { fileId,
 *   uploadUrl, headers, expiresAt }`; the browser PUTs the file, then `POST /api/v1/files/:id/finalize`.
 * - `GET /api/v1/photos?scope=personal|home&homeId=&albumId=&offset=` → `200 { library }`.
 * - `POST /api/v1/photos/delete` `{ photoIds }` → `200 { deleted, skipped }` (to the trash).
 * - `GET /api/v1/photos/:id/content?variant=master|full|display|thumb` → `302` to a 60-second link,
 *   after the database authorizes the viewer again.
 * - `POST /api/v1/photo-albums` `{ id, owner, name }`; `PATCH|DELETE /api/v1/photo-albums/:id`;
 *   `POST|DELETE /api/v1/photo-albums/:id/photos` `{ photoIds }` (add; take out, never delete).
 * - S36: `POST /api/v1/photo-albums/:id/shares` `{ shares: [{ homeId, access }] }` → `200 { shareCount }`;
 *   `DELETE /api/v1/photo-albums/:id/shares` `{ homeId }` ("Remove from this Home", never deletes a
 *   photo); `POST /api/v1/photos/deletion-impact` `{ photoIds }` → `200 { impact }` (changes nothing);
 *   `GET /api/v1/photos/widget?homeId=&albumId=|photoIds=a,b` → `200 { widget }`.
 */
export const PHOTO_UPLOAD_INTENTS_ENDPOINT = "/api/v1/photos/upload-intents";
export const PHOTOS_ENDPOINT = "/api/v1/photos";
export const PHOTOS_DELETE_ENDPOINT = "/api/v1/photos/delete";
export const PHOTO_ALBUMS_ENDPOINT = "/api/v1/photo-albums";
export const PHOTO_DELETION_IMPACT_ENDPOINT = "/api/v1/photos/deletion-impact";
export const PHOTO_WIDGET_ENDPOINT = "/api/v1/photos/widget";

/** The widget read for a context (`homeId` null: personal) and a source. */
export function photoWidgetPath(
  homeId: string | null,
  source: { readonly albumId: string } | { readonly photoIds: readonly string[] },
): string {
  const query = new URLSearchParams();
  if (homeId) query.set("homeId", homeId);
  if ("albumId" in source) query.set("albumId", source.albumId);
  else query.set("photoIds", source.photoIds.join(","));
  return `${PHOTO_WIDGET_ENDPOINT}?${query.toString()}`;
}

export function photoContentPath(photoId: string, variant: PhotoVariant): string {
  return `${PHOTOS_ENDPOINT}/${encodeURIComponent(photoId)}/content?variant=${variant}`;
}

export function albumEndpoint(albumId: string, part?: "photos" | "shares"): string {
  const base = `${PHOTO_ALBUMS_ENDPOINT}/${encodeURIComponent(albumId)}`;
  return part ? `${base}/${part}` : base;
}

/** The page of a library: the person's own, or a Home's; optionally one album and a page offset. */
export function photosPath(
  homeId: string | null,
  options: { readonly albumId?: string | null; readonly offset?: number } = {},
): string {
  const base = homeId ? `/homes/${encodeURIComponent(homeId)}/photos` : "/photos";
  const query = new URLSearchParams();
  if (options.albumId) query.set("album", options.albumId);
  if (options.offset) query.set("offset", String(options.offset));
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}
