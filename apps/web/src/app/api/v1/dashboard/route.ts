import { checkLayout } from "@/dashboard/layout";
import {
  failure,
  persistLayout,
  readDashboardMutation,
  SAVE_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { saveDashboardSchema } from "@/dashboard/schema";
import { layoutContextFor, loadTarget } from "@/dashboard/server";

/**
 * Saves a dashboard edited in edit mode (S17): the person's own personal dashboard, or a Home's when
 * they may edit it (the Owner, or an Administrator granted "Manage Home dashboard"). The layout must
 * meet every rule of the versioned schema (known widget types on the right dashboard, valid
 * settings, every widget placed inside the grid without overlaps), and a personal widget may only be
 * bound to a Home the person belongs to. The database checks membership, authority and the revision
 * again: a save from an outdated copy answers 409 instead of overwriting someone else's change.
 */
export async function PUT(request: Request): Promise<Response> {
  const input = await readDashboardMutation(request, saveDashboardSchema, SAVE_BODY_BYTES);
  if (!input.ok) return input.response;
  const { target, layout, expectedRevision } = input.data;

  const current = await loadTarget(target);
  if (current.status === "not-found") return failure(404, "not-found");
  if (current.status === "unavailable") return failure(500, "unavailable");
  if (!current.dashboard.canEdit) return failure(403, "not-permitted");

  const context = await layoutContextFor(target, current.dashboard.layout);
  if (!context) return failure(500, "unavailable");
  const checked = checkLayout(layout, context);
  if (!checked.ok) return failure(400, "invalid", { fields: [`layout.${checked.issue}`] });

  return persistLayout("dashboard.save_failed", target, checked.layout, expectedRevision, null);
}
