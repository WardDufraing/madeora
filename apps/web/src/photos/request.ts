import { PHOTOS_DELETE_ENDPOINT, albumEndpoint, PHOTO_ALBUMS_ENDPOINT } from "./api";

/** Why a photo or album change did not happen, for the interface to translate. */
export type PhotoRequestFailure =
  | "signedOut"
  | "notPermitted"
  | "notFound"
  | "conflict"
  | "limit"
  | "invalid"
  | "network"
  | "failed";

export class PhotoRequestError extends Error {
  constructor(readonly failure: PhotoRequestFailure) {
    super(`Photo request failed: ${failure}`);
    this.name = "PhotoRequestError";
  }
}

async function send<T>(method: string, url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new PhotoRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code =
      payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    switch (code) {
      case "unauthenticated":
        throw new PhotoRequestError("signedOut");
      case "not-permitted":
        throw new PhotoRequestError("notPermitted");
      case "not-found":
        throw new PhotoRequestError("notFound");
      case "conflict":
        throw new PhotoRequestError("conflict");
      case "limit-reached":
        throw new PhotoRequestError("limit");
      case "invalid":
        throw new PhotoRequestError("invalid");
      default:
        throw new PhotoRequestError("failed");
    }
  }
  return payload as T;
}

export interface DeleteResult {
  readonly deleted: number;
  readonly skipped: number;
}

export const deletePhotos = (photoIds: readonly string[]) =>
  send<DeleteResult>("POST", PHOTOS_DELETE_ENDPOINT, { photoIds });

export const createAlbum = (
  id: string,
  owner: { readonly scope: "personal" } | { readonly scope: "home"; readonly homeId: string },
  name: string,
) => send<{ id: string }>("POST", PHOTO_ALBUMS_ENDPOINT, { id, owner, name });

export const renameAlbum = (albumId: string, name: string, expectedRevision: number) =>
  send<{ revision: number }>("PATCH", albumEndpoint(albumId), { name, expectedRevision });

export const deleteAlbum = (albumId: string, expectedRevision: number) =>
  send<object>("DELETE", albumEndpoint(albumId), { expectedRevision });

export const addToAlbum = (albumId: string, photoIds: readonly string[]) =>
  send<{ added: number }>("POST", albumEndpoint(albumId, "photos"), { photoIds });

export const removeFromAlbum = (albumId: string, photoIds: readonly string[]) =>
  send<{ removed: number }>("DELETE", albumEndpoint(albumId, "photos"), { photoIds });
