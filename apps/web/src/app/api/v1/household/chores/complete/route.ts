import {
  deviceChoreResponse,
  deviceCompleteSchema,
  readDeviceRequest,
} from "@/child-sign-in/device-chores-route";
import { completeChoreOnDevice } from "@/child-sign-in/device-chores";

const MAX_BODY_BYTES = 256;

/**
 * Completes a chore on an approved household device for the member who did it (S42 part 2), with
 * their PIN when the Home requires one or they chose to confirm with it.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDeviceRequest(request, deviceCompleteSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  return deviceChoreResponse(
    await completeChoreOnDevice(
      input.deviceHash,
      input.data.occurrenceId,
      input.data.membershipId,
      input.data.pin,
    ),
  );
}
