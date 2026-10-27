import type { Quantity, RecipeUnit } from "@madeora/domain/recipes";

import type { RecipeContent } from "./schema";

/**
 * The HTTP contract of recipes (S24). Every mutation is same-origin JSON, checked again by the
 * database with the person's own session. Ids of new recipes and publish requests come from the
 * client, so a retry returns the same recipe instead of a second one.
 *
 * - `GET /api/v1/recipes?homeId&q&tag&favorites&sort&offset` → `200 { recipes, total }` (24).
 * - `POST /api/v1/recipes` `{ id, homeId, publish, content }` → `201 { id, revision, status }`.
 * - `GET|PATCH|DELETE /api/v1/recipes/:id` (detail; save a draft, or a recipe with its lock token;
 *   to the trash). `POST /api/v1/recipes/:id/publish` `{ revision, requestId, homeId }`.
 * - `POST|PATCH|DELETE /api/v1/recipes/:id/lock` (acquire or take over; heartbeat; release).
 * - `PUT|DELETE /api/v1/recipes/:id/rating`, `PUT|DELETE /api/v1/recipes/:id/favorite`.
 * - `GET /api/v1/recipes/tags?homeId`, `GET /api/v1/recipes/drafts`,
 *   `GET /api/v1/recipes/widget?homeId&mode&limit&seed`.
 * - `POST /api/v1/recipes/cover-uploads` (intent); the bytes are finalized by the S15 route, and
 *   the cover is applied only by the next save.
 *
 * `409 conflict` (with the current `revision`) means someone changed it since it was read; `409
 * locked` that someone else is editing it; `409 lock-lost` that the editor's lock ended.
 */
export const RECIPES_ENDPOINT = "/api/v1/recipes";
export const RECIPE_TAGS_ENDPOINT = "/api/v1/recipes/tags";
export const RECIPE_DRAFTS_ENDPOINT = "/api/v1/recipes/drafts";
export const RECIPE_WIDGET_ENDPOINT = "/api/v1/recipes/widget";
export const RECIPE_COVER_UPLOADS_ENDPOINT = "/api/v1/recipes/cover-uploads";

export function recipeEndpoint(
  recipeId: string,
  part?: "publish" | "lock" | "rating" | "favorite",
) {
  const base = `${RECIPES_ENDPOINT}/${encodeURIComponent(recipeId)}`;
  return part ? `${base}/${part}` : base;
}

export type RecipeErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "conflict"
  | "id-taken"
  | "incomplete"
  | "limit-reached"
  | "invalid-cover"
  | "storage-full"
  | "storage-unavailable"
  | "rate-limited"
  | "lock-lost"
  | "locked"
  | "destination-unavailable"
  | "failed";

export interface RecipeErrorResponse {
  readonly error: RecipeErrorCode;
  readonly revision?: number;
  readonly fields?: readonly string[];
  /** With `locked`: whether the holder is the caller (another tab or device) and which member. */
  readonly heldByMe?: boolean;
  readonly member?: string | null;
}

/** A person as a recipe shows them: the viewer, a current member (membership id), or nobody known. */
export interface RecipePerson {
  readonly me: boolean;
  readonly member: string | null;
}

