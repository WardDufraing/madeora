import { z } from "zod";

import { listVolunteerOffers } from "@/chores/data";
import { failure, json, requireReader } from "@/chores/route-helpers";

/**
 * The caller's open volunteer invitations in a Home (S21), with only what they need to decide: the
 * chore's title, due day, instructions, checklist and estimate, and the deadline.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const offers = await listVolunteerOffers(homeId.data);
  if (offers.status === "not-found") return failure(404, "not-found");
  if (offers.status === "unavailable") return failure(500, "failed");
  return json(200, { offers: offers.value });
}
