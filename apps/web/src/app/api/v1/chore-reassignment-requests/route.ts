import { z } from "zod";

import { listReassignmentRequests } from "@/chores/data";
import { failure, json, requireReader } from "@/chores/route-helpers";

/**
 * The caller's open reassignment requests in a Home (S21): waiting for their answer, made by them,
 * and for chore managers those waiting for confirmation. A Home the person is not in is not found.
 */
export async function GET(request: Request): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const homeId = z.uuid().safeParse(new URL(request.url).searchParams.get("homeId"));
  if (!homeId.success) return failure(400, "invalid");
  const requests = await listReassignmentRequests(homeId.data);
  if (requests.status === "not-found") return failure(404, "not-found");
  if (requests.status === "unavailable") return failure(500, "failed");
  return json(200, { requests: requests.value });
}
