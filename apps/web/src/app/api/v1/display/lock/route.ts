import { lockOnDisplay, lockOnDisplayBySession } from "@/displays/display-actions";
import { displayLockResponse, displayLockSchema } from "@/displays/display-actions-route";
import { readDisplayRequest, requireDisplay } from "@/displays/route-helpers";

const MAX_BODY_BYTES = 128;

/**
 * Locks this display on the display itself (S44): a manager of its Home confirms with their own
 * PIN, or (UX8a, `pin: null`) with their open protected-actions session on this display. There is
 * no unlock route: unlocking needs a manager's own signed-in session.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDisplayRequest(request, displayLockSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const display = await requireDisplay();
  if (!display.ok) return display.response;
  const { membershipId, pin } = input.data;
  return displayLockResponse(
    pin === null
      ? await lockOnDisplayBySession(display.displayId, membershipId)
      : await lockOnDisplay(display.displayId, membershipId, pin),
  );
}
