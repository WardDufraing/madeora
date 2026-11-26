import "server-only";

import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { ErrorState } from "@/components/ui/states";
import { layoutPreview } from "@/dashboard/preview";
import { loadDashboard, loadSuggestions } from "@/dashboard/server";
import type { DashboardTarget } from "@/dashboard/schema";
import type { HomeViews, SourceHome } from "@/dashboard/view-types";

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
  // A Home shows the person's own view when they have one, else the shared default (UX2d). Both are
  // read, with the person's own session: the shared default for what "return to it" would show and
  // whether they may edit it, their own view for whether they may keep one.
  const [t, shared, mine] = await Promise.all([
    getTranslations("Dashboard"),
    loadDashboard(scope.kind, homeId),
    homeId ? loadDashboard("home", homeId, "mine") : Promise.resolve(null),
  ]);
  if (shared.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  // The viewer's own view could not be read: show the shared default, without offering views.
  const view = homeId && mine?.status === "ok" ? mine.dashboard : null;
  const mineView = view?.hasOverride ? view : null;
  const showingMine = mineView !== null;
  const dashboard = mineView ?? shared.dashboard;
  const target: DashboardTarget =
    scope.kind === "home"
      ? showingMine
        ? { kind: "home", homeId: scope.home.id, view: "mine" }
        : { kind: "home", homeId: scope.home.id }
      : { kind: "personal" };

  let homeViews: HomeViews | null = null;
  if (homeId) {
    const suggestions = showingMine ? await loadSuggestions(homeId) : null;
    homeViews = {
      homeId,
      showing: showingMine ? "mine" : "default",
      canHaveView: view?.canEdit === true,
      canEditShared: shared.dashboard.canEdit,
      shared: {
        layout: shared.dashboard.layout,
        revision: shared.dashboard.revision,
        canUndo: shared.dashboard.canUndo,
        preview: layoutPreview(shared.dashboard.layout),
      },
      suggestions:
        suggestions?.status === "ok"
          ? suggestions.suggestions.map((suggestion) => suggestion.widget)
          : [],
    };
  }

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
      homeViews={homeViews}
    />
  );
}
