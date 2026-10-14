import {
  parseStoredPreferences,
  type PreferencesPatchInput,
  type StoredPreferences,
} from "./schema";

/**
 * The HTTP contract of `PATCH /api/v1/me/preferences` (versioned, so later mobile clients can use
 * it too), and the browser's caller for it.
 */
export const PREFERENCES_ENDPOINT = "/api/v1/me/preferences";

export type PreferencesErrorCode =
  "forbidden" | "unsupported-media-type" | "too-large" | "unauthenticated" | "invalid" | "failed";

export interface PreferencesResponse {
  readonly preferences: StoredPreferences;
}

export interface PreferencesErrorResponse {
  readonly error: PreferencesErrorCode;
  /** For `invalid`: the fields that were refused. */
  readonly fields?: readonly string[];
}

export type SaveFailure = "signedOut" | "invalid" | "network" | "failed";

export class PreferencesSaveError extends Error {
  constructor(readonly failure: SaveFailure) {
    super(`Saving preferences failed: ${failure}`);
    this.name = "PreferencesSaveError";
  }
}

/** Saves a change to the signed-in account's preferences and returns all saved preferences. */
export async function savePreferences(patch: PreferencesPatchInput): Promise<StoredPreferences> {
  let response: Response;
  try {
    response = await fetch(PREFERENCES_ENDPOINT, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new PreferencesSaveError("network");
  }
  if (response.status === 401) throw new PreferencesSaveError("signedOut");
  if (response.status === 400) throw new PreferencesSaveError("invalid");
  if (!response.ok) throw new PreferencesSaveError("failed");
  const body = (await response.json().catch(() => ({}))) as Partial<PreferencesResponse>;
  if (typeof body.preferences !== "object") throw new PreferencesSaveError("failed");
  return parseStoredPreferences({ ...body.preferences });
}
