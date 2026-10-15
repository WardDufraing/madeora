import "server-only";

import { cache } from "react";

import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { homeIdSchema } from "@/homes/schema";

import { toStorageUsage, type StorageUsage } from "./usage-view";

export type StorageUsageResult =
  | { readonly status: "ok"; readonly usage: StorageUsage }
  /** Not allowed to see it (a Home: not its storage manager), or no such Home. */
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

function logFailure(event: string, code: string): void {
  console.error(JSON.stringify({ event, code }));
}

/** The signed-in person's personal storage (S15), with their own session. Cached per request. */
export const getMyStorageUsage = cache(async (): Promise<StorageUsageResult> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_storage_usage");
  if (error) {
    logFailure("storage.usage_read_failed", error.code);
    return { status: "unavailable" };
  }
  const row = data[0];
  return row ? { status: "ok", usage: toStorageUsage(row) } : { status: "unavailable" };
});

/** A Home's storage, for its storage managers only; the database refuses anyone else. */
export const getHomeStorageUsage = cache(async (homeId: string): Promise<StorageUsageResult> => {
  const parsed = homeIdSchema.safeParse(homeId);
  if (!parsed.success) return { status: "not-found" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("home_storage_usage", { p_home_id: parsed.data });
  if (error?.code === "42501") return { status: "not-found" };
  if (error) {
    logFailure("storage.home_usage_read_failed", error.code);
    return { status: "unavailable" };
  }
  const row = data[0];
  return row ? { status: "ok", usage: toStorageUsage(row) } : { status: "unavailable" };
});

export type MyAvatars =
  | {
      readonly status: "ok";
      /** The global avatar, or null. */
      readonly global: string | null;
      /** The override in the Home asked for, or null (inherits the global one). */
      readonly home: string | null;
    }
  | { readonly status: "unavailable" };

/**
 * The signed-in person's own avatar choices: the global one and, with `homeId`, the override there.
 * Read with their own session, so RLS returns only their own rows. Cached per request.
 */
export const getMyAvatars = cache(async (homeId?: string): Promise<MyAvatars> => {
  const identity = await getVerifiedIdentity();
  if (!identity) return { status: "unavailable" };
  const supabase = await createSupabaseServerClient();
  const [globalRead, homeRead] = await Promise.all([
    supabase
      .from("user_preferences")
      .select("avatar_file_id")
      .eq("user_id", identity.userId)
      .maybeSingle(),
    homeId && homeIdSchema.safeParse(homeId).success
      ? supabase
          .from("home_member_profiles")
          .select("avatar_file_id")
          .eq("home_id", homeId)
          .eq("user_id", identity.userId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const error = globalRead.error ?? homeRead.error;
  if (error) {
    logFailure("storage.avatars_read_failed", error.code);
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    global: globalRead.data?.avatar_file_id ?? null,
    home: homeRead.data?.avatar_file_id ?? null,
  };
});
