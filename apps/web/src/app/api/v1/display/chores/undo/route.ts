import { undoChoreOnDisplay } from "@/displays/display-actions";
import { displayUndoSchema } from "@/displays/display-actions-route";
import { displayJson, readDisplayRequest, requireDisplay } from "@/displays/route-helpers";

const MAX_BODY_BYTES = 128;

/** Undoes a completion this display made in the last two minutes (S44). */
export async function POST(request: Request): Promise<Response> {
  const input = await readDisplayRequest(request, displayUndoSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const display = await requireDisplay();
  if (!display.ok) return display.response;
  const result = await undoChoreOnDisplay(display.displayId, input.data.actionId);
  if (result === "undone") return displayJson(200, {});
  if (result === "unavailable") return displayJson(503, { error: "unavailable" });
  return displayJson(409, { error: result });
}
