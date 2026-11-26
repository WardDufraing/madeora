import { z } from "zod";

import { getVerifiedIdentity } from "@/auth/identity";
import { createSupabaseServerClient } from "@/auth/supabase-server";
import { checkLayout, readLayout } from "@/dashboard/layout";
import {
  databaseFailure,
  failure,
  json,
  layoutJson,
  readDashboardMutation,
  SAVE_BODY_BYTES,
  SMALL_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { discardDraftSchema, saveDraftSchema } from "@/dashboard/schema";
import { targetArgs, targetFromParams } from "@/dashboard/target-args";
import { layoutContextFor, loadTarget, logDashboard } from "@/dashboard/server";

/**
 * The person's recoverable edit-mode draft of one dashboard (UX2b; redesign decision 6), stored by
 * the database (UX2-data), never in the browser: one per person and dashboard, kept 30 days after
 * the last autosave, only for adults, and only for a dashboard they may edit. Every call uses the
 * person's own session, so the database decides again whose draft it is and whether they may still
 * edit that dashboard (a shared-default draft is dropped when the right to edit it is lost).
 * Personal and Home drafts never mix: the target picks exactly one.
 *
 * - `GET ?homeId[&view=mine]` (none: the personal dashboard; `view=mine`: the person's own view of
 *   that Home, UX2d) → `200 { draft: null | { layout, baseRevision,
 *   currentRevision, updatedAt, expiresAt } }`. `currentRevision` ≠ `baseRevision` means someone
 *   committed the dashboard since the draft started: the interface offers keep-or-discard.
 * - `PUT { target, layout, baseRevision }` → `200 { updatedAt }` (autosave; the dashboard itself
 *   is unchanged). `403 not-permitted` when the person may not keep a draft of it.
 * - `DELETE { target }` → `200 { discarded }` (Cancel / Discard draft).
 */

const isUuid = (value: string) => z.uuid().safeParse(value).success;

export async function GET(request: Request): Promise<Response> {
  if (!(await getVerifiedIdentity())) return failure(401, "unauthenticated");
  const target = targetFromParams(new URL(request.url).searchParams, isUuid);
  if (!target) return failure(400, "invalid", { fields: ["homeId"] });
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_dashboard_draft", targetArgs(target));
  if (error) return databaseFailure("dashboard.draft_read_failed", error);
  const row = data[0];
  if (!row) return json(200, { draft: null });
  // Read like a saved layout, so a draft never brings back what the dashboard could not show.
  const { layout } = readLayout(row.layout, target.kind);
  return json(200, {
    draft: {
      layout,
      baseRevision: row.base_revision,
      currentRevision: row.current_revision,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    },
  });
}

export async function PUT(request: Request): Promise<Response> {
  const input = await readDashboardMutation(request, saveDraftSchema, SAVE_BODY_BYTES);
  if (!input.ok) return input.response;
  const { target, layout, baseRevision } = input.data;

  // The same rules as a save: only a dashboard the person may edit, and only a layout they could
  // save (known widgets on the right dashboard, Homes they belong to, nothing overlapping).
  const current = await loadTarget(target);
  if (current.status === "not-found") return failure(404, "not-found");
  if (current.status === "unavailable") return failure(500, "unavailable");
  if (!current.dashboard.canEdit) return failure(403, "not-permitted");
  const context = await layoutContextFor(target, current.dashboard.layout);
  if (!context) return failure(500, "unavailable");
  const checked = checkLayout(layout, context);
  if (!checked.ok) return failure(400, "invalid", { fields: [`layout.${checked.issue}`] });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("save_dashboard_draft", {
    p_layout: layoutJson(checked.layout),
    p_base_revision: baseRevision,
    ...targetArgs(target),
  });
  if (error) return databaseFailure("dashboard.draft_save_failed", error);
  const row = data[0];
  switch (row?.outcome) {
    case "saved":
      return json(200, { updatedAt: row.updated_at });
    case "not_permitted":
      return failure(403, "not-permitted");
    default:
      logDashboard("dashboard.draft_save_failed", "unexpected_outcome");
      return failure(500, "failed");
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const input = await readDashboardMutation(request, discardDraftSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "discard_dashboard_draft",
    targetArgs(input.data.target),
  );
  if (error) return databaseFailure("dashboard.draft_discard_failed", error);
  return json(200, { discarded: data === "discarded" });
}
