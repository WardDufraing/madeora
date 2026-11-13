import type { OraPatch } from "./settings";

/** The browser's caller for `PATCH /api/v1/me/ora` (versioned, so later mobile clients can use it). */
export const ORA_SETTINGS_ENDPOINT = "/api/v1/me/ora";

export type OraSaveFailure = "signedOut" | "forbidden" | "invalid" | "network" | "failed";

export class OraSaveError extends Error {
  constructor(readonly failure: OraSaveFailure) {
    super(`Saving Ora settings failed: ${failure}`);
    this.name = "OraSaveError";
  }
}

/** Saves a change to the signed-in person's own Ora settings. */
export async function saveOraSettings(patch: OraPatch): Promise<void> {
  let response: Response;
  try {
    response = await fetch(ORA_SETTINGS_ENDPOINT, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new OraSaveError("network");
  }
  if (response.status === 401) throw new OraSaveError("signedOut");
  if (response.status === 403) throw new OraSaveError("forbidden");
  if (response.status === 400) throw new OraSaveError("invalid");
  if (!response.ok) throw new OraSaveError("failed");
}
