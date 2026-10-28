import "server-only";

import { z } from "zod";

import { shoppingFrequencies, shoppingUnits } from "@madeora/domain/shopping";

import { createSupabaseServerClient } from "@/auth/supabase-server";

import type {
  ShoppingHistoryEntry,
  ShoppingListDetail,
  ShoppingListSummary,
  ShoppingWidgetData,
} from "./api";
import { shoppingHistoryKinds } from "./api";
import { logShopping } from "./log";

/**
 * Server reads of shopping lists (S26), always with the signed-in person's own Supabase session:
 * the database answers only what they may see now, so a Home they left or a list that is not
 * theirs is simply not there. Each read of a context first applies its due recurring items
 * (`advance_shopping`, idempotent), so a page or widget never shows a rule as overdue. Nothing here
 * is cached across requests (personalized data, architecture.md §9).
 */

export type Read<T> =
  | { readonly status: "ok"; readonly value: T }
  /** Not a Home the person belongs to (or none such), or not theirs to see. */
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

function failed<T>(event: string, error: { readonly code?: string }): Read<T> {
  if (error.code === "42501") return { status: "not-found" };
  logShopping(event, error.code);
  return { status: "unavailable" };
}

/** Widens a value to include null, because the generated database types do not. */
function nullable<T>(value: T): T | null {
  return value;
}

const homeArg = (homeId: string | null) => (homeId ? { p_home_id: homeId } : {});

const accessSchema = z.enum(["manage", "edit", "check", "view"]);
const memberAccessSchema = z.enum(["edit", "check", "view"]);

export interface ShoppingContextInfo {
  readonly canCreate: boolean;
  /** Whether the viewer may reorder the context's lists (its shopping managers). */
  readonly canReorder: boolean;
  /** The context's signal version the page is rendered at (Realtime, ADR 0027). */
  readonly signalVersion: number;
}

export async function getShoppingContext(
  homeId: string | null,
): Promise<Read<ShoppingContextInfo>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_shopping_context", homeArg(homeId));
  if (error) return failed("shopping.context_failed", error);
  const row = data[0];
  if (!row) return { status: "not-found" };
  return {
    status: "ok",
    value: {
      canCreate: row.can_create,
      canReorder: row.can_reorder,
      signalVersion: row.signal_version,
    },
  };
}

/** Applies the context's due recurring items before a read (never fails a page on its own). */
export async function advanceShopping(homeId: string | null): Promise<Read<number>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("advance_shopping", homeArg(homeId));
  if (error) return failed("shopping.advance_failed", error);
  return { status: "ok", value: data };
}

/** The context's active (or archived) lists in their order, with counts and the viewer's access. */
export async function listShoppingLists(
  homeId: string | null,
  archived: boolean,
): Promise<Read<readonly ShoppingListSummary[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_shopping_lists", {
    ...homeArg(homeId),
    p_archived: archived,
  });
  if (error) return failed("shopping.list_failed", error);
  const lists: ShoppingListSummary[] = [];
  for (const row of data) {
    const access = accessSchema.safeParse(row.access);
    const memberAccess = memberAccessSchema.safeParse(row.member_access);
    if (!access.success || !memberAccess.success) {
      logShopping("shopping.list_unexpected_shape", "shape");
      return { status: "unavailable" };
    }
    lists.push({
      id: row.id,
      name: row.name,
      position: row.position,
      archived: row.archived,
      memberAccess: memberAccess.data,
      access: access.data,
      revision: row.revision,
      activeItems: row.active_items,
      completedItems: row.completed_items,
    });
  }
  return { status: "ok", value: lists };
}

const person = z.object({ me: z.boolean(), member: z.uuid().nullable() });
const quantity = z.string().nullable();
const unit = z.enum(shoppingUnits).nullable();

