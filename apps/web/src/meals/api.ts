import type { MealAccess, MealMemberAccess } from "@madeora/domain/permissions";
import type { MealCadence, MealStandardSlot, TransferMeal } from "@madeora/domain/meals";

/**
 * The HTTP contract of the meal planner (S27). Every mutation is same-origin JSON, checked again by
 * the database with the person's own session. Ids of new meals, slots, series, copies and transfers
 * come from the client, so a retry returns the same row instead of a second one.
 *
 * - `GET /api/v1/meals/plan?homeId&from&to` → `200 { plan }` (no dates: today).
 * - `POST /api/v1/meals/entries`; `PATCH|DELETE /api/v1/meals/entries/:id`.
 * - `PUT|DELETE /api/v1/meals/occurrences/:recurrenceId/:date` (edit or move one; skip one);
 *   `POST …/restore` (undo a skip).
 * - `POST /api/v1/meals/series` `{ action: "preview" | "create", … }`; `PATCH
 *   /api/v1/meals/series/:id` `{ action: "preview" | "editFuture" | "pause" | "resume" | "end", … }`.
 * - `POST /api/v1/meals/slots`; `PATCH /api/v1/meals/slots/:id`; `GET …/impact`; `POST …/move`.
 * - `PATCH /api/v1/meals/settings` `{ homeId, revision, memberAccess }`.
 * - `GET|POST /api/v1/meals/copy-week`; `GET|POST /api/v1/meals/shopping-transfer`.
 * - `GET /api/v1/meals/recipes?homeId&q` (recipes that may be planned from the context).
 *
 * `409 occupied` carries what is in the slot and a `replaceKey`; sending that key back replaces it
 * explicitly. `409 conflicts` carries a series' collisions to decide; `409 stale` asks to reload a
 * preview; `409 conflict` (with the current `revision`) that someone changed it since it was read.
 */
export const MEAL_PLAN_ENDPOINT = "/api/v1/meals/plan";
export const MEAL_ENTRIES_ENDPOINT = "/api/v1/meals/entries";
export const MEAL_SERIES_ENDPOINT = "/api/v1/meals/series";
export const MEAL_SLOTS_ENDPOINT = "/api/v1/meals/slots";
export const MEAL_SETTINGS_ENDPOINT = "/api/v1/meals/settings";
export const MEAL_COPY_ENDPOINT = "/api/v1/meals/copy-week";
export const MEAL_TRANSFER_ENDPOINT = "/api/v1/meals/shopping-transfer";
export const MEAL_RECIPES_ENDPOINT = "/api/v1/meals/recipes";

export function mealEntryEndpoint(entryId: string) {
  return `${MEAL_ENTRIES_ENDPOINT}/${encodeURIComponent(entryId)}`;
}

export function mealOccurrenceEndpoint(recurrenceId: string, date: string, restore = false) {
  const base = `/api/v1/meals/occurrences/${encodeURIComponent(recurrenceId)}/${encodeURIComponent(date)}`;
  return restore ? `${base}/restore` : base;
}

export function mealSeriesEndpoint(seriesId: string) {
  return `${MEAL_SERIES_ENDPOINT}/${encodeURIComponent(seriesId)}`;
}

export function mealSlotEndpoint(slotId: string, part?: "impact" | "move") {
  const base = `${MEAL_SLOTS_ENDPOINT}/${encodeURIComponent(slotId)}`;
  return part ? `${base}/${part}` : base;
}

export type MealErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "conflict"
  | "id-taken"
  | "occupied"
  | "conflicts"
  | "stale"
  | "impact-required"
  | "slot-unavailable"
  | "recipe-unavailable"
  | "invalid-date"
  | "name-taken"
  | "limit-reached"
  | "list-unavailable"
  | "failed";

export interface MealErrorResponse {
  readonly error: MealErrorCode;
  readonly revision?: number;
  readonly fields?: readonly string[];
  readonly occupied?: MealOccupied;
  readonly collisions?: readonly MealCollision[];
  readonly impact?: MealSlotImpact;
}

export interface MealSlot {
  readonly id: string;
  readonly standardKey: MealStandardSlot | null;
  /** null: the translated standard name. */
  readonly name: string | null;
  readonly position: number;
  readonly enabled: boolean;
  readonly revision: number;
}

/** A recipe as a meal may show it: only when visible from the planner's context now. */
export interface MealRecipeRef {
  readonly id: string;
  readonly name: string;
  readonly servings: number | null;
}

interface MealContent {
  readonly date: string;
  readonly slotId: string;
  readonly type: "recipe" | "custom";
  /** null for a recipe meal means "Recipe unavailable" (never its details). */
  readonly recipe: MealRecipeRef | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly servings: number | null;
}

export interface MealEntry extends MealContent {
  readonly kind: "entry";
  readonly id: string;
  readonly revision: number;
  /** The repeating meal it was edited or moved from. */
  readonly origin: {
    readonly recurrenceId: string;
    readonly date: string;
    readonly seriesId: string | null;
  } | null;
}

