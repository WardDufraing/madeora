import type { HabitCheckin, HabitSummary } from "./shapes";

export type {
  HabitBlock,
  HabitCalendar,
  HabitCheckin,
  HabitCheckinResult,
  HabitDay,
  HabitDetail,
  HabitEvent,
  HabitInsights,
  HabitList,
  HabitMilestone,
  HabitScheduleVersion,
  HabitStreak,
  HabitSummary,
  HabitWeek,
  VacationHabits,
} from "./shapes";

/**
 * The HTTP contract of habits (S28). Every mutation is same-origin JSON, checked again by the
 * database with the person's own session. Ids of new habits and check-ins come from the client, so
 * a retry returns the same row instead of a second one.
 *
 * - `GET /api/v1/habits?homeId&view=active|ended|archived&q` → `200 { list }`; `POST` creates.
 * - `GET|PATCH|DELETE /api/v1/habits/:id` (detail; edit; to the trash).
 * - `POST /api/v1/habits/:id/schedule|end|reactivate|pauses` with `preview: true` → `200 { impact }`
 *   without changing anything; `PATCH /api/v1/habits/:id/pauses/:pauseId`.
 * - `POST /api/v1/habits/:id/archive`; `PUT /api/v1/habits/:id/reminders|my-reminders`.
 * - `GET /api/v1/habits/:id/insights?days`, `…/calendar?month=YYYY-MM`, `…/history?kind&before`.
 * - `POST /api/v1/habits/:id/checkins`; `POST /api/v1/habit-checkins/:id/undo`; `PATCH …/note`.
 * - `POST /api/v1/habit-reminders/:notificationId/snooze`.
 * - `PATCH /api/v1/habits/settings` (`{ homeId, memberAccess }` or `{ celebrations }`).
 * - `GET|PUT /api/v1/vacations/:id/habits` (the person's own personal habit switches).
 *
 * `409 conflict` (with the current `revision`) means someone changed it since it was read; a
 * refused check-in answers `409` with its reason (`already-completed` with who did it,
 * `target-reached`, `outside-window`, …) and the habit as it is now.
 */
export const HABITS_ENDPOINT = "/api/v1/habits";
export const HABIT_SETTINGS_ENDPOINT = "/api/v1/habits/settings";

export function habitEndpoint(
  habitId: string,
  part?:
    | "schedule"
    | "end"
    | "reactivate"
    | "pauses"
    | "archive"
    | "reminders"
    | "my-reminders"
    | "insights"
    | "calendar"
    | "history"
    | "checkins",
): string {
  const base = `${HABITS_ENDPOINT}/${encodeURIComponent(habitId)}`;
  return part ? `${base}/${part}` : base;
}

export function habitPauseEndpoint(habitId: string, pauseId: string): string {
  return `${habitEndpoint(habitId, "pauses")}/${encodeURIComponent(pauseId)}`;
}

export function habitCheckinEndpoint(checkinId: string, part: "undo" | "note"): string {
  return `/api/v1/habit-checkins/${encodeURIComponent(checkinId)}/${part}`;
}

export function habitSnoozeEndpoint(notificationId: string): string {
  return `/api/v1/habit-reminders/${encodeURIComponent(notificationId)}/snooze`;
}

export function vacationHabitsEndpoint(vacationId: string): string {
  return `/api/v1/vacations/${encodeURIComponent(vacationId)}/habits`;
}

export type HabitErrorCode =
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
  | "ended"
  | "not-ended"
  | "checkins-after-end"
  | "already-paused"
  | "pause-ended"
  | "already-completed"
  | "target-reached"
  | "outside-window"
  | "untracked"
  | "not-scheduled"
  | "paused"
  | "future"
  | "already-undone"
  | "already-snoozed"
  | "not-needed"
  | "window-closed"
  | "quiet-hours"
  | "not-participant"
  | "failed";

export interface HabitErrorResponse {
  readonly error: HabitErrorCode;
  readonly revision?: number;
  readonly fields?: readonly string[];
  readonly impact?: unknown;
  readonly habit?: HabitSummary;
  readonly checkin?: HabitCheckin;
  readonly dueAt?: string;
}

/** What a refused or failed request means to the person. */
export type HabitFailure =
  | "signedOut"
  | "invalid"
  | "notFound"
  | "notPermitted"
  | "conflict"
  | "idTaken"
  | "invalidDates"
  | "limitReached"
  | "archived"
  | "ended"
  | "notEnded"
  | "checkinsAfterEnd"
  | "alreadyPaused"
  | "pauseEnded"
  | "alreadyCompleted"
  | "targetReached"
  | "outsideWindow"
  | "untracked"
  | "notScheduled"
  | "paused"
  | "future"
  | "alreadyUndone"
  | "alreadySnoozed"
  | "notNeeded"
  | "windowClosed"
  | "quietHours"
  | "notParticipant"
  | "network"
  | "failed";

const failures: { readonly [C in HabitErrorCode]?: HabitFailure } = {
  unauthenticated: "signedOut",
  invalid: "invalid",
  "not-found": "notFound",
  "not-permitted": "notPermitted",
  conflict: "conflict",
  "id-taken": "idTaken",
  "invalid-dates": "invalidDates",
  "limit-reached": "limitReached",
  archived: "archived",
  ended: "ended",
  "not-ended": "notEnded",
  "checkins-after-end": "checkinsAfterEnd",
  "already-paused": "alreadyPaused",
  "pause-ended": "pauseEnded",
  "already-completed": "alreadyCompleted",
  "target-reached": "targetReached",
  "outside-window": "outsideWindow",
  untracked: "untracked",
  "not-scheduled": "notScheduled",
  paused: "paused",
  future: "future",
  "already-undone": "alreadyUndone",
  "already-snoozed": "alreadySnoozed",
  "not-needed": "notNeeded",
  "window-closed": "windowClosed",
  "quiet-hours": "quietHours",
  "not-participant": "notParticipant",
};

export class HabitRequestError extends Error {
  constructor(
    readonly failure: HabitFailure,
    /** What came with the refusal: the current revision, an impact, the habit as it is now. */
    readonly details: Omit<HabitErrorResponse, "error"> = {},
  ) {
    super(`Habit request failed: ${failure}`);
    this.name = "HabitRequestError";
  }
}

/** Sends one request; resolves with the JSON answer or rejects with a HabitRequestError. */
export async function sendHabitRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
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
    throw new HabitRequestError("network");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = (payload && typeof payload === "object" ? payload : {}) as HabitErrorResponse;
    const code = typeof record.error === "string" ? record.error : "failed";
    const { error: _error, ...details } = record;
    throw new HabitRequestError(failures[code] ?? "failed", details);
  }
  return payload as T;
}
