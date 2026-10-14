import type { CreateHomeInput, HomeSettingsPatchInput } from "./schema";
import type { HomeSummary } from "./types";

/**
 * The HTTP contract of the Home endpoints (versioned, so later mobile clients can use them too),
 * and the browser's callers for them:
 *
 * - `POST /api/v1/homes` creates a Home; the caller becomes its Owner. `201 { home: { id } }`.
 * - `PATCH /api/v1/homes/{homeId}` changes some settings. `200 { home: HomeSummary }`.
 *
 * A Home the caller does not belong to answers `404 not-found`, whether or not it exists; a Home
 * they belong to without the right to the change answers `403 not-permitted`.
 */
export const HOMES_ENDPOINT = "/api/v1/homes";

export function homeEndpoint(homeId: string): string {
  return `${HOMES_ENDPOINT}/${encodeURIComponent(homeId)}`;
}

export type HomesErrorCode =
  | "forbidden"
  | "unsupported-media-type"
  | "too-large"
  | "unauthenticated"
  | "invalid"
  | "not-found"
  | "not-permitted"
  | "failed";

export interface HomesErrorResponse {
  readonly error: HomesErrorCode;
  /** For `invalid`: the fields that were refused. */
  readonly fields?: readonly string[];
}

export interface CreateHomeResponse {
  readonly home: { readonly id: string };
}

export interface HomeSettingsResponse {
  readonly home: HomeSummary;
}

export type HomeSaveFailure =
  "signedOut" | "invalid" | "notFound" | "notPermitted" | "network" | "failed";

export class HomeSaveError extends Error {
  constructor(readonly failure: HomeSaveFailure) {
    super(`Saving the Home failed: ${failure}`);
    this.name = "HomeSaveError";
  }
}

async function send(url: string, method: "POST" | "PATCH", body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new HomeSaveError("network");
  }
  if (response.status === 401) throw new HomeSaveError("signedOut");
  if (response.status === 400) throw new HomeSaveError("invalid");
  if (response.status === 404) throw new HomeSaveError("notFound");
  if (response.status === 403) {
    const refused = (await response.json().catch(() => ({}))) as Partial<HomesErrorResponse>;
    throw new HomeSaveError(refused.error === "not-permitted" ? "notPermitted" : "failed");
  }
  if (!response.ok) throw new HomeSaveError("failed");
  return response.json().catch(() => ({}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Creates a Home; repeating the same `requestId` returns the same Home. */
export async function createHome(input: CreateHomeInput): Promise<{ readonly id: string }> {
  const body = await send(HOMES_ENDPOINT, "POST", input);
  const home = isRecord(body) ? body.home : undefined;
  if (!isRecord(home) || typeof home.id !== "string") throw new HomeSaveError("failed");
  return { id: home.id };
}

/** Changes some of a Home's settings and returns the Home as saved. */
export async function updateHomeSettings(
  homeId: string,
  patch: HomeSettingsPatchInput,
): Promise<HomeSummary> {
  const body = await send(homeEndpoint(homeId), "PATCH", patch);
  const home = isRecord(body) ? body.home : undefined;
  if (
    !isRecord(home) ||
    typeof home.id !== "string" ||
    typeof home.name !== "string" ||
    typeof home.timeZone !== "string"
  ) {
    throw new HomeSaveError("failed");
  }
  return { id: home.id, name: home.name, timeZone: home.timeZone };
}
