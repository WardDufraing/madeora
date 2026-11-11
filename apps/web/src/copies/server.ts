import "server-only";

import { z } from "zod";

import type { Loaded } from "@/activity/server";
import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";

import { COPY_ITEM_TYPES, COPY_STATUSES, type CopyItemType } from "./catalogue";

function logFailure(event: string, code: string | undefined): void {
  // Privacy-safe: the error code only, no account, Home, item or request ids.
  console.error(JSON.stringify({ event, code: code ?? null }));
}

const destinationsSchema = z.object({
  label: z.string().nullable(),
  files: z.int().min(0),
  homes: z.array(
    z.object({
      homeId: z.uuid(),
      name: z.string(),
      mode: z.enum(["direct", "approval"]),
      shared: z.boolean(),
      open: z.boolean(),
    }),
  ),
});
export type CopyDestinations = z.infer<typeof destinationsSchema>;

/**
 * Where the person could copy one of their own items: every Home they belong to, with how (directly
 * or by approval), whether the item is shared there now and whether a request is already open.
 * `not_found` for an item that is not their own eligible personal item.
 */
export async function getCopyDestinations(
  type: CopyItemType,
  id: string,
): Promise<
  | { readonly status: "ok"; readonly value: CopyDestinations }
  | { readonly status: "not_found" | "unavailable" }
> {
  if (!(await getVerifiedIdentity())) return { status: "unavailable" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_copy_destinations", {
    p_item_type: type,
    p_item_id: id,
  });
  if (error) {
    if (error.code === "P0002" || error.code === "22023" || error.code === "22P02") {
      return { status: "not_found" };
    }
    logFailure("copies.destinations_failed", error.code);
    return { status: "unavailable" };
  }
  const parsed = destinationsSchema.safeParse(data);
  if (!parsed.success) {
    logFailure("copies.destinations_failed", "unexpected_result");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const myCopySchema = z.object({
  id: z.uuid(),
  homeId: z.uuid(),
  homeName: z.string(),
  itemType: z.enum(COPY_ITEM_TYPES),
  itemId: z.uuid(),
  label: z.string().nullable(),
  status: z.enum(COPY_STATUSES),
  direct: z.boolean(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  endedAt: z.string().nullable(),
  code: z.string().nullable(),
  selfApproved: z.boolean(),
});
export type MyHomeCopy = z.infer<typeof myCopySchema>;

/** The person's own copy requests: open ones first, then the last 90 days. */
export async function listMyHomeCopies(): Promise<Loaded<readonly MyHomeCopy[]>> {
  if (!(await getVerifiedIdentity())) return { status: "unavailable" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_home_copies");
  if (error) {
    logFailure("copies.list_mine_failed", error.code);
    return { status: "unavailable" };
  }
  const parsed = z.array(myCopySchema).safeParse(data);
  if (!parsed.success) {
    logFailure("copies.list_mine_failed", "unexpected_result");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const openCopySchema = z.object({
  id: z.uuid(),
  homeId: z.uuid(),
  homeName: z.string(),
  itemType: z.enum(COPY_ITEM_TYPES),
  label: z.string().nullable(),
  status: z.enum(["pending", "copying"]),
  expiresAt: z.string(),
});
export type OpenHomeCopy = z.infer<typeof openCopySchema>;

/** The person's pending and running requests, for the Delete account page. */
export async function listMyOpenHomeCopies(): Promise<Loaded<readonly OpenHomeCopy[]>> {
  if (!(await getVerifiedIdentity())) return { status: "unavailable" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_open_home_copies");
  if (error) {
    logFailure("copies.list_open_failed", error.code);
    return { status: "unavailable" };
  }
  const parsed = z.array(openCopySchema).safeParse(data);
  if (!parsed.success) {
    logFailure("copies.list_open_failed", "unexpected_result");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const sharedItemSchema = z.object({
  itemType: z.enum(COPY_ITEM_TYPES),
  itemId: z.uuid(),
  label: z.string().nullable(),
  homes: z.array(z.string()).min(1),
});
export type SharedCopyableItem = z.infer<typeof sharedItemSchema>;

/**
 * The person's own eligible personal items shared with a Home now, with those Homes, for the Delete
 * account page: each can be copied into a Home on its own before the account is deleted.
 */
export async function listMySharedCopyableItems(): Promise<Loaded<readonly SharedCopyableItem[]>> {
  if (!(await getVerifiedIdentity())) return { status: "unavailable" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("my_shared_copyable_items");
  if (error) {
    logFailure("copies.list_shared_failed", error.code);
    return { status: "unavailable" };
  }
  const parsed = z.array(sharedItemSchema).safeParse(data);
  if (!parsed.success) {
    logFailure("copies.list_shared_failed", "unexpected_result");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

const homeRequestsSchema = z.object({
  canApprove: z.boolean(),
  requests: z.array(
    z.object({
      id: z.uuid(),
      itemType: z.enum(COPY_ITEM_TYPES),
      label: z.string().nullable(),
      files: z.int().min(0),
      requester: z.string().nullable(),
      isMine: z.boolean(),
      requestedAt: z.string(),
      expiresAt: z.string(),
    }),
  ),
});
export type HomeCopyRequests = z.infer<typeof homeRequestsSchema>;

/** A Home's pending requests the person may decide; `not_member` outside the Home. */
export async function listHomeCopyRequests(homeId: string): Promise<Loaded<HomeCopyRequests>> {
  if (!(await getVerifiedIdentity())) return { status: "unavailable" };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_home_copy_requests", { p_home_id: homeId });
  if (error) {
    if (error.code !== "42501") logFailure("copies.list_home_failed", error.code);
    return { status: "unavailable" };
  }
  const parsed = homeRequestsSchema.safeParse(data);
  if (!parsed.success) {
    logFailure("copies.list_home_failed", "unexpected_result");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}

/** When a Home item the person sees was copied from personal, or null. */
export async function getCopyOrigin(
  type: CopyItemType | "photo",
  id: string,
): Promise<string | null> {
  if (!(await getVerifiedIdentity())) return null;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_copy_origin", {
    p_item_type: type,
    p_item_id: id,
  });
  if (error) {
    logFailure("copies.origin_failed", error.code);
    return null;
  }
  return typeof data === "string" ? data : null;
}
