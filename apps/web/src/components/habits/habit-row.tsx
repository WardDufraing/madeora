"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { OverflowMenu } from "@/components/ui/overflow-menu";
import type { HabitSummary } from "@/habits/api";
import { habitsPath } from "@/habits/format";
import type { MemberNames } from "@/tasks/format";
import { useRouter } from "next/navigation";

import { HabitCheckControl, HabitStateGlyph } from "./habit-check";
import { HabitFormDialog, type HabitFormContext } from "./habit-form-dialog";
import { isNumeric, NumericToday } from "./habit-progress";
import { HabitWeekProgress } from "./habit-today";
import { HabitWeekStrip } from "./habit-week-strip";
import { useHabitTexts } from "./use-habit-texts";

export interface HabitRowProps {
  readonly habit: HabitSummary;
  readonly homeId: string | null;
  readonly names: MemberNames;
  readonly showWeek: boolean;
  readonly editor: HabitFormContext;
}

/**
 * One habit of the daily list as a compact row (redesign decision 63). Every row has the same grid:
 * the state control, the name with a single line of context, and a quiet actions menu. A habit
 * completed once gets the one-tap circle; a numeric habit shows its progress against the target
 * with quick adds, so no habit is forced into the other's shape. Details and Edit sit in the menu,
 * not as icons on every row. The weekly strip joins the row when the week view is on.
 */
export function HabitRow({ habit, homeId, names, showWeek, editor }: HabitRowProps) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const live = habit.status === "active" || habit.status === "paused";
  const numeric = isNumeric(habit);
  const checkin = habit.todayCheckin;
  const done = numeric ? (habit.progress?.met ?? false) : checkin?.status === "active";
  const headingId = `habit-${habit.id}-name`;
  const canEdit = habit.access === "manage" && habit.status !== "archived";
  const items = [
    {
      id: "details",
      label: t("rowDetails"),
      onSelect: () => {
        router.push(habitsPath(homeId, habit.id));
      },
    },
    ...(canEdit
      ? [
          {
            id: "edit",
            label: t("rowEdit"),
            onSelect: () => {
              setEditing(true);
            },
          },
        ]
      : []),
  ];
  return (
    <article
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-card border border-line bg-surface p-3 shadow-raised"
      data-testid="habit-card"
      data-done={done ? "true" : "false"}
    >
      <div className="flex items-start gap-3">
        {live && !numeric ? <HabitCheckControl habit={habit} /> : <HabitStateGlyph done={done} />}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={headingId} className="text-body font-semibold text-fg [overflow-wrap:anywhere]">
            <Link
              href={habitsPath(homeId, habit.id)}
              className="underline-offset-4 hover:underline"
            >
              <bdi>{habit.name}</bdi>
            </Link>
          </h2>
          <p className="text-helper text-fg-muted">
            {texts.schedule(habit.schedule)} · {texts.status(habit)}
          </p>
          {habit.status === "ended" && habit.endsOn ? (
            <p className="text-helper text-fg-muted">
              {t("endedOn", { date: texts.date(habit.endsOn, "short") })}
            </p>
          ) : null}
          {habit.status === "upcoming" ? (
            <p className="text-helper text-fg-muted">
              {t("startsOn", { date: texts.date(habit.periodStartsOn, "short") })}
            </p>
          ) : null}
          <HabitWeekProgress habit={habit} />
          <p className="text-helper text-fg" data-testid="habit-streak">
            {texts.streak(habit.streak)}
          </p>
          {live && !numeric ? <OnceStatus habit={habit} names={names} /> : null}
          {live && numeric ? <NumericToday habit={habit} source="app" compact /> : null}
        </div>
        <OverflowMenu label={t("rowActions", { habit: habit.name })} items={items} />
      </div>
      {showWeek ? <HabitWeekStrip habit={habit} /> : null}
      {editing ? (
        <HabitFormDialog
          habit={habit}
          homeId={homeId}
          {...editor}
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : null}
    </article>
  );
}

/** Who completed today, or why it cannot be completed: text, so the circle is not the only cue. */
function OnceStatus({
  habit,
  names,
}: {
  readonly habit: HabitSummary;
  readonly names: MemberNames;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const checkin = habit.todayCheckin;
  const may = habit.access !== "view";
  if (checkin?.status === "active") {
    return (
      <p className="text-helper text-fg" data-testid="habit-today-done">
        {t("doneToday", { person: texts.who(checkin.by, checkin.mine, names) })}
      </p>
    );
  }
  if (habit.todayBlock === null && may) return null;
  return (
    <p className="text-helper text-fg-muted" data-testid="habit-today-state">
      {habit.todayBlock && habit.todayBlock !== "already_completed"
        ? texts.block(habit.todayBlock)
        : texts.state(habit.todayState)}
    </p>
  );
}
