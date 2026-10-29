import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { ErrorState } from "@/components/ui/states";
import { readGoalSeries } from "@/goals/data";
import { goalSeriesPath, goalsPath } from "@/goals/format";
import { pageTitle } from "@/i18n/page-title";
import { getEffectiveTimeZone } from "@/preferences/server";
import { timeZoneChoices } from "@/preferences/timezone";
import { listTaskMembers } from "@/tasks/data";

import { GoalSeriesView } from "./goal-series";

export interface GoalSeriesPageProps {
  /** The context of the URL: `null` for /goals/series/…, the Home for /homes/…/goals/series/…. */
  readonly homeId: string | null;
  readonly seriesId: string;
}

/** The document title: the series' title when the viewer may see it. */
export async function goalSeriesPageTitle(seriesId: string, fallback: string): Promise<string> {
  const id = z.uuid().safeParse(seriesId);
  const series = id.success ? await readGoalSeries(id.data) : null;
  return pageTitle(series?.status === "ok" ? series.value.title : fallback);
}

/**
 * One recurring series' page (S30b), read with the viewer's own session (which first rolls the
 * series to the period running now). A series they may not see is not found; one opened under the
 * other context's address is sent to its own.
 */
export async function GoalSeriesPage({ homeId, seriesId }: GoalSeriesPageProps) {
  const id = z.uuid().safeParse(seriesId);
  if (!id.success) notFound();
  const [t, series] = await Promise.all([getTranslations("Goals"), readGoalSeries(id.data)]);
  if (series.status === "not-found") notFound();
  if (series.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  if (series.value.homeId !== homeId)
    redirect(goalSeriesPath(series.value.homeId, series.value.id));
  const [members, zone] = await Promise.all([
    homeId ? listTaskMembers(homeId) : Promise.resolve(null),
    getEffectiveTimeZone(),
  ]);
  return (
    <>
      <p className="mb-2">
        <Link href={goalsPath(homeId)} className="text-body font-medium text-accent-fg underline">
          {t("backToGoals")}
        </Link>
      </p>
      <GoalSeriesView
        initialSeries={series.value}
        members={members?.status === "ok" ? members.value : []}
        timeZones={timeZoneChoices([zone.timeZone, series.value.timeZone])}
      />
    </>
  );
}
