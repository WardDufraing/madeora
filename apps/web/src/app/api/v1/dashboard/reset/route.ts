import {
  failure,
  persistLayout,
  readDashboardMutation,
  SMALL_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { resetDashboardSchema } from "@/dashboard/schema";
import { loadTarget } from "@/dashboard/server";
import { starterLayout } from "@/dashboard/starter";

/**
 * Puts a dashboard back to the starter layout (S17; spec: "a reversible reset-to-starter-layout
 * action ... that does not delete underlying personal records"). Only the arrangement changes; what
 * it replaced is kept for one Undo. The starter is stored as a copy, so later starter changes still
 * never touch it.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDashboardMutation(request, resetDashboardSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const { target, expectedRevision } = input.data;

  const current = await loadTarget(target);
  if (current.status === "not-found") return failure(404, "not-found");
  if (current.status === "unavailable") return failure(500, "unavailable");
  if (!current.dashboard.canEdit) return failure(403, "not-permitted");

  return persistLayout(
    "dashboard.reset_failed",
    target,
    starterLayout(target.kind),
    expectedRevision,
    current.dashboard.layout,
  );
}
