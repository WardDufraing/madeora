"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import type { HabitUnitKind } from "@madeora/domain/habits";

import { goalLinksQuery, sendGoalRequest, type GoalLinks } from "@/goals/api";
import { goalKeys } from "@/goals/format";

import { useGoalTexts } from "./use-goal-texts";

/** Whose links to read: a goal's, a series' or a habit's. */
export type GoalLinkTarget =
  { readonly goalId: string } | { readonly seriesId: string } | { readonly habitId: string };

/** The links of a goal, series or habit, as the person may see them (S30c). */
export function useLinks(target: GoalLinkTarget) {
  const [kind, id] =
    "goalId" in target
      ? (["goal", target.goalId] as const)
      : "seriesId" in target
        ? (["series", target.seriesId] as const)
        : (["habit", target.habitId] as const);
  return useQuery<GoalLinks>({
    queryKey: goalKeys.links(kind, id),
    queryFn: () => sendGoalRequest("GET", goalLinksQuery(target)),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * What archiving or deleting a goal, series or habit does to its links (spec: the exact impact before
 * archiving or deleting either side), shown in that confirmation. Nothing when it has no links.
 */
export function LinkArchiveNote({
  target,
  action,
  unit = null,
}: {
  readonly target: GoalLinkTarget;
  readonly action: "archive" | "delete";
  /** The goal's or series' unit, for the linked amount (not used for a habit). */
  readonly unit?: { readonly unit: string; readonly unitKind: HabitUnitKind } | null;
}) {
  const t = useTranslations("Goals");
  const texts = useGoalTexts();
  const links = useLinks(target);
  const rows = links.data?.links ?? [];
  if (rows.length === 0) return null;
  if ("habitId" in target) {
    return (
      <div
        className="flex flex-col gap-1 text-body text-fg"
        role="note"
        data-testid="goal-link-archive-note"
      >
        <p>{t("linkNoteHabitGoals", { count: rows.length })}</p>
        <ul className="list-inside list-disc">
          {rows.map((link) => (
            <li key={link.id}>
              <bdi>{link.destination.title}</bdi>
            </li>
          ))}
        </ul>
        <p>{t(action === "archive" ? "linkNoteHabitArchive" : "linkNoteHabitDelete")}</p>
      </div>
    );
  }
  const total = rows.reduce((sum, link) => sum + link.amount, 0);
  return (
    <div
      className="flex flex-col gap-1 text-body text-fg"
      role="note"
      data-testid="goal-link-archive-note"
    >
      <p>
        {t("linkNoteGoalHabits", {
          count: rows.length,
          habits: rows.map((link) => link.habit?.name ?? t("linkHabitDeleted")).join(", "),
          amount: unit
            ? texts.amount(total, unit.unit, unit.unitKind)
            : texts.numeric.number(total),
        })}
      </p>
      <p>{t(action === "archive" ? "linkNoteGoalArchive" : "linkNoteGoalDelete")}</p>
    </div>
  );
}
