import {
  deviceJson,
  deviceUndoSchema,
  readDeviceRequest,
} from "@/child-sign-in/device-chores-route";
import { undoChoreOnDevice } from "@/child-sign-in/device-chores";

const MAX_BODY_BYTES = 128;

/** Undoes a completion this device made in the last two minutes (S42 part 2). */
export async function POST(request: Request): Promise<Response> {
  const input = await readDeviceRequest(request, deviceUndoSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const result = await undoChoreOnDevice(input.deviceHash, input.data.actionId);
  if (result === "undone") return deviceJson(200, {});
  if (result === "unavailable") return deviceJson(503, { error: "unavailable" });
  return deviceJson(409, { error: result });
}
