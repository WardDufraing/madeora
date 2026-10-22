import { failure, json, pathId, requireReader } from "@/chores/route-helpers";
import { listVacationReview } from "@/vacations/data";

interface ReviewRouteContext {
  readonly params: Promise<{ readonly vacationId: string }>;
}

/**
 * A vacation's affected chores (S22): what the rules left for a chore manager (fixed, claimed,
 * one-off and changed work, rotations with nobody available, one-off chores on paused dates, work
 * overdue before), with the decisions taken, and planned dates of fixed chores. Every member of the
 * Home sees it; chore managers decide.
 */
export async function GET(_request: Request, { params }: ReviewRouteContext): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).vacationId);
  if (!id) return failure(404, "not-found");
  const review = await listVacationReview(id);
  if (review.status === "not-found") return failure(404, "not-found");
  if (review.status === "unavailable") return failure(500, "failed");
  return json(200, review.value);
}
