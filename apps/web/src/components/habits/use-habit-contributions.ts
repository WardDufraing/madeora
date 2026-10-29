"use client";

import { useTranslations } from "next-intl";

import { HABIT_LIMITS } from "@madeora/domain/habits";

import { useToast } from "@/components/ui/toast";
import {
  habitContributionEndpoint,
  habitEndpoint,
  sendHabitRequest,
  type HabitContributionResult,
} from "@/habits/api";

import { useHabitMutation } from "./use-habit-mutation";
import { useHabitTexts } from "./use-habit-texts";

export interface AddProgressInput {
  /** Made once per intention, so a retry after a lost answer adds nothing twice. */
  readonly id: string;
  readonly habitId: string;
  readonly name: string;
  /** The quantity as a decimal string ("1.5"). */
  readonly quantity: string;
  /** The same quantity as the person reads it, for the confirmation ("1.5 L"). */
  readonly label: string;
  /** null: the habit's today. */
  readonly onDate: string | null;
  /** The unit it was typed in, when not the habit's own. */
  readonly enteredUnit: string | null;
  readonly source: "app" | "widget";
  /** A widget's habit revision as read, so a stale preset is refused. */
  readonly revision?: number | null;
}

export interface UpdateContributionInput {
  readonly contributionId: string;
  readonly name: string;
  readonly action: "undo" | "void" | "amend";
  readonly quantity?: string | null;
  readonly reason?: string | null;
}

/**
 * Adding, undoing and correcting progress on numeric habits, shared by the habit page, the list, the
 * widgets and the notification centre. Adding confirms itself with a message that offers Undo for
 * ten seconds; reaching the target adds a short note and a newly reached milestone its celebration
 * (text only, no sound, focus stays where it is).
 */
export function useHabitContributions(scope: string) {
  const t = useTranslations("HabitsNumeric");
  const th = useTranslations("Habits");
  const texts = useHabitTexts();
  const toast = useToast();
  const update = useHabitMutation(
    `${scope}:update`,
    ({ contributionId, action, quantity, reason }: UpdateContributionInput) =>
      sendHabitRequest<HabitContributionResult>(
        "PATCH",
        habitContributionEndpoint(contributionId),
        {
          action,
          quantity: quantity ?? null,
          reason: reason ?? null,
        },
      ),
    (result, input) => {
      const before = result.streakBefore;
      const after = result.habit?.streak.current;
      toast.show({
        title:
          input.action === "amend"
            ? t("amendedToast", { habit: input.name })
            : t("undoneToast", { habit: input.name }),
        tone: "info",
        ...(before != null && after !== undefined && before !== after
          ? { description: th("streakChanged", { before, after }) }
          : {}),
      });
    },
  );
  const add = useHabitMutation(
    `${scope}:add`,
    ({ id, habitId, quantity, onDate, enteredUnit, source, revision }: AddProgressInput) =>
      sendHabitRequest<HabitContributionResult>("POST", habitEndpoint(habitId, "contributions"), {
        id,
        quantity,
        onDate,
        enteredUnit,
        source,
        revision: revision ?? null,
      }),
    (result, input) => {
      // A retry that finds the first answer's row changes nothing and says nothing new.
      if (result.outcome === "exists") return;
      const contributionId = result.contributionId;
      const before = result.streakBefore;
      const after = result.habit?.streak.current;
      toast.show({
        title: t("addedToast", { amount: input.label, habit: input.name }),
        tone: "success",
        duration: HABIT_LIMITS.undoSeconds * 1000,
        ...(contributionId
          ? {
              action: {
                label: th("undo"),
                onAction: () => {
                  update.mutate({ contributionId, name: input.name, action: "undo" });
                },
              },
            }
          : {}),
      });
      if (result.completedNow) {
        toast.show({
          title: t("targetReachedToast", { habit: input.name }),
          tone: "success",
          ...(before != null && after !== undefined && before !== after
            ? { description: th("streakChanged", { before, after }) }
            : {}),
        });
      }
      const milestone = result.milestone;
      if (milestone?.celebrate) {
        toast.show({
          title:
            milestone.unit === "weeks"
              ? th("milestoneWeeks", { habit: input.name, count: milestone.threshold })
              : th("milestoneOccurrences", { habit: input.name, count: milestone.threshold }),
          description: th("milestoneDescription"),
          tone: "success",
        });
      }
    },
  );
  const failure = add.error ?? update.error;
  return {
    add,
    update,
    failure,
    failureText: failure ? texts.failure(failure.failure) : null,
    reset: () => {
      add.reset();
      update.reset();
    },
  };
}
