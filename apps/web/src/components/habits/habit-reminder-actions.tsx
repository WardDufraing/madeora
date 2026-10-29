"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import { habitSnoozeMinutes, type HabitSnoozeMinutes } from "@madeora/domain/habits";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/ui/use-hydrated";
import { habitSnoozeEndpoint, sendHabitRequest } from "@/habits/api";

import { useHabitCheckins } from "./use-habit-checkins";
import { useHabitMutation } from "./use-habit-mutation";
import { useHabitTexts } from "./use-habit-texts";

export interface HabitReminderActionsProps {
  readonly notificationId: string;
  readonly habitId: string;
  readonly habitName: string;
  /** The day the reminder is for; null for a weekly habit (completes the habit's today). */
  readonly onDate: string | null;
  /** A numeric habit: no Complete (a quantity cannot be invented); the habit's page takes progress. */
  readonly numeric?: boolean;
  /** Where the habit's page is, for a numeric habit's reminder. */
  readonly href?: string;
}

/**
 * Complete and Snooze on a habit reminder in the notification centre (S28). Both are checked again
 * by the database: a day that is already done, paused or past the backdating window is refused
 * with its reason, and a snooze that would land in quiet hours or after the day or week is refused.
 */
export function HabitReminderActions({
  notificationId,
  habitId,
  habitName,
  onDate,
  numeric = false,
  href,
}: HabitReminderActionsProps) {
  const t = useTranslations("Habits");
  const tn = useTranslations("HabitsNumeric");
  const texts = useHabitTexts();
  const hydrated = useHydrated();
  const checkins = useHabitCheckins(`habit-reminder:${notificationId}`);
  const [snoozed, setSnoozed] = useState<HabitSnoozeMinutes | null>(null);
  const snooze = useHabitMutation(
    `habit-snooze:${notificationId}`,
    (minutes: HabitSnoozeMinutes) =>
      sendHabitRequest<{ dueAt: string | null }>("POST", habitSnoozeEndpoint(notificationId), {
        minutes,
      }),
    (_answer, minutes) => {
      setSnoozed(minutes);
    },
  );
  const error = checkins.complete.error ?? snooze.error;
  return (
    <div className="flex flex-col gap-2" data-testid="habit-reminder-actions">
      <div className="flex flex-wrap items-center gap-2">
        {numeric ? (
          <Link
            href={href ?? "#"}
            className="inline-flex min-h-8 items-center rounded-control border border-line-control px-3 text-body font-medium text-fg"
            aria-label={tn("addProgressTo", { habit: habitName })}
            data-testid="habit-reminder-add-progress"
          >
            {tn("addProgress")}
          </Link>
        ) : (
          <Button
            size="sm"
            disabled={!hydrated || checkins.complete.isSuccess}
            loading={checkins.complete.busy}
            aria-label={t("completeHabit", { habit: habitName })}
            onClick={() => {
              checkins.complete.mutate({
                habitId,
                name: habitName,
                onDate,
                source: "notification",
              });
            }}
            data-testid="habit-reminder-complete"
          >
            {t("complete")}
          </Button>
        )}
        <span className="text-helper text-fg-muted" id={`snooze-${notificationId}`}>
          {t("snoozeLabel")}
        </span>
        {habitSnoozeMinutes.map((minutes) => (
          <Button
            key={minutes}
            size="sm"
            variant="secondary"
            disabled={!hydrated || snoozed !== null}
            loading={snooze.busy && snooze.variables === minutes}
            aria-describedby={`snooze-${notificationId}`}
            aria-label={t("snoozeFor", { habit: habitName, minutes })}
            onClick={() => {
              snooze.mutate(minutes);
            }}
            data-testid={`habit-reminder-snooze-${String(minutes)}`}
          >
            {t("snoozeMinutes", { minutes })}
          </Button>
        ))}
      </div>
      {snoozed !== null ? (
        <FormAlert tone="success" announce>
          {t("snoozedFor", { minutes: snoozed })}
        </FormAlert>
      ) : null}
      {checkins.complete.isSuccess ? (
        <FormAlert tone="success" announce>
          {t("completedToast", { habit: habitName })}
        </FormAlert>
      ) : null}
      {error ? (
        <FormAlert tone="error" announce>
          {texts.failure(error.failure)}
        </FormAlert>
      ) : null}
    </div>
  );
}
