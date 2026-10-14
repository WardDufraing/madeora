import { homeEndpoint, type HomesErrorCode } from "@/homes/api";

import {
  parseHomeProfile,
  type HomeProfileOverrides,
  type HomeProfilePatchInput,
} from "./profile-schema";

/**
 * The HTTP contract of `PATCH /api/v1/homes/{homeId}/profile` (S11; versioned, so later mobile
 * clients can use it too) and the browser's caller for it. It changes only the caller's own
 * presentation in that Home and answers `200 { profile }` with all three fields. A Home the caller
 * does not belong to answers `404 not-found`, whether or not it exists.
 */
export function homeProfileEndpoint(homeId: string): string {
  return `${homeEndpoint(homeId)}/profile`;
}

export interface HomeProfileResponse {
  readonly profile: HomeProfileOverrides;
}

export interface HomeProfileErrorResponse {
  readonly error: HomesErrorCode;
  /** For `invalid`: the fields that were refused. */
  readonly fields?: readonly string[];
}

export type HomeProfileSaveFailure = "signedOut" | "invalid" | "notFound" | "network" | "failed";

export class HomeProfileSaveError extends Error {
  constructor(readonly failure: HomeProfileSaveFailure) {
    super(`Saving the Home profile failed: ${failure}`);
    this.name = "HomeProfileSaveError";
  }
}

/** Saves a change to the signed-in person's own presentation in `homeId`. */
export async function saveHomeProfile(
  homeId: string,
  patch: HomeProfilePatchInput,
): Promise<HomeProfileOverrides> {
  let response: Response;
  try {
    response = await fetch(homeProfileEndpoint(homeId), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new HomeProfileSaveError("network");
  }
  if (response.status === 401) throw new HomeProfileSaveError("signedOut");
  if (response.status === 400) throw new HomeProfileSaveError("invalid");
  if (response.status === 404) throw new HomeProfileSaveError("notFound");
  if (!response.ok) throw new HomeProfileSaveError("failed");
  const body = (await response.json().catch(() => ({}))) as Partial<HomeProfileResponse>;
  if (typeof body.profile !== "object") throw new HomeProfileSaveError("failed");
  return parseHomeProfile({ ...body.profile });
}