const detailSchema = z.object({
  id: z.uuid(),
  homeId: z.uuid().nullable(),
  name: z.string(),
  archived: z.boolean(),
  memberAccess: memberAccessSchema,
  access: accessSchema,
  revision: z.number().int(),
  createdByMe: z.boolean(),
  categories: z.array(z.object({ id: z.uuid(), name: z.string(), revision: z.number().int() })),
  items: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      quantity,
      unit,
      packaging: z.string().nullable(),
      notes: z.string().nullable(),
      categoryId: z.uuid().nullable(),
      position: z.number().int(),
      completedAt: z.string().nullable(),
      completedBy: person.nullable(),
      recurrenceId: z.uuid().nullable(),
      occurrenceOn: z.string().nullable(),
      revision: z.number().int(),
      createdAt: z.string(),
    }),
  ),
  recurrences: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      quantity,
      unit,
      packaging: z.string().nullable(),
      notes: z.string().nullable(),
      categoryId: z.uuid().nullable(),
      categoryLost: z.boolean(),
      frequency: z.enum(shoppingFrequencies),
      weekdays: z.array(z.literal([1, 2, 3, 4, 5, 6, 7])).nullable(),
      monthDay: z.number().int().nullable(),
      startOn: z.string().nullable(),
      nextOn: z.string(),
      paused: z.boolean(),
      stalled: z.literal("list_full").nullable(),
      revision: z.number().int(),
      activeItemId: z.uuid().nullable(),
    }),
  ),
  destinations: z.array(z.object({ id: z.uuid(), name: z.string(), position: z.number().int() })),
});

/**
 * One list seen from the context the address names (`homeId`; null: the Personal space), or
 * not-found when it is missing, in the trash, of another context or not the person's to see.
 */
export async function getShoppingList(
  listId: string,
  homeId: string | null,
): Promise<Read<ShoppingListDetail>> {
  const advanced = await advanceShopping(homeId);
  if (advanced.status !== "ok") return advanced;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_shopping_list", { p_list_id: listId });
  if (error) {
    if (error.code === "22023" || error.code === "22P02") return { status: "not-found" };
    return failed("shopping.get_failed", error);
  }
  if (data === null) return { status: "not-found" };
  const parsed = detailSchema.safeParse(data);
  if (!parsed.success) {
    logShopping("shopping.get_unexpected_shape", "shape");
    return { status: "unavailable" };
  }
  // A list is found only from its own context's address.
  if (parsed.data.homeId !== homeId) return { status: "not-found" };
  return { status: "ok", value: parsed.data };
}

/** An item's latest history entries, newest first (empty for one the person may not see). */
export async function getShoppingItemHistory(
  itemId: string,
): Promise<Read<readonly ShoppingHistoryEntry[]>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("shopping_item_history", { p_item_id: itemId });
  if (error) return failed("shopping.history_failed", error);
  const entries: ShoppingHistoryEntry[] = [];
  for (const row of data) {
    const kind = z.enum(shoppingHistoryKinds).safeParse(row.kind);
    const actor = person.nullable().safeParse(row.actor);
    if (!kind.success || !actor.success) {
      logShopping("shopping.history_unexpected_shape", "shape");
      return { status: "unavailable" };
    }
    entries.push({
      kind: kind.data,
      at: row.at,
      actor: actor.data,
      // The generated types call it non-null; the database leaves it null for most kinds.
      otherListName: nullable(row.other_list_name),
    });
  }
  return { status: "ok", value: entries };
}

const widgetSchema = z.object({
  lists: z.array(
    z.object({ id: z.uuid(), name: z.string(), position: z.number().int(), access: accessSchema }),
  ),
  unavailable: z.number().int(),
  total: z.number().int(),
  items: z.array(
    z.object({
      id: z.uuid(),
      listId: z.uuid(),
      name: z.string(),
      quantity,
      unit,
      packaging: z.string().nullable(),
      revision: z.number().int(),
    }),
  ),
});

/** What a Shopping widget shows (S26): the active items of its selected lists of one context. */
export async function readShoppingWidget(
  homeId: string | null,
  listIds: readonly string[],
  limit: number,
): Promise<Read<ShoppingWidgetData>> {
  const advanced = await advanceShopping(homeId);
  if (advanced.status !== "ok") return advanced;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("shopping_widget", {
    ...homeArg(homeId),
    p_list_ids: [...listIds],
    p_limit: limit,
  });
  if (error) return failed("shopping.widget_failed", error);
  const parsed = widgetSchema.safeParse(data);
  if (!parsed.success) {
    logShopping("shopping.widget_unexpected_shape", "shape");
    return { status: "unavailable" };
  }
  return { status: "ok", value: parsed.data };
}
