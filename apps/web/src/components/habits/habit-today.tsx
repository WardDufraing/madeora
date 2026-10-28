"use client";

import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { HabitSummary } from "@/habits/api";
import type { MemberNames } from "@/tasks/format";

import { useHabitCheckins } from "./use-habit-checkins";
import { useHabitTexts } from "./use-habit-texts";

export interface HabitTodayProps {
  readonly habit: HabitSummary;
  readonly names: MemberNames;
  readonly source: "app" | "widget";
  /** Smaller buttons and text, for widgets. */
  readonly compact?: boolean;
}

/**
 * Today's state of one habit with what the viewer may do about it: Complete when today can take a
 * check-in, Undo for their own completion, otherwise who completed it or why it cannot be completed
 * today (not scheduled, paused, week target reached, …). Read-only viewers only see the state.
 */
export function HabitToday({ habit, names, source, compact = false }: HabitTodayProps) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const hydrated = useHydrated();
  const checkins = useHabitCheckins(`habit:${habit.id}`);
  const may = habit.access !== "view" && habit.status !== "archived";
  const checkin = habit.todayCheckin;
  const size = compact ? "sm" : "md";
  const done = checkin?.status === "active";
  return (
    <div className="flex flex-col gap-2" data-testid="habit-today">
      <div className="flex flex-wrap items-center gap-2">
        {done ? (
          <p className="text-body text-fg" data-testid="habit-today-done">
            {t("doneToday", { person: texts.who(checkin.by, checkin.mine, names) })}
          </p>
        ) : habit.todayBlock === null && may ? null : (
          <p className="text-helper text-fg-muted" data-testid="habit-today-state">
            {habit.todayBlock && habit.todayBlock !== "already_completed"
              ? texts.block(habit.todayBlock)
              : texts.state(habit.todayState)}
          </p>
        )}
        {may && !done && habit.todayBlock === null ? (
          <Button
            size={size}
            disabled={!hydrated}
            loading={checkins.complete.busy}
            aria-label={t("completeHabitToday", { habit: habit.name })}
            onClick={() => {
              checkins.reset();
              checkins.complete.mutate({
                habitId: habit.id,
                name: habit.name,
                onDate: habit.today,
                source,
              });
            }}
            data-testid="habit-complete"
          >
            {t("complete")}
          </Button>
        ) : null}
        {done && checkin.action === "undo" ? (
          <Button
            size={size}
            variant="secondary"
            disabled={!hydrated}
            loading={checkins.undo.busy}
            aria-label={t("undoHabitToday", { habit: habit.name })}
            onClick={() => {
              checkins.reset();
              checkins.undo.mutate({ checkin, name: habit.name });
            }}
            data-testid="habit-undo"
          >
            {t("undo")}
          </Button>
        ) : null}
      </div>
      {checkins.failureText ? (
        <FormAlert tone="error" announce>
          {checkins.failureText}
        </FormAlert>
      ) : null}
    </div>
  );
}

/** A weekly habit's progress this week, as text ("2 of 3 this week"), or nothing. */
export function HabitWeekProgress({ habit }: { readonly habit: HabitSummary }) {
  const t = useTranslations("Habits");
  if (!habit.week) return null;
  const { completions, adjusted, target } = habit.week;
  return (
    <p className="text-helper text-fg-muted" data-testid="habit-week-progress">
      {adjusted === 0
        ? t("weekPaused")
        : t("weekProgress", { done: completions, target: adjusted })}
      {adjusted !== target && adjusted > 0 ? ` ${t("weekAdjusted", { target })}` : ""}
    </p>
  );
}
