import { getAuthState } from "@/auth/identity";
import { readDisplayRequest, displayJson } from "@/displays/route-helpers";
import { pairingRequestSchema } from "@/displays/schema";
import { resumePairing } from "@/displays/service";

const MAX_BODY_BYTES = 64;

/**
 * The unregistered tablet's pairing state (S43; spec "Confirmed manager-approved pairing for
 * household displays"): its code while it waits, `expired` once the code or the approval is too
 * old, and `paired` once a manager approved it (the display session cookies are set on this
 * response). Only for a browser without any session: pairing never replaces or reuses a member's,
 * a child's or another display's session.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDisplayRequest(request, pairingRequestSchema, MAX_BODY_BYTES);
  if (!input.ok) return input.response;
  if ((await getAuthState()).kind !== "signed-out") {
    return displayJson(409, { error: "signed-in" });
  }
  const screen = await resumePairing(input.data.renew, request.headers.get("user-agent") ?? "");
  switch (screen.kind) {
    case "pending":
      return displayJson(200, {
        status: "pending",
        code: screen.code,
        expiresAt: screen.expiresAt,
      });
    case "expired":
      return displayJson(200, { status: "expired" });
    case "paired":
      return displayJson(200, { status: "paired" });
    case "rate-limited":
      return displayJson(429, { error: "rate-limited" });
    case "unavailable":
      return displayJson(503, { error: "unavailable" });
  }
}
