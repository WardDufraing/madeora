"use client";

import { CheckIcon } from "@madeora/icons";
import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import { cx } from "@/components/ui/cx";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { HabitSummary } from "@/habits/api";

import { useHabitCheckins } from "./use-habit-checkins";

/** The shape of the round control, shared by the live button and the read-only glyph. */
const base =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full border-2 press-feedback";

/**
 * The one-tap completion control of a habit completed once (redesign decisions 63 and 65): an
 * empty circle completes today, a filled circle with a check undoes the viewer's own completion.
 * The state is a check mark and the button's name, never colour alone; the fill eases in
 * only when motion is allowed. Focus stays on the control. Someone who may not change it, or a day
 * that cannot take a check-in, sees the same circle as a read-only glyph.
 */
export function HabitCheckControl({ habit }: { readonly habit: HabitSummary }) {
  const t = useTranslations("Habits");
  const hydrated = useHydrated();
  const checkins = useHabitCheckins(`habit:${habit.id}`);
  const checkin = habit.todayCheckin;
  const done = checkin?.status === "active";
  const may = habit.access !== "view" && habit.status !== "archived";
  const canComplete = may && !done && habit.todayBlock === null;
  const canUndo = done && checkin.action === "undo";
  if (!canComplete && !canUndo) return <HabitStateGlyph done={done} />;
  const busy = canComplete ? checkins.complete.busy : checkins.undo.busy;
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        aria-busy={busy}
        aria-label={
          canComplete
            ? t("completeHabitToday", { habit: habit.name })
            : t("undoHabitToday", { habit: habit.name })
        }
        disabled={!hydrated}
        onClick={() => {
          if (busy) return;
          checkins.reset();
          if (canComplete) {
            checkins.complete.mutate({
              habitId: habit.id,
              name: habit.name,
              onDate: habit.today,
              source: "app",
            });
          } else if (checkin?.action === "undo") {
            checkins.undo.mutate({ checkin, name: habit.name });
          }
        }}
        className={cx(
          base,
          "cursor-pointer disabled:cursor-not-allowed disabled:opacity-60",
          done
            ? "border-accent bg-accent text-on-accent"
            : "border-line-control bg-surface text-transparent hover:border-accent hover:text-accent-fg",
        )}
        data-testid={canComplete ? "habit-complete" : "habit-undo"}
      >
        <CheckIcon
          aria-hidden="true"
          className={cx(
            "size-5 motion-safe:transition-transform motion-safe:duration-200",
            done ? "scale-100" : "scale-75",
          )}
        />
      </button>
      {checkins.failureText ? (
        <FormAlert tone="error" announce>
          {checkins.failureText}
        </FormAlert>
      ) : null}
    </div>
  );
}

/** A read-only state circle: filled with a check when done, empty otherwise. */
export function HabitStateGlyph({ done }: { readonly done: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        base,
        done
          ? "border-accent bg-accent text-on-accent"
          : "border-line-control bg-surface-sunken text-transparent",
      )}
    >
      <CheckIcon className="size-5" />
    </span>
  );
}
