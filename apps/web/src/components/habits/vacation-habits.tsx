"use client";

import { useTranslations } from "next-intl";

import { FormAlert } from "@/components/auth/form-alert";
import { Checkbox } from "@/components/ui/checkbox";
import { sendHabitRequest, vacationHabitsEndpoint, type VacationHabits } from "@/habits/api";

import { useHabitMutation } from "./use-habit-mutation";
import { useHabitTexts } from "./use-habit-texts";

/**
 * "Pause my personal habits" on a vacation page (S28): for the viewer's own accepted participation,
 * one switch per active personal habit (off by default), each with how many scheduled days it would
 * pause from today on. Days already passed never change. Only the viewer sees this section.
 */
export function VacationHabitsSection({
  vacationId,
  value,
}: {
  readonly vacationId: string;
  readonly value: VacationHabits;
}) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const save = useHabitMutation(
    `vacation-habits:${vacationId}`,
    (body: { habitId: string; paused: boolean }) =>
      sendHabitRequest("PUT", vacationHabitsEndpoint(vacationId), body),
  );
  const participation = value.participation;
  if (!participation || value.habits.length === 0) return null;
  return (
    <section
      aria-labelledby="vacation-habits-heading"
      className="flex flex-col gap-3"
      data-testid="vacation-habits"
    >
      <h2 id="vacation-habits-heading" className="text-section-title font-semibold text-fg">
        {t("vacationHabitsTitle")}
      </h2>
      <p className="text-helper text-fg-muted">
        {t("vacationHabitsExplanation", {
          from: texts.date(participation.startsOn, "short"),
          to: texts.date(participation.endsOn, "short"),
        })}
      </p>
      <ul className="flex flex-col gap-2">
        {value.habits.map((habit) => (
          <li key={habit.id}>
            <Checkbox
              label={habit.name}
              {...(habit.scheduledDays === null
                ? {}
                : { description: t("vacationHabitDays", { count: habit.scheduledDays }) })}
              checked={habit.paused}
              disabled={save.busy}
              onChange={(event) => {
                save.mutate({ habitId: habit.id, paused: event.target.checked });
              }}
              data-testid="vacation-habit-switch"
            />
          </li>
        ))}
      </ul>
      {save.error ? (
        <FormAlert tone="error" announce>
          {texts.failure(save.error.failure)}
        </FormAlert>
      ) : null}
    </section>
  );
}
