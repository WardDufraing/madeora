import type { DashboardTarget } from "./schema";

/**
 * The Home arguments of a dashboard function for `target` (UX2d). The shared default and the
 * personal dashboard keep the arguments they always had; only "My Home view" names its target, so
 * a request for one dashboard can never reach the other by leaving a field out.
 */
export function targetArgs(target: DashboardTarget): { p_home_id?: string; p_target?: "mine" } {
  if (target.kind !== "home") return {};
  return target.view === "mine"
    ? { p_home_id: target.homeId, p_target: "mine" }
    : { p_home_id: target.homeId };
}

/** The query string that names `target` for the GET endpoints (drafts, history). */
export function targetQuery(target: DashboardTarget): string {
  if (target.kind !== "home") return "";
  const view = target.view === "mine" ? "&view=mine" : "";
  return `?homeId=${encodeURIComponent(target.homeId)}${view}`;
}

/** Reads `homeId` and `view` from a GET request's query; `null` when either is malformed. */
export function targetFromParams(
  params: URLSearchParams,
  isUuid: (value: string) => boolean,
): DashboardTarget | null {
  const homeId = params.get("homeId");
  const view = params.get("view");
  if (homeId === null) return view === null ? { kind: "personal" } : null;
  if (!isUuid(homeId)) return null;
  if (view === null) return { kind: "home", homeId };
  return view === "mine" ? { kind: "home", homeId, view: "mine" } : null;
}
