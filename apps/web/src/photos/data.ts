import "server-only";

import type { z } from "zod";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import { logPhotos } from "./log";
import { PHOTO_LIMITS } from "./schema";
import { libraryPageSchema, photoDetailSchema, type LibraryPage, type PhotoDetail } from "./shapes";

/**
 * Server reads of photo libraries (S35), always with the signed-in person's own Supabase session:
 * the database answers only what they may see now, and a library, album or photo they may not see is
 * "not found", exactly like one that does not exist. Every answer is checked against its shape;
 * nothing is cached across requests (personalized data, architecture.md §9).
 */

export type Read<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "not-found" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501") return { status: "not-found" };
  if (error.code === "22023" || error.code === "22P02") return { status: "invalid" };
  logPhotos(event, error.code);
  return { status: "unavailable" };
}

function parsed<S extends z.ZodType>(event: string, schema: S, data: unknown): Read<z.output<S>> {
  if (data === null) return { status: "not-found" };
  const result = schema.safeParse(data);
  if (!result.success) {
    logPhotos(event, "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: result.data };
}

/** One page of a library (a Home's when `homeId` is given), or of one album in it. */
export async function readLibrary(
  homeId: string | null,
  albumId: string | null,
  offset: number,
): Promise<Read<LibraryPage>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_photo_library", {
    // The generated types read every parameter as required; null means the personal library / no album.
    p_home_id: homeId as string,
    p_album_id: albumId as string,
    p_offset: Math.min(Math.max(0, Math.trunc(offset)), PHOTO_LIMITS.maxOffset),
  });
  if (error) return failed("photos.library_failed", error);
  return parsed("photos.library_failed", libraryPageSchema, data);
}

/** One photo with its albums; not found when the person may not see it. */
export async function readPhoto(photoId: string): Promise<Read<PhotoDetail>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_photo", { p_photo_id: photoId });
  if (error) return failed("photos.read_failed", error);
  return parsed("photos.read_failed", photoDetailSchema, data);
}
