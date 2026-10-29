import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { goalViews, type GoalView } from "@madeora/domain/goals";

import { zonedParts } from "@/chores/format";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { readGoals } from "@/goals/data";
import { getEffectiveTimeZone } from "@/preferences/server";
import { timeZoneChoices } from "@/preferences/timezone";

import { GoalsView } from "./goals-view";

export interface GoalsPageProps {
  /** `null`: the Personal space. */
  readonly home: { readonly id: string; readonly name: string; readonly timeZone: string } | null;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

function viewParam(value: string | string[] | undefined): GoalView {
  return goalViews.find((view) => view === value) ?? "active";
}

function queryParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

/**
 * The goals page of one context (S30), read with the viewer's own session: a Home they are not in
 * is not found, and nobody else's personal goals are ever listed.
 */
export async function GoalsPage({ home, searchParams }: GoalsPageProps) {
  const homeId = home?.id ?? null;
  const view = viewParam(searchParams.view);
  const query = view === "active" ? "" : queryParam(searchParams.q);
  const [t, zone, list] = await Promise.all([
    getTranslations("Goals"),
    getEffectiveTimeZone(),
    readGoals(homeId, view, query || null),
  ]);
  if (list.status === "not-found") notFound();
  if (list.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const today = zonedParts(new Date().toISOString(), home?.timeZone ?? zone.timeZone).date;
  return (
    <>
      <PageHeader title={home ? t("homeTitle", { home: home.name }) : t("personalTitle")} />
      <GoalsView
        homeId={homeId}
        view={view}
        query={query}
        initialList={list.value}
        today={today}
        timeZone={zone.timeZone}
        timeZones={homeId ? [] : timeZoneChoices([zone.timeZone])}
      />
    </>
  );
}
