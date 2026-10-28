"use client";

import { useTranslations } from "next-intl";

import { HABIT_LIMITS } from "@madeora/domain/habits";

import { useToast } from "@/components/ui/toast";
import {
  habitCheckinEndpoint,
  habitEndpoint,
  sendHabitRequest,
  type HabitCheckin,
  type HabitCheckinResult,
} from "@/habits/api";
import { newId } from "@/habits/format";

import { useHabitMutation } from "./use-habit-mutation";
import { useHabitTexts } from "./use-habit-texts";

export interface CompleteInput {
  readonly habitId: string;
  readonly name: string;
  /** null: the habit's today. */
  readonly onDate: string | null;
  readonly note?: string | null;
  readonly source: "app" | "widget" | "notification";
}

export interface UndoInput {
  readonly checkin: Pick<HabitCheckin, "id">;
  readonly name: string;
  readonly reason?: string | null;
}

/** A sentence on how a change moved the current streak, or nothing when it did not. */
function streakChange(
  result: HabitCheckinResult,
  describe: (before: number, after: number) => string,
): { readonly description: string } | Record<string, never> {
  const before = result.streakBefore;
  const after = result.habit?.streak.current;
  return before == null || after === undefined || before === after
    ? {}
    : { description: describe(before, after) };
}

/**
 * Completing and undoing check-ins, shared by the habit list, the habit page, the widget and the
 * notification centre. A completion confirms itself with a non-blocking message that offers Undo
 * for ten seconds (longer while focused or hovered), and a newly reached milestone adds a short
 * celebration: text only, no sound, focus stays where it is.
 */
export function useHabitCheckins(scope: string) {
  const t = useTranslations("Habits");
  const texts = useHabitTexts();
  const toast = useToast();
  const undo = useHabitMutation(
    `${scope}:undo`,
    ({ checkin, reason }: UndoInput) =>
      sendHabitRequest<HabitCheckinResult>("POST", habitCheckinEndpoint(checkin.id, "undo"), {
        reason: reason ?? null,
      }),
    (result, input) => {
      toast.show({
        title: t("undoneToast", { habit: input.name }),
        tone: "info",
        ...streakChange(result, (before, after) => t("streakChanged", { before, after })),
      });
    },
  );
  const complete = useHabitMutation(
    `${scope}:complete`,
    ({ habitId, onDate, note, source }: CompleteInput) =>
      sendHabitRequest<HabitCheckinResult>("POST", habitEndpoint(habitId, "checkins"), {
        id: newId(),
        onDate,
        note: note ?? null,
        source,
      }),
    (result, input) => {
      const checkin = result.checkin;
      toast.show({
        title: t("completedToast", { habit: input.name }),
        tone: "success",
        ...streakChange(result, (before, after) => t("streakChanged", { before, after })),
        duration: HABIT_LIMITS.undoSeconds * 1000,
        ...(checkin && checkin.action === "undo"
          ? {
              action: {
                label: t("undo"),
                onAction: () => {
                  undo.mutate({ checkin, name: input.name });
                },
              },
            }
          : {}),
      });
      const milestone = result.milestone;
      if (milestone?.celebrate) {
        toast.show({
          title:
            milestone.unit === "weeks"
              ? t("milestoneWeeks", { habit: input.name, count: milestone.threshold })
              : t("milestoneOccurrences", { habit: input.name, count: milestone.threshold }),
          description: t("milestoneDescription"),
          tone: "success",
        });
      }
    },
  );
  const failure = complete.error ?? undo.error;
  return {
    complete,
    undo,
    failureText: failure ? texts.failure(failure.failure) : null,
    reset: () => {
      complete.reset();
      undo.reset();
    },
  };
}
