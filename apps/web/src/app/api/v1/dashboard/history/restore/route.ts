import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listHistory } from "@/dashboard/history-server";
import {
  databaseFailure,
  failure,
  readDashboardMutation,
  revisionAnswer,
  SMALL_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { restoreVersionSchema } from "@/dashboard/schema";
import { loadTarget } from "@/dashboard/server";

/**
 * Restores a history version of a dashboard (UX2c; redesign decision 32) as a new commit: the
 * layout it replaces becomes the newest-but-one version and can be undone once, so nothing is lost.
 *
 * `POST { target, versionId, expectedRevision }` → `200 { revision }`. `404` when the version is
 * not one of `target`'s (another person's, another Home's, or rotated out), `403` for someone who
 * may not edit the dashboard, `409 conflict` (with the current revision) when it was saved since.
 * The database decides ownership, rights and the revision again in one transaction.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDashboardMutation(request, restoreVersionSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const { target, versionId, expectedRevision } = input.data;

  const current = await loadTarget(target);
  if (current.status === "not-found") return failure(404, "not-found");
  if (current.status === "unavailable") return failure(500, "unavailable");
  if (!current.dashboard.canEdit) return failure(403, "not-permitted");

  // The database finds the dashboard from the version alone; this keeps a request for one
  // dashboard from restoring another the person also owns (their personal one from a Home page).
  const history = await listHistory(target);
  if (history.status === "not-found") return failure(403, "not-permitted");
  if (history.status === "unavailable") return failure(500, "unavailable");
  if (!history.versions.some((version) => version.id === versionId)) {
    return failure(404, "not-found");
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("restore_dashboard_version", {
    p_version_id: versionId,
    p_expected_revision: expectedRevision,
  });
  if (error) return databaseFailure("dashboard.restore_failed", error);
  const row = data[0];
  if (row?.outcome === "not_found") return failure(404, "not-found");
  return revisionAnswer("dashboard.restore_failed", row);
}
