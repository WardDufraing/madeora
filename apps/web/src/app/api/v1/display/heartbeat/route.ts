import { z } from "zod";

import { getAuthState } from "@/auth/identity";
import { displayJson, readDisplayRequest } from "@/displays/route-helpers";
import { getDisplaySession } from "@/displays/server";

const MAX_BODY_BYTES = 16;

/**
 * A paired display's regular check (S43): the server still accepts it (and notes that it was
 * seen), or `401 not-paired` once it was revoked or its Home closed, so the screen returns to the
 * pairing screen without showing anything it had.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDisplayRequest(request, z.strictObject({}), MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  if ((await getAuthState()).kind !== "display") return displayJson(401, { error: "not-paired" });
  const result = await getDisplaySession();
  if (result.kind === "refused") return displayJson(401, { error: "not-paired" });
  if (result.kind === "unavailable") return displayJson(503, { error: "unavailable" });
  return displayJson(200, {
    displayName: result.session.displayName,
    homeName: result.session.homeName,
    homeTimezone: result.session.homeTimezone,
  });
}
