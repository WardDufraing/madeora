import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { habitInsightDays } from "@madeora/domain/habits";

import { readHabit, readHabitCalendar, readHabitInsights } from "@/habits/data";
import { habitsPath } from "@/habits/format";
import { pageTitle } from "@/i18n/page-title";
import { timeZoneChoices } from "@/preferences/timezone";
import { listTaskMembers } from "@/tasks/data";
import { ErrorState } from "@/components/ui/states";

import { HabitDetailView } from "./habit-detail";

export interface HabitPageProps {
  /** The context of the URL: `null` for /habits/…, the Home for /homes/…/habits/…. */
  readonly homeId: string | null;
  readonly habitId: string;
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

/** The document title: the habit's name when the viewer may see it. */
export async function habitPageTitle(habitId: string, fallback: string): Promise<string> {
  const id = z.uuid().safeParse(habitId);
  const habit = id.success ? await readHabit(id.data) : null;
  return pageTitle(habit?.status === "ok" ? habit.value.name : fallback);
}

function daysParam(value: string | string[] | undefined): number {
  return habitInsightDays.find((days) => String(days) === value) ?? 30;
}

function monthParam(value: string | string[] | undefined, today: string): string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
    ? value
    : today.slice(0, 7);
}

/**
 * One habit's page (S28), read with the viewer's own session: status, schedule and its history,
 * streaks and milestones, the last eight days with their check-ins, insights with a month calendar,
 * and everything the viewer may change. A habit they may not see is not found; one opened under the
 * other context's address is sent to its own.
 */
export async function HabitPage({ homeId, habitId, searchParams }: HabitPageProps) {
  const id = z.uuid().safeParse(habitId);
  if (!id.success) notFound();
  const [t, habit] = await Promise.all([getTranslations("Habits"), readHabit(id.data)]);
  if (habit.status === "not-found") notFound();
  if (habit.status !== "ok") {
    return <ErrorState title={t("loadFailedTitle")} description={t("loadFailed")} />;
  }
  if (habit.value.homeId !== homeId) redirect(habitsPath(habit.value.homeId, habit.value.id));
  const days = daysParam(searchParams.days);
  const month = monthParam(searchParams.month, habit.value.today);
  const [insights, calendar, members] = await Promise.all([
    readHabitInsights(habit.value.id, days),
    readHabitCalendar(habit.value.id, month),
    homeId ? listTaskMembers(homeId) : Promise.resolve(null),
  ]);
  return (
    <>
      <p className="mb-2">
        <Link href={habitsPath(homeId)} className="text-body font-medium text-accent-fg underline">
          {t("backToHabits")}
        </Link>
      </p>
      <HabitDetailView
        initialHabit={habit.value}
        initialInsights={insights.status === "ok" ? insights.value : null}
        initialCalendar={calendar.status === "ok" ? calendar.value : null}
        days={days}
        month={month}
        members={members?.status === "ok" ? members.value : []}
        timeZones={homeId ? [] : timeZoneChoices([habit.value.timeZone])}
      />
    </>
  );
}
