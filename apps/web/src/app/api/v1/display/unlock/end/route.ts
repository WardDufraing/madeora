import { z } from "zod";

import { endDisplayUnlock } from "@/displays/display-actions";
import { displayJson, readDisplayRequest, requireDisplay } from "@/displays/route-helpers";

const MAX_BODY_BYTES = 16;

/**
 * Lock now (UX8a): ends this display's protected-actions session, if any. The display also calls it
 * when it goes ambient and when the session's time is up on its screen; the server ends the session
 * on its own at expiry either way.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDisplayRequest(request, z.strictObject({}), MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const display = await requireDisplay();
  if (!display.ok) return display.response;
  return (await endDisplayUnlock(display.displayId)) === "ended"
    ? displayJson(200, {})
    : displayJson(503, { error: "unavailable" });
}
