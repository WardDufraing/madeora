import "server-only";

import { cache } from "react";

import { createSupabaseServerClient } from "@/auth/supabase-server";
import { listMyHomes } from "@/homes/server";

import { readLayout, sourceHomeIds, type DashboardLayout, type LayoutContext } from "./layout";
import type { DashboardTarget } from "./schema";
import { starterLayout } from "./starter";
import type { DashboardKind } from "./widgets";

/**
 * Reads of dashboards and templates (S17), always with the person's own Supabase session, so the
 * database decides what they may see: their own personal dashboard, and the dashboard and shared
 * templates of Homes they belong to now.
 */

export interface LoadedDashboard {
  readonly layout: DashboardLayout;
  /** 0 while the dashboard still shows the starter layout (nothing saved yet). */
  readonly revision: number;
  readonly isStarter: boolean;
  readonly canEdit: boolean;
  readonly canUndo: boolean;
  /** Something stored could not be shown (an unknown widget type, broken settings). */
  readonly dropped: boolean;
  /**
   * Which dashboard this is (UX2d): the person's own, a Home's shared default, or the person's own
   * view of a Home. For a view they do not have yet, the layout is the shared default's, at
   * revision 0: that is what they would start from.
   */
  readonly answered: "personal" | "default" | "mine";
  /** The person has their own view of this Home (Home dashboards only). */
  readonly hasOverride: boolean;
}

/** Which Home dashboard a read asks for: `effective` is the person's view, else the shared default. */
export type HomeDashboardView = "default" | "mine" | "effective";

export type DashboardResult =
  | { readonly status: "ok"; readonly dashboard: LoadedDashboard }
  /** A Home the person does not belong to, or no such Home: deliberately indistinguishable. */
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

export function logDashboard(event: string, code: string | undefined): void {
  // Privacy-safe: the event and error code only, never ids, names or layouts.
  console.error(JSON.stringify({ event, code: code ?? null }));
}

/** The dashboard as the person may see it now; cached for this request only. */
export const loadDashboard = cache(
  async (
    kind: DashboardKind,
    homeId: string | null,
    view: HomeDashboardView = "default",
  ): Promise<DashboardResult> => {
    const supabase = await createSupabaseServerClient();
    const home = kind === "home" && homeId;
    const { data, error } = await supabase.rpc(
      "get_dashboard",
      home
        ? view === "default"
          ? { p_home_id: homeId }
          : { p_home_id: homeId, p_target: view }
        : {},
    );
    if (error) {
      if (error.code === "42501") return { status: "not-found" };
      logDashboard("dashboard.read_failed", error.code);
      return { status: "unavailable" };
    }
    const row = data[0];
    if (!row) return { status: "unavailable" };
    // The generated types call the column non-null; it is null until the first save.
    const stored: unknown = row.layout;
    const answered = !home ? "personal" : row.target === "mine" ? "mine" : "default";
    if (stored === null && answered === "mine") {
      // No view yet: the person starts from the shared default they see, saved as a new view.
      const shared = await loadDashboard(kind, homeId, "default");
      if (shared.status !== "ok") return shared;
      return {
        status: "ok",
        dashboard: {
          ...shared.dashboard,
          revision: 0,
          canEdit: row.can_edit,
          canUndo: false,
          answered: "mine",
          hasOverride: false,
        },
      };
    }
    if (stored === null) {
      return {
        status: "ok",
        dashboard: {
          layout: starterLayout(kind),
          revision: 0,
          isStarter: true,
          canEdit: row.can_edit,
          canUndo: false,
          dropped: false,
          answered,
          hasOverride: row.has_override,
        },
      };
    }
    const { layout, dropped } = readLayout(stored, kind);
    return {
      status: "ok",
      dashboard: {
        layout,
        revision: row.revision,
        isStarter: false,
        canEdit: row.can_edit,
        canUndo: row.can_undo,
        dropped,
        answered,
        hasOverride: row.has_override,
      },
    };
  },
);

