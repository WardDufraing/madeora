import { accessAllows } from "@madeora/domain/permissions";
import { formatShoppingQuantity, type ShoppingUnit } from "@madeora/domain/shopping";

import type { ShoppingListDetail } from "./api";

/** Client-safe helpers of the shopping pages (S26). */

/** The lists of a context: the Personal space (`null`) or a Home. */
export function shoppingPath(homeId: string | null, view?: "archived"): string {
  const base = homeId ? `/homes/${homeId}/shopping` : "/shopping";
  return view ? `${base}?view=${view}` : base;
}

/** One list's page, or its Add several page. */
export function shoppingListPath(
  homeId: string | null,
  listId: string,
  part?: "add-several",
): string {
  const base = `${shoppingPath(homeId)}/${listId}`;
  return part ? `${base}/${part}` : base;
}

/**
 * Typed TanStack Query keys, always scoped by account and context (architecture.md §9); everything
 * under `all` is dropped after a change and on every signal.
 */
export const shoppingKeys = {
  all: ["shopping"] as const,
  widget: (userId: string, homeId: string | null, listIds: readonly string[], limit: number) =>
    ["shopping", userId, homeId ?? "personal", "widget", listIds.join(","), limit] as const,
  history: (userId: string, itemId: string) => ["shopping", userId, "history", itemId] as const,
};

/** The Realtime signal row of a context: the Home, or the person's own Personal space. */
export function signalContextId(homeId: string | null, userId: string): string {
  return homeId ?? userId;
}

/** "2", "1,5 kg", "500 g" — an item's amount as stored, never converted (null: none). */
export function amountText(
  quantity: string | null,
  unit: ShoppingUnit | null,
  locale: string,
  unitLabel: (unit: ShoppingUnit) => string,
): string | null {
  if (quantity === null) return null;
  const value = formatShoppingQuantity(quantity, locale);
  return unit ? `${value} ${unitLabel(unit)}` : value;
}

/** A canonical quantity as the person types it back in their locale ("1,25" in nl), no grouping. */
export function quantityInput(quantity: string | null, locale: string): string {
  if (quantity === null) return "";
  const separator =
    new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")
      ?.value ?? ".";
  return quantity.replace(".", separator);
}

export interface ShoppingRights {
  readonly edit: boolean;
  readonly check: boolean;
  readonly manage: boolean;
}

/**
 * What the viewer may do with this list now, from the access the database reported (the shared
 * permission engine; the database decides again on every change). Archived: read only, except
 * for its managers' settings.
 */
export function shoppingRights(list: ShoppingListDetail): ShoppingRights {
  return {
    manage: accessAllows(list.access, list.archived, "shopping.manage"),
    edit: accessAllows(list.access, list.archived, "shopping.edit"),
    check: accessAllows(list.access, list.archived, "shopping.check"),
  };
}
