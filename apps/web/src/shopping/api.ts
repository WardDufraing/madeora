import type { ShoppingAccess, ShoppingMemberAccess } from "@madeora/domain/permissions";
import type { IsoWeekday, ShoppingFrequency, ShoppingUnit } from "@madeora/domain/shopping";

/**
 * The HTTP contract of shopping lists (S26). Every mutation is same-origin JSON, checked again by
 * the database with the person's own session. Ids of new lists, categories, items, copies and
 * recurring rules come from the client, so a retry returns the same row instead of a second one.
 *
 * - `GET /api/v1/shopping/lists?homeId&archived` → `200 { lists }`; `POST` `{ id, name, homeId }`.
 * - `GET|PATCH|DELETE /api/v1/shopping/lists/:id` (detail; `{ revision, name, memberAccess,
 *   archived }`; `{ revision }` to the trash). `POST …/move` `{ direction }`.
 * - `POST /api/v1/shopping/lists/:id/categories` `{ id, name }`; `PATCH
 *   /api/v1/shopping/categories/:id` `{ revision, name }` or `{ direction }`; `DELETE` `{ revision }`.
 * - `POST /api/v1/shopping/lists/:id/items` `{ items: [...] }` → per-row `{ results }`.
 * - `POST /api/v1/shopping/lists/:id/clear-completed` `{ itemIds }`.
 * - `PATCH|DELETE /api/v1/shopping/items/:id`; `PUT …/completion` `{ completed, seenCompletedAt }`;
 *   `POST …/move` `{ direction }`; `POST …/transfer`; `GET …/history`; `POST …/recurrence`.
 * - `PATCH /api/v1/shopping/recurrences/:id` `{ revision, action, schedule?, fromItemId? }`.
 * - `GET /api/v1/shopping/widget?homeId&listIds&limit`.
 *
 * `409 conflict` (with the current `revision` where known) means someone changed it since it was
 * read; `409 duplicate` that an active item reads the same (send `allowDuplicate`).
 */
export const SHOPPING_LISTS_ENDPOINT = "/api/v1/shopping/lists";
export const SHOPPING_WIDGET_ENDPOINT = "/api/v1/shopping/widget";

export function shoppingListEndpoint(
  listId: string,
  part?: "move" | "categories" | "items" | "clear-completed",
) {
  const base = `${SHOPPING_LISTS_ENDPOINT}/${encodeURIComponent(listId)}`;
  return part ? `${base}/${part}` : base;
}

export function shoppingItemEndpoint(
  itemId: string,
  part?: "completion" | "move" | "transfer" | "history" | "recurrence",
) {
  const base = `/api/v1/shopping/items/${encodeURIComponent(itemId)}`;
  return part ? `${base}/${part}` : base;
}

export function shoppingCategoryEndpoint(categoryId: string) {
  return `/api/v1/shopping/categories/${encodeURIComponent(categoryId)}`;
}

export function shoppingRecurrenceEndpoint(recurrenceId: string) {
  return `/api/v1/shopping/recurrences/${encodeURIComponent(recurrenceId)}`;
}

export type ShoppingErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "conflict"
  | "id-taken"
  | "duplicate"
  | "duplicate-name"
  | "limit-reached"
  | "same-list"
  | "destination-unavailable"
  | "invalid-category"
  | "already-repeating"
  | "completed"
  | "failed";

export interface ShoppingErrorResponse {
  readonly error: ShoppingErrorCode;
  readonly revision?: number;
  readonly fields?: readonly string[];
}

/** A person as shopping answers show them: the viewer, a current member (membership id), or nobody known. */
export interface ShoppingPerson {
  readonly me: boolean;
  readonly member: string | null;
}

export interface ShoppingListSummary {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly archived: boolean;
  readonly memberAccess: ShoppingMemberAccess;
  readonly access: ShoppingAccess;
  readonly revision: number;
  readonly activeItems: number;
  readonly completedItems: number;
}

export interface ShoppingCategory {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
}

export interface ShoppingItem {
  readonly id: string;
  readonly name: string;
  /** A canonical decimal string ("1.25"), never a float. */
  readonly quantity: string | null;
  readonly unit: ShoppingUnit | null;
  readonly packaging: string | null;
  readonly notes: string | null;
  readonly categoryId: string | null;
  readonly position: number;
  readonly completedAt: string | null;
  readonly completedBy: ShoppingPerson | null;
  /** The recurring rule it belongs to, while that rule repeats. */
  readonly recurrenceId: string | null;
  readonly occurrenceOn: string | null;
  readonly revision: number;
  readonly createdAt: string;
}

export interface ShoppingRecurrence {
  readonly id: string;
  readonly name: string;
  readonly quantity: string | null;
  readonly unit: ShoppingUnit | null;
  readonly packaging: string | null;
  readonly notes: string | null;
  readonly categoryId: string | null;
  readonly categoryLost: boolean;
  readonly frequency: ShoppingFrequency;
  readonly weekdays: readonly IsoWeekday[] | null;
  readonly monthDay: number | null;
  readonly startOn: string | null;
  readonly nextOn: string;
  readonly paused: boolean;
  readonly stalled: "list_full" | null;
  readonly revision: number;
  readonly activeItemId: string | null;
}