export interface RecipeSummary {
  readonly id: string;
  readonly name: string;
  readonly coverFileId: string | null;
  readonly tags: readonly string[];
  readonly servings: number | null;
  readonly prepMinutes: number | null;
  readonly cookMinutes: number | null;
  /** Set when the search matched only an ingredient: which one. */
  readonly matchedIngredient: string | null;
  readonly favorite: boolean;
  readonly myRating: number | null;
  readonly ratingAverage: number | null;
  readonly ratingCount: number;
  readonly publishedAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface RecipePage {
  readonly recipes: readonly RecipeSummary[];
  readonly total: number;
}

export interface RecipeTag {
  readonly tag: string;
  readonly count: number;
}

export interface RecipeDraftSummary {
  readonly id: string;
  readonly name: string | null;
  readonly destinationHomeId: string | null;
  readonly destinationHomeName: string | null;
  readonly destinationLost: boolean;
  readonly coverFileId: string | null;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface RecipeIngredient {
  readonly name: string;
  readonly quantity: Quantity | null;
  readonly unit: RecipeUnit | null;
  readonly note: string | null;
}

export interface RecipeDetail {
  readonly id: string;
  readonly status: "draft" | "published";
  /** The Home that owns it; null for the Personal space and for every draft. */
  readonly homeId: string | null;
  /** A draft's intended Home (null: Personal), while the person still belongs to it. */
  readonly draftHomeId: string | null;
  readonly destinationLost: boolean;
  readonly name: string | null;
  readonly servings: number | null;
  readonly servingsLabel: string | null;
  readonly prepMinutes: number | null;
  readonly cookMinutes: number | null;
  readonly notes: string | null;
  readonly tags: readonly string[];
  readonly coverFileId: string | null;
  readonly ingredients: readonly RecipeIngredient[];
  readonly steps: readonly string[];
  readonly revision: number;
  readonly createdAt: string;
  readonly createdBy: RecipePerson;
  readonly updatedAt: string;
  readonly updatedBy: RecipePerson;
  readonly publishedAt: string | null;
  readonly favorite: boolean;
  readonly rating: {
    readonly mine: number | null;
    readonly average: number | null;
    readonly count: number;
  };
  readonly lock: {
    readonly mine: boolean;
    readonly member: string | null;
    readonly expiresAt: string;
  } | null;
  readonly can: {
    readonly edit: boolean;
    readonly delete: boolean;
    readonly rate: boolean;
    readonly favorite: boolean;
    readonly publish: boolean;
  };
}

export interface CreateRecipeRequest {
  readonly id: string;
  readonly homeId: string | null;
  readonly publish: boolean;
  readonly content: RecipeContent;
}

export interface SavedRecipe {
  readonly id: string;
  readonly revision: number;
  readonly status?: "draft" | "published";
}

export interface LockAcquired {
  readonly revision: number;
  readonly expiresAt: string;
}

export interface RatingAnswer {
  readonly mine: number | null;
  readonly average: number | null;
  readonly count: number;
}

export interface RecipeWidgetCard {
  readonly id: string;
  readonly name: string;
  readonly coverFileId: string | null;
  readonly ratingAverage: number | null;
  readonly ratingCount: number;
}

export interface RecipeWidgetData {
  readonly cards: readonly RecipeWidgetCard[];
  /** How many recipes the mode could show in all (Random: whether there is another to show). */
  readonly available: number;
}

// The browser side ---------------------------------------------------------------------------------

export type RecipeFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "conflict"
  | "incomplete"
  | "limitReached"
  | "invalidCover"
  | "storageFull"
  | "lockLost"
  | "locked"
  | "destinationUnavailable"
  | "network"
  | "failed";

export class RecipeRequestError extends Error {
  constructor(
    readonly failure: RecipeFailure,
    /** For a conflict, the recipe's current revision when known. */
    readonly revision: number | null = null,
    /** For `locked`: whether the caller holds it elsewhere, and which member holds it. */
    readonly holder: { readonly mine: boolean; readonly member: string | null } | null = null,
  ) {
    super(`Recipe request failed: ${failure}`);
    this.name = "RecipeRequestError";
  }
}

const failures: { readonly [C in RecipeErrorCode]?: RecipeFailure } = {
  unauthenticated: "signedOut",
  invalid: "invalid",
  "not-found": "notFound",
  "not-permitted": "notPermitted",
  conflict: "conflict",
  incomplete: "incomplete",
  "limit-reached": "limitReached",
  "invalid-cover": "invalidCover",
  "storage-full": "storageFull",
  "lock-lost": "lockLost",
  locked: "locked",
  "destination-unavailable": "destinationUnavailable",
};

/** Sends one request; resolves with the JSON answer or rejects with a RecipeRequestError. */
export async function sendRecipeRequest<T>(
  method: string,
  url: string,
  body?: unknown,
  options: { readonly keepalive?: boolean } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      ...(options.keepalive ? { keepalive: true } : {}),
    });
  } catch {
    throw new RecipeRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = (payload && typeof payload === "object" ? payload : {}) as Partial<
      Record<string, unknown>
    >;
    const code = typeof record.error === "string" ? (record.error as RecipeErrorCode) : "failed";
    throw new RecipeRequestError(
      failures[code] ?? "failed",
      typeof record.revision === "number" ? record.revision : null,
      code === "locked"
        ? {
            mine: record.heldByMe === true,
            member: typeof record.member === "string" ? record.member : null,
          }
        : null,
    );
  }
  return payload as T;
}