export function loadTarget(target: DashboardTarget): Promise<DashboardResult> {
  return target.kind === "home"
    ? loadDashboard("home", target.homeId, target.view === "mine" ? "mine" : "default")
    : loadDashboard("personal", null);
}

/** A widget the shared default added since the person's view started (decision 34). */
export interface HomeSuggestion {
  readonly widgetId: string;
  /** The widget as the shared default holds it, read like any saved layout. */
  readonly widget: DashboardLayout["widgets"][number];
}

export type SuggestionsResult =
  | { readonly status: "ok"; readonly suggestions: readonly HomeSuggestion[] }
  | { readonly status: "unavailable" };

/**
 * Widgets of the Home's shared default that the person's own view lacks and that they neither saw
 * when the view started nor dismissed. Nothing without a view of their own. Read with the person's
 * session; the database answers only members of the Home. Widgets the registry does not know are
 * left out (an older client with a newer server).
 */
export async function loadSuggestions(homeId: string): Promise<SuggestionsResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_dashboard_suggestions", { p_home_id: homeId });
  if (error) {
    logDashboard("dashboard.suggestions_failed", error.code);
    return { status: "unavailable" };
  }
  const suggestions = data.flatMap((row): HomeSuggestion[] => {
    // One widget per entry: read it through a one-widget layout so config is checked like any save.
    const widget: unknown = row.widget;
    if (typeof widget !== "object" || widget === null) return [];
    const { layout } = readLayout(
      {
        version: 1,
        widgets: [widget],
        placements: {
          lg: [{ id: row.widget_id, x: 0, y: 0, w: 1, h: 1 }],
          md: [{ id: row.widget_id, x: 0, y: 0, w: 1, h: 1 }],
          sm: [{ id: row.widget_id, x: 0, y: 0, w: 1, h: 1 }],
        },
      },
      "home",
    );
    const read = layout.widgets[0];
    return read ? [{ widgetId: row.widget_id, widget: read }] : [];
  });
  return { status: "ok", suggestions };
}

/**
 * What a save of `target` may bind personal widgets to: the person's current Homes, plus Homes
 * already bound in their saved layout (so a widget for a Home they left can stay until removed).
 * `null` when their Homes could not be read.
 */
export async function layoutContextFor(
  target: DashboardTarget,
  current: DashboardLayout,
): Promise<LayoutContext | null> {
  if (target.kind === "home") return { dashboard: "home", allowedSourceHomeIds: new Set() };
  const homes = await listMyHomes();
  if (homes.status !== "ok") return null;
  const allowed = sourceHomeIds(current);
  for (const home of homes.homes) allowed.add(home.id);
  return { dashboard: "personal", allowedSourceHomeIds: allowed };
}

export interface TemplateRow {
  readonly id: string;
  readonly name: string;
  readonly kind: DashboardKind;
  readonly layout: DashboardLayout;
  readonly isMine: boolean;
  /** Homes it is shared into, among those the person belongs to. */
  readonly sharedHomeIds: readonly string[];
  readonly updatedAt: string;
}

export type TemplatesResult =
  | { readonly status: "ok"; readonly templates: readonly TemplateRow[] }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/**
 * The templates the person may see: their own, and those shared into a Home they belong to (all of
 * them, or only `homeId`'s). Layouts are read leniently, like dashboards.
 */
export const listTemplates = cache(async (homeId: string | null): Promise<TemplatesResult> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(
    "list_dashboard_templates",
    homeId ? { p_home_id: homeId } : {},
  );
  if (error) {
    if (error.code === "42501") return { status: "not-found" };
    logDashboard("dashboard.templates_failed", error.code);
    return { status: "unavailable" };
  }
  const templates = data.flatMap((row): TemplateRow[] => {
    if (row.kind !== "personal" && row.kind !== "home") return [];
    return [
      {
        id: row.template_id,
        name: row.name,
        kind: row.kind,
        layout: readLayout(row.layout, row.kind).layout,
        isMine: row.is_mine,
        sharedHomeIds: row.shared_home_ids,
        updatedAt: row.updated_at,
      },
    ];
  });
  return { status: "ok", templates };
});
