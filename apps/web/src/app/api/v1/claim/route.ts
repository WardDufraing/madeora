import { claimTransition } from "@/child-transition/service";
import { claimSchema } from "@/child-transition/schema";
import { noStoreJson, readOpenRequest } from "@/child-transition/route-helpers";

const MAX_BODY_BYTES = 512;

/**
 * The young person gives the email address they control (S42 part 3). No session: the claim
 * link's secret is the key. A verification link goes to that address; nothing changes yet.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readOpenRequest(request, claimSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  switch (await claimTransition(input.data.token, input.data.email)) {
    case "sent":
      return noStoreJson(200, {});
    case "invalid":
      return noStoreJson(404, { error: "invalid" });
    case "invalid_email":
      return noStoreJson(400, { error: "invalid-email" });
    case "email_taken":
      return noStoreJson(409, { error: "email-taken" });
    case "rate_limited":
      return noStoreJson(429, { error: "rate-limited" });
    case "unavailable":
      return noStoreJson(503, { error: "unavailable" });
  }
}
