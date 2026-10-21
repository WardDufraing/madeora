import { z } from "zod";

import { listChoreApprovals } from "@/chores/data";
import { failure, json, requireReader } from "@/chores/route-helpers";

/**
 * The Home's review queue (S20): every submission waiting for approval, oldest first, for chore
 * reviewers; anyone else in the Home gets an empty list. A Home the person is not in is not found.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const approvals = await listChoreApprovals(homeId.data);
  if (approvals.status === "not-found") return failure(404, "not-found");
  if (approvals.status === "unavailable") return failure(500, "failed");
  return json(200, { approvals: approvals.value });
}
