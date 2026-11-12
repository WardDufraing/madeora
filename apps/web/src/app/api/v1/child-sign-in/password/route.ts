import { readSignInRequest, signInResponse } from "@/child-sign-in/route-helpers";
import { passwordSignInSchema } from "@/child-sign-in/schema";
import { signInChildWithPassword } from "@/child-sign-in/service";

const MAX_BODY_BYTES = 512;

/**
 * A child's username and password sign-in (S42; spec "Confirmed guardian-managed child sign-in"):
 * works only where the child's primary guardian turned on independent sign-in. Wrong and unknown
 * usernames get the same answer; tries are limited and lock out (database, not this handler).
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readSignInRequest(request, passwordSignInSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  return signInResponse(await signInChildWithPassword(input.data.username, input.data.password));
}
