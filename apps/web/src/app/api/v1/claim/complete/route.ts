import { completeTransition } from "@/child-transition/service";
import { completeTransitionSchema } from "@/child-transition/schema";
import { noStoreJson, readOpenRequest } from "@/child-transition/route-helpers";

const MAX_BODY_BYTES = 256;

/**
 * Completes the move to an independent account (S42 part 3), from the link emailed to the
 * young person's own address. A retry of a completed link answers the same.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readOpenRequest(request, completeTransitionSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  switch (await completeTransition(input.data.token)) {
    case "completed":
      return noStoreJson(200, {});
    case "invalid":
      return noStoreJson(404, { error: "invalid" });
    case "email_taken":
      return noStoreJson(409, { error: "email-taken" });
    case "unavailable":
      return noStoreJson(503, { error: "unavailable" });
  }
}
