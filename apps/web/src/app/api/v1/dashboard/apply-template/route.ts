import { checkLayout, templateCopy } from "@/dashboard/layout";
import {
  failure,
  newWidgetId,
  persistLayout,
  readDashboardMutation,
  SMALL_BODY_BYTES,
} from "@/dashboard/route-helpers";
import { applyTemplateSchema } from "@/dashboard/schema";
import { layoutContextFor, listTemplates, loadTarget } from "@/dashboard/server";
import { builtInTemplates } from "@/dashboard/starter";

/**
 * Applies a template to a dashboard (S17; spec "Users can create personal dashboard templates and
 * share them into Homes with permission controls"; owner decision "split by target"). A template
 * fits one kind of dashboard. Personal templates apply to the person's own dashboard: a built-in
 * one, their own, or one shared into a Home they belong to. Home templates apply to a Home's
 * dashboard by someone who may edit it: a built-in one, their own, or one shared into that Home.
 * The arrangement it replaces is kept for one Undo; the person's records are never touched.
 */
export async function POST(request: Request): Promise<Response> {
  const input = await readDashboardMutation(request, applyTemplateSchema, SMALL_BODY_BYTES);
  if (!input.ok) return input.response;
  const { target, expectedRevision, template } = input.data;

  const current = await loadTarget(target);
  if (current.status === "not-found") return failure(404, "not-found");
  if (current.status === "unavailable") return failure(500, "unavailable");
  if (!current.dashboard.canEdit) return failure(403, "not-permitted");

  let source;
  if ("builtIn" in template) {
    source = builtInTemplates.find((entry) => entry.id === template.builtIn);
    if (source?.kind !== target.kind) return failure(400, "invalid", { fields: ["template"] });
  } else {
    const visible = await listTemplates(null);
    if (visible.status === "unavailable") return failure(500, "unavailable");
    const found =
      visible.status === "ok" ? visible.templates.find((entry) => entry.id === template.id) : null;
    const usable =
      found &&
      found.kind === target.kind &&
      (found.isMine || target.kind === "personal" || found.sharedHomeIds.includes(target.homeId));
    if (!found || !usable) return failure(404, "not-found");
    source = found;
  }

  const copy = templateCopy(source.layout, newWidgetId);
  const context = await layoutContextFor(target, current.dashboard.layout);
  if (!context) return failure(500, "unavailable");
  const checked = checkLayout(copy.layout, context);
  if (!checked.ok) return failure(400, "invalid", { fields: [`layout.${checked.issue}`] });

  return persistLayout(
    "dashboard.apply_failed",
    target,
    checked.layout,
    expectedRevision,
    current.dashboard.layout,
    { dropped: copy.dropped },
  );
}
