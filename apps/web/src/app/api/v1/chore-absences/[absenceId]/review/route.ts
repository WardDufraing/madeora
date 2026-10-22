import { failure, json, pathId, requireReader } from "@/chores/route-helpers";
import { listAbsenceReview } from "@/vacations/data";

interface AbsenceReviewRouteContext {
  readonly params: Promise<{ readonly absenceId: string }>;
}

/**
 * An absence's affected chores (S22; its member and chore managers): their work due during it and
 * overdue before it, with decisions, and planned dates of their recurring chores.
 */
export async function GET(
  _request: Request,
  { params }: AbsenceReviewRouteContext,
): Promise<Response> {
  const unauthenticated = await requireReader();
  if (unauthenticated) return unauthenticated;
  const id = pathId((await params).absenceId);
  if (!id) return failure(404, "not-found");
  const review = await listAbsenceReview(id);
  if (review.status === "not-found") return failure(404, "not-found");
  if (review.status === "unavailable") return failure(500, "failed");
  return json(200, review.value);
}
