import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { habitViews, type HabitView } from "@madeora/domain/habits";

import { zonedParts } from "@/chores/format";
import { PageHeader } from "@/components/shell/page-header";
import { ErrorState } from "@/components/ui/states";
import { readHabits } from "@/habits/data";
import { getEffectiveTimeZone, getRegionalFormats } from "@/preferences/server";
import { timeZoneChoices } from "@/preferences/timezone";
import { listTaskMembers } from "@/tasks/data";

import { HabitsView } from "./habits-view";

export interface HabitsPageProps {
  /** `null`: the Personal space. */
  readonly home: { readonly id: string; readonly name: string; readonly timeZone: string } | null;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

function viewParam(value: string | string[] | undefined): HabitView {
  return habitViews.find((view) => view === value) ?? "active";
}

function queryParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

/**
 * The habits page of one context (S28), read with the viewer's own session: a Home they are not in
 * is not found, and nobody else's personal habits are ever listed.
 */
export async function HabitsPage({ home, searchParams }: HabitsPageProps) {
  const homeId = home?.id ?? null;
  const view = viewParam(searchParams.view);
  const query = view === "active" ? "" : queryParam(searchParams.q);
  const [t, regional, zone, list, members] = await Promise.all([
    getTranslations("Habits"),
    getRegionalFormats(),
    getEffectiveTimeZone(),
    readHabits(homeId, view, query || null),
    homeId ? listTaskMembers(homeId) : Promise.resolve(null),
  ]);
  if (list.status === "not-found") notFound();
  if (list.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  const today = zonedParts(new Date().toISOString(), home?.timeZone ?? zone.timeZone).date;
  return (
    <>
      <PageHeader title={home ? t("homeTitle", { home: home.name }) : t("personalTitle")} />
      <HabitsView
        homeId={homeId}
        view={view}
        query={query}
        initialList={list.value}
        members={members?.status === "ok" ? members.value : []}
        today={today}
        weekStart={regional.effective.weekStart}
        timeZone={zone.timeZone}
        timeZones={homeId ? [] : timeZoneChoices([zone.timeZone])}
      />
    </>
  );
}
