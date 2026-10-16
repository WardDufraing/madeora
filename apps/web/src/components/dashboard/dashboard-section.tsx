import "server-only";

import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { ErrorState } from "@/components/ui/states";
import { loadDashboard } from "@/dashboard/server";
import type { DashboardTarget } from "@/dashboard/schema";
import type { SourceHome } from "@/dashboard/view-types";

import { DashboardBoard } from "./dashboard-board";
import { renderWidgets, type WidgetScope } from "./widget-content";

/**
 * Loads a dashboard with the viewer's own session and renders it (S17): the stored layout (or the
 * starter, until the first save), each widget's content, and the Homes widgets may come from. The
 * templates are loaded by edit mode itself, so normal use never fetches them.
 */
export async function DashboardSection({
  scope,
  emptyState,
}: {
  readonly scope: WidgetScope;
  readonly emptyState: ReactNode;
}) {
  const homeId = scope.kind === "home" ? scope.home.id : null;
  const [t, result] = await Promise.all([
    getTranslations("Dashboard"),
    loadDashboard(scope.kind, homeId),
  ]);
  if (result.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const { dashboard } = result;
  const target: DashboardTarget =
    scope.kind === "home" ? { kind: "home", homeId: scope.home.id } : { kind: "personal" };

  const widgets = await renderWidgets(dashboard.layout, scope);
  const sourceHomes: SourceHome[] =
    scope.kind === "personal" ? scope.homes.map((home) => ({ id: home.id, name: home.name })) : [];

  return (
    <DashboardBoard
      target={target}
      layout={dashboard.layout}
      revision={dashboard.revision}
      canEdit={dashboard.canEdit}
      canUndo={dashboard.canUndo}
      dropped={dashboard.dropped}
      widgets={widgets}
      sourceHomes={sourceHomes}
      emptyState={emptyState}
    />
  );
}
