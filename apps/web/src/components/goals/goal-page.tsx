import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { ErrorState } from "@/components/ui/states";
import { readGoal } from "@/goals/data";
import { goalsPath } from "@/goals/format";
import { listMyHomes } from "@/homes/server";
import { pageTitle } from "@/i18n/page-title";
import { getEffectiveTimeZone } from "@/preferences/server";
import { timeZoneChoices } from "@/preferences/timezone";
import { listTaskMembers } from "@/tasks/data";

import { GoalDetailView } from "./goal-detail";

export interface GoalPageProps {
  /** The context of the URL: `null` for /goals/…, the Home for /homes/…/goals/…. */
  readonly homeId: string | null;
  readonly goalId: string;
}

/** The document title: the goal's title when the viewer may see it. */
export async function goalPageTitle(goalId: string, fallback: string): Promise<string> {
  const id = z.uuid().safeParse(goalId);
  const goal = id.success ? await readGoal(id.data) : null;
  return pageTitle(goal?.status === "ok" ? goal.value.title : fallback);
}

/**
 * One goal's page (S30), read with the viewer's own session: its progress, contributions,
 * achievements, reminders and history, and everything the viewer may change. A goal they may not
 * see is not found; one opened under the other context's address is sent to its own.
 */
export async function GoalPage({ homeId, goalId }: GoalPageProps) {
  const id = z.uuid().safeParse(goalId);
  if (!id.success) notFound();
  const [t, goal] = await Promise.all([getTranslations("Goals"), readGoal(id.data)]);
  if (goal.status === "not-found") notFound();
  if (goal.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  if (goal.value.homeId !== homeId) redirect(goalsPath(goal.value.homeId, goal.value.id));
  const [members, homes, zone] = await Promise.all([
    homeId ? listTaskMembers(homeId) : Promise.resolve(null),
    listMyHomes(),
    getEffectiveTimeZone(),
  ]);
  // A renewed goal can go to the Personal space or any of the person's Homes; the database refuses
  // a Home where they may not create goals.
  const contexts = [
    { homeId: null, name: t("personalSpace") },
    ...(homes.status === "ok"
      ? homes.homes.map((home) => ({ homeId: home.id, name: home.name }))
      : []),
  ];
  return (
    <>
      <p className="mb-2">
        <Link href={goalsPath(homeId)} className="text-body font-medium text-accent-fg underline">
          {t("backToGoals")}
        </Link>
      </p>
      <GoalDetailView
        initialGoal={goal.value}
        members={members?.status === "ok" ? members.value : []}
        contexts={contexts}
        timeZone={zone.timeZone}
        timeZones={timeZoneChoices([zone.timeZone, goal.value.timeZone])}
      />
    </>
  );
}