export interface ShoppingDestination {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

export interface ShoppingListDetail {
  readonly id: string;
  readonly homeId: string | null;
  readonly name: string;
  readonly archived: boolean;
  readonly memberAccess: ShoppingMemberAccess;
  readonly access: ShoppingAccess;
  readonly revision: number;
  readonly createdByMe: boolean;
  readonly categories: readonly ShoppingCategory[];
  readonly items: readonly ShoppingItem[];
  readonly recurrences: readonly ShoppingRecurrence[];
  /** Other active lists of the same context the viewer may add to. */
  readonly destinations: readonly ShoppingDestination[];
}

export const shoppingHistoryKinds = [
  "added",
  "edited",
  "completed",
  "reopened",
  "moved_in",
  "moved_out",
  "copied",
  "recurred",
  "deleted",
  "cleared",
  "restored",
] as const;
export type ShoppingHistoryKind = (typeof shoppingHistoryKinds)[number];

export interface ShoppingHistoryEntry {
  readonly kind: ShoppingHistoryKind;
  readonly at: string;
  /** null: an automatic change (a recurring item) or an account that no longer exists. */
  readonly actor: ShoppingPerson | null;
  /** The other list of a move or copy (same context), when it still exists. */
  readonly otherListName: string | null;
}

export interface ShoppingWidgetList {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly access: ShoppingAccess;
}

export interface ShoppingWidgetItem {
  readonly id: string;
  readonly listId: string;
  readonly name: string;
  readonly quantity: string | null;
  readonly unit: ShoppingUnit | null;
  readonly packaging: string | null;
  readonly revision: number;
}

export interface ShoppingWidgetData {
  readonly lists: readonly ShoppingWidgetList[];
  /** Selected lists that are archived, deleted or no longer visible: left out, never replaced. */
  readonly unavailable: number;
  /** Active items in the visible selected lists (the rows are the first `limit`). */
  readonly total: number;
  readonly items: readonly ShoppingWidgetItem[];
}

/** One row's answer in a multi-item add. */
export type ShoppingAddOutcome =
  | "created"
  | "exists"
  | "id_taken"
  | "invalid"
  | "duplicate"
  | "limit_reached"
  | "not_found"
  | "not_permitted";

export interface ShoppingAddResult {
  readonly id: string;
  readonly outcome: ShoppingAddOutcome;
}

export interface ShoppingCompletionAnswer {
  readonly outcome: "completed" | "reopened" | "unchanged";
  readonly completedAt: string | null;
  readonly completedBy: ShoppingPerson | null;
}

export interface ShoppingTransferAnswer {
  readonly outcome: "moved" | "copied" | "exists";
  readonly itemId: string;
}

export interface ShoppingClearAnswer {
  readonly outcome: "cleared" | "unchanged";
  readonly cleared: number;
  readonly skipped: number;
}

export type ShoppingFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "conflict"
  | "duplicate"
  | "duplicateName"
  | "limitReached"
  | "sameList"
  | "destinationUnavailable"
  | "invalidCategory"
  | "alreadyRepeating"
  | "completed"
  | "network"
  | "failed";

export class ShoppingRequestError extends Error {
  constructor(
    readonly failure: ShoppingFailure,
    /** For a conflict, the current revision when known. */
    readonly revision: number | null = null,
  ) {
    super(`Shopping request failed: ${failure}`);
    this.name = "ShoppingRequestError";
  }
}

const failures: { readonly [C in ShoppingErrorCode]?: ShoppingFailure } = {
  unauthenticated: "signedOut",
  invalid: "invalid",
  "not-found": "notFound",
  "not-permitted": "notPermitted",
  conflict: "conflict",
  duplicate: "duplicate",
  "duplicate-name": "duplicateName",
  "limit-reached": "limitReached",
  "same-list": "sameList",
  "destination-unavailable": "destinationUnavailable",
  "invalid-category": "invalidCategory",
  "already-repeating": "alreadyRepeating",
  completed: "completed",
};

/** Sends one request; resolves with the JSON answer or rejects with a ShoppingRequestError. */
export async function sendShoppingRequest<T>(
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
  } catch {
    // Offline or unreachable: nothing is reported as saved, and a retry is safe (client ids and
    // set-to-state requests).
    throw new ShoppingRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = (payload && typeof payload === "object" ? payload : {}) as Partial<
      Record<string, unknown>
    >;
    const code = typeof record.error === "string" ? (record.error as ShoppingErrorCode) : "failed";
    throw new ShoppingRequestError(
      failures[code] ?? "failed",
      typeof record.revision === "number" ? record.revision : null,
    );
  }
  return payload as T;
}
