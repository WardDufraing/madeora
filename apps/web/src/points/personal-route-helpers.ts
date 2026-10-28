import "server-only";

import { failure, json } from "@/chores/route-helpers";

import { pointsAnswer } from "./route-helpers";

/**
 * The HTTP answer of a personal points or rewards change (S28b): the Home points answers, with the
 * personal period limit answered like the Home per-member limit (`409 member-limit`).
 */
export function personalPointsAnswer(
  event: string,
  outcome: string | undefined,
  body: object,
  details: { readonly revision?: number | null; readonly nextEligibleOn?: string | null } = {},
): Response {
  if (outcome === "period_limit") {
    return json(409, { error: "member-limit", nextEligibleOn: details.nextEligibleOn ?? null });
  }
  return pointsAnswer(event, outcome, body, details);
}

/**
 * A personal read names no Home: a `homeId` (or any owner) in the query is refused rather than
 * ignored, so nobody mistakes these endpoints for Home ones.
 */
export function refuseOwnerParams(request: Request): Response | null {
  const params = new URL(request.url).searchParams;
  for (const name of ["homeId", "userId", "accountId"]) {
    if (params.has(name)) return failure(400, "invalid", { fields: [name] });
  }
  return null;
}
