import { currentDeviceHash } from "@/child-sign-in/device";
import { readSignInRequest, signInFailure, signInResponse } from "@/child-sign-in/route-helpers";
import { pinSignInSchema } from "@/child-sign-in/schema";
import { signInChildWithPin } from "@/child-sign-in/service";

const MAX_BODY_BYTES = 256;

/**
 * A child's PIN sign-in (S42): only from a browser carrying an approved household device's cookie,
 * and only for a child of that device's Home with PIN sign-in on. A PIN is never accepted
 * anywhere else, so it is not an internet-facing credential.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readSignInRequest(request, pinSignInSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  const deviceHash = await currentDeviceHash();
  if (!deviceHash) return signInFailure(403, "device-not-approved");
  return signInResponse(
    await signInChildWithPin(deviceHash, input.data.childMembershipId, input.data.pin),
  );
}
