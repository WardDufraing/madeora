"use client";

import { useQuery } from "@tanstack/react-query";

import { fetchTemplates, type DashboardRequestError } from "@/dashboard/api";
import type { DashboardTarget } from "@/dashboard/schema";
import { builtInTemplates } from "@/dashboard/starter";
import type { TemplateOption } from "@/dashboard/view-types";
import { isWidgetType } from "@/dashboard/widgets";

/**
 * Typed query key of the person's visible templates. The whole cache is cleared on sign-out and
 * identity changes (AuthSync), so one person's templates never reach the next.
 */
export const dashboardTemplatesKey = ["dashboard", "templates"] as const;

/**
 * The templates the editor offers for `target` (S17), loaded only in edit mode so normal use never
 * fetches them: the built-in starter for that kind of dashboard, then the person's own templates of
 * that kind, then those shared with them. On a Home dashboard only the person's own Home templates
 * and those shared into that Home; the server applies the same rule again.
 */
export function useTemplateOptions(target: DashboardTarget): {
  readonly options: readonly TemplateOption[];
  readonly loading: boolean;
  readonly error: DashboardRequestError | null;
} {
  const query = useQuery<Awaited<ReturnType<typeof fetchTemplates>>, DashboardRequestError>({
    queryKey: dashboardTemplatesKey,
    queryFn: fetchTemplates,
    retry: false,
  });
  const builtIn = builtInTemplates
    .filter((template) => template.kind === target.kind)
    .map((template): TemplateOption => ({
      key: template.id,
      source: "built-in",
      builtIn: template.id,
      widgets: template.layout.widgets.map((w) => w.type),
    }));
  const saved = (query.data ?? [])
    .filter(
      (template) =>
        template.kind === target.kind &&
        (template.isMine ||
          target.kind === "personal" ||
          template.sharedHomeIds.includes(target.homeId)),
    )
    .map((template): TemplateOption => ({
      key: template.id,
      source: template.isMine ? "mine" : "shared",
      id: template.id,
      name: template.name,
      widgets: template.widgets.filter(isWidgetType),
    }));
  return { options: [...builtIn, ...saved], loading: query.isPending, error: query.error };
}
