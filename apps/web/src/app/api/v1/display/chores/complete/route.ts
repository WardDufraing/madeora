import { completeChoreOnDisplay } from "@/displays/display-actions";
import { displayChoreResponse, displayCompleteSchema } from "@/displays/display-actions-route";
import { readDisplayRequest, requireDisplay } from "@/displays/route-helpers";

const MAX_BODY_BYTES = 256;

/**
 * Completes a chore on a paired display for the member who did it (S44), with their PIN when the
 * Home, the member or the chore requires one, or they chose to confirm with it.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDisplayRequest(request, displayCompleteSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const display = await requireDisplay();
  if (!display.ok) return display.response;
  return displayChoreResponse(
    await completeChoreOnDisplay(
      display.displayId,
      input.data.occurrenceId,
      input.data.membershipId,
      input.data.pin,
    ),
  );
}