export interface MealOccurrence extends MealContent {
  readonly kind: "occurrence";
  readonly recurrenceId: string;
  readonly seriesId: string;
  readonly cadence: MealCadence;
  readonly seriesRevision: number;
}

export type PlannedMeal = MealEntry | MealOccurrence;

export interface MealSeries {
  readonly id: string;
  readonly status: "active" | "paused";
  readonly revision: number;
  readonly endOn: string | null;
  readonly recurrenceId: string;
  readonly slotId: string;
  readonly slotEnabled: boolean;
  readonly type: "recipe" | "custom";
  readonly recipe: MealRecipeRef | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly servings: number | null;
  readonly cadence: MealCadence;
  readonly weekdays: readonly number[] | null;
  readonly startOn: string;
  readonly segmentEndOn: string | null;
}

export interface MealPlan {
  readonly access: MealAccess;
  readonly memberAccess: MealMemberAccess;
  readonly settingsRevision: number;
  readonly today: string;
  readonly from: string;
  readonly to: string;
  readonly slots: readonly MealSlot[];
  readonly entries: readonly MealEntry[];
  readonly occurrences: readonly MealOccurrence[];
  readonly series: readonly MealSeries[];
  /** A fingerprint of what the plan shows (the print preview checks it before printing). */
  readonly token: string;
}

export interface MealOccupied {
  readonly occupants: readonly PlannedMeal[];
  readonly replaceKey: string;
}

export interface MealCollision extends MealOccupied {
  readonly date: string;
}

export interface MealSeriesPreview {
  readonly nextDates: readonly string[];
  readonly collisions: readonly MealCollision[];
  readonly token: string;
}

export interface MealSlotImpact {
  readonly futureMeals: number;
  readonly pastMeals: number;
  readonly series: number;
  readonly token: string;
}

export interface MealCopyRow extends MealOccupied {
  readonly key: string;
  readonly sourceDate: string;
  readonly date: string;
  readonly slotId: string;
  readonly type: "recipe" | "custom";
  readonly recipe: MealRecipeRef | null;
  readonly title: string | null;
  readonly notes: string | null;
  readonly servings: number | null;
  readonly repeating: boolean;
  readonly status: "ok" | "unavailable" | "slot_disabled";
}

export interface MealCopyPreview {
  readonly rows: readonly MealCopyRow[];
  readonly token: string;
}

export const mealCopyOutcomes = [
  "created",
  "exists",
  "id_taken",
  "occupied",
  "unavailable",
  "slot_unavailable",
  "missing",
] as const;
export type MealCopyOutcome = (typeof mealCopyOutcomes)[number];

export interface MealCopyResult {
  readonly key: string;
  readonly id: string;
  readonly outcome: MealCopyOutcome;
}

/** A destination list a transfer may use: an active list of the same context the person may edit. */
export interface MealTransferList {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

export interface MealTransferPreview {
  readonly meals: readonly TransferMeal[];
  readonly token: string;
  readonly lists: readonly MealTransferList[];
}

export interface MealTransferResult {
  readonly id: string;
  readonly outcome: string;
}

export interface MealRecipeOption {
  readonly id: string;
  readonly name: string;
  readonly servings: number | null;
}

/** What a refused or failed request means to the person. */
export type MealFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "conflict"
  | "idTaken"
  | "occupied"
  | "conflicts"
  | "stale"
  | "impactRequired"
  | "slotUnavailable"
  | "recipeUnavailable"
  | "invalidDate"
  | "nameTaken"
  | "limitReached"
  | "listUnavailable"
  | "network"
  | "failed";

const failures: { readonly [C in MealErrorCode]?: MealFailure } = {
  unauthenticated: "signedOut",
  invalid: "invalid",
  "not-found": "notFound",
  "not-permitted": "notPermitted",
  conflict: "conflict",
  "id-taken": "idTaken",
  occupied: "occupied",
  conflicts: "conflicts",
  stale: "stale",
  "impact-required": "impactRequired",
  "slot-unavailable": "slotUnavailable",
  "recipe-unavailable": "recipeUnavailable",
  "invalid-date": "invalidDate",
  "name-taken": "nameTaken",
  "limit-reached": "limitReached",
  "list-unavailable": "listUnavailable",
};

export class MealRequestError extends Error {
  constructor(
    readonly failure: MealFailure,
    /** What came with the refusal: the current revision, what occupies a slot, collisions, impact. */
    readonly details: Omit<MealErrorResponse, "error"> = {},
  ) {
    super(`Meal request failed: ${failure}`);
    this.name = "MealRequestError";
  }
}

/** Sends one request; resolves with the JSON answer or rejects with a MealRequestError. */
export async function sendMealRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
  } catch {
    // Offline or unreachable: nothing is reported as saved, and a retry is safe (client ids).
    throw new MealRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = (payload && typeof payload === "object" ? payload : {}) as MealErrorResponse;
    const code = typeof record.error === "string" ? record.error : "failed";
    const { error: _error, ...details } = record;
    throw new MealRequestError(failures[code] ?? "failed", details);
  }
  return payload as T;
}
