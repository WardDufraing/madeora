import type { GoalSummary, GoalTargetImpact } from "./shapes";

export type {
  GoalAchievement,
  GoalAchievementResult,
  GoalCorrection,
  GoalDetail,
  GoalEntries,
  GoalEntry,
  GoalEntryResult,
  GoalEvent,
  GoalEvents,
  GoalList,
  GoalMoment,
  GoalPeriod,
  GoalReminder,
  GoalRemindersResult,
  GoalSeriesCreateResult,
  GoalSeriesDetail,
  GoalSeriesPeriods,
  GoalSeriesPreview,
  GoalSeriesSummary,
  GoalSeriesTarget,
  GoalSeriesTargetImpact,
  GoalSeriesTargetResult,
  GoalSummary,
  GoalTargetImpact,
  GoalTargetResult,
} from "./shapes";

/**
 * The HTTP contract of goals (S30). Every mutation is same-origin JSON, checked again by the
 * database with the person's own session. Ids of new goals and entries come from the client, so a
 * retry returns the same row instead of a second one. Quantities travel as decimal strings ("0.25")
 * or exact numbers, at most 3 decimals.
 *
 * - `GET /api/v1/goals?homeId&view=active|completed|archived&q` → `200 { list }`; `POST` creates.
 * - `GET|PATCH|DELETE /api/v1/goals/:id` (detail; edit; to the trash).
 * - `POST /api/v1/goals/:id/target` (`preview: true` → `{ impact }`; `409 confirm-unit` /
 *   `confirm-status` with the impact until confirmed).
 * - `POST /api/v1/goals/:id/entries` (add, or a manager's set total); `GET …/entries?before=`.
 * - `PATCH /api/v1/goal-entries/:id` (reverse or amend).
 * - `POST /api/v1/goals/:id/achievement` (achieve or reopen); `POST …/archive`.
 * - `PUT /api/v1/goals/:id/reminders` (`preview: true` → `{ moments }`); `PUT …/my-reminders`.
 * - `GET /api/v1/goals/:id/history?before=`; `PATCH /api/v1/goals/settings`.
 *
 * Recurring series (S30b):
 *
 * - `POST /api/v1/goal-series` creates (`preview: true` → the first and next periods).
 * - `GET|PATCH|DELETE /api/v1/goal-series/:id` (detail; edit, for later periods; to the trash).
 * - `POST /api/v1/goal-series/:id/state` (pause, resume, stop).
 * - `POST /api/v1/goal-series/:id/target` (from a period on; `preview: true` → `{ impact }`).
 * - `GET /api/v1/goal-series/:id/periods?before=` (newest first).
 *
 * `409 conflict` (with the current `revision`) means someone changed it since it was read; a refused
 * change answers `409` with its reason and, where it explains it, the goal as it is now.
 */
export const GOALS_ENDPOINT = "/api/v1/goals";
export const GOAL_SETTINGS_ENDPOINT = "/api/v1/goals/settings";
export const GOAL_SERIES_ENDPOINT = "/api/v1/goal-series";

export function goalSeriesEndpoint(
  seriesId: string,
  part?: "state" | "target" | "periods",
): string {
  const base = `${GOAL_SERIES_ENDPOINT}/${encodeURIComponent(seriesId)}`;
  return part ? `${base}/${part}` : base;
}

export function goalEndpoint(
  goalId: string,
  part?:
    "target" | "entries" | "achievement" | "archive" | "reminders" | "my-reminders" | "history",
): string {
  const base = `${GOALS_ENDPOINT}/${encodeURIComponent(goalId)}`;
  return part ? `${base}/${part}` : base;
}

export function goalEntryEndpoint(entryId: string): string {
  return `/api/v1/goal-entries/${encodeURIComponent(entryId)}`;
}

export type GoalErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "conflict"
  | "id-taken"
  | "invalid-dates"
  | "limit-reached"
  | "archived"
  | "achieved"
  | "not-measurable"
  | "stale"
  | "already-reversed"
  | "negative-total"
  | "target-not-reached"
  | "confirm-unit"
  | "confirm-status"
  | "no-deadline"
  | "period-ended"
  | "series-period"
  | "invalid-period"
  | "stopped"
  | "failed";

export interface GoalErrorResponse {
  readonly error: GoalErrorCode;
  readonly revision?: number;
  readonly fields?: readonly string[];
  readonly impact?: GoalTargetImpact;
  readonly goal?: GoalSummary;
}

/** What a refused or failed request means to the person. */
export type GoalFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "conflict"
  | "idTaken"
  | "invalidDates"
  | "limitReached"
  | "archived"
  | "achieved"
  | "notMeasurable"
  | "stale"
  | "alreadyReversed"
  | "negativeTotal"
  | "targetNotReached"
  | "confirmUnit"
  | "confirmStatus"
  | "noDeadline"
  | "periodEnded"
  | "seriesPeriod"
  | "invalidPeriod"
  | "stopped"
  | "network"
  | "failed";

const failures: { readonly [C in GoalErrorCode]?: GoalFailure } = {
  unauthenticated: "signedOut",
  invalid: "invalid",
  "not-found": "notFound",
  "not-permitted": "notPermitted",
  conflict: "conflict",
  "id-taken": "idTaken",
  "invalid-dates": "invalidDates",
  "limit-reached": "limitReached",
  archived: "archived",
  achieved: "achieved",
  "not-measurable": "notMeasurable",
  stale: "stale",
  "already-reversed": "alreadyReversed",
  "negative-total": "negativeTotal",
  "target-not-reached": "targetNotReached",
  "confirm-unit": "confirmUnit",
  "confirm-status": "confirmStatus",
  "no-deadline": "noDeadline",
  "period-ended": "periodEnded",
  "series-period": "seriesPeriod",
  "invalid-period": "invalidPeriod",
  stopped: "stopped",
};

export class GoalRequestError extends Error {
  constructor(
    readonly failure: GoalFailure,
    /** What came with the refusal: the current revision, an impact, the goal as it is now. */
    readonly details: Omit<GoalErrorResponse, "error"> = {},
  ) {
    super(`Goal request failed: ${failure}`);
    this.name = "GoalRequestError";
  }
}

/** Sends one request; resolves with the JSON answer or rejects with a GoalRequestError. */
export async function sendGoalRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
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
    throw new GoalRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = (payload && typeof payload === "object" ? payload : {}) as GoalErrorResponse;
    const code = typeof record.error === "string" ? record.error : "failed";
    const { error: _error, ...details } = record;
    throw new GoalRequestError(failures[code] ?? "failed", details);
  }
  return payload as T;
}
