"use client";

import { useTranslations } from "next-intl";

import type { ChoreHistoryRow } from "@/chores/api";
import { formatDateTime, type DateTimeFormats } from "@/invitations/format";
import type { MemberNames } from "@/tasks/format";

import { useChoreTexts } from "./use-chore-texts";

/**
 * The outcome line of a history row (S20), the same in a chore's history and the Home's: who did
 * it and who recorded it, with the approval; pending, needs rework, skipped (who), closed unclaimed (S21), missed or open.
 * A missed occurrence never reads as skipped, and nothing unresolved gets a completion time.
 */
export function useHistoryLine(names: MemberNames, formats: DateTimeFormats) {
  const t = useTranslations("Chores");
  const texts = useChoreTexts(names);
  return (row: ChoreHistoryRow): string => {
    switch (row.status) {
      case "completed": {
        const done = t("historyLineCompleted", {
          contributor: texts.person(row.contributor),
          person: texts.person(row.completedBy),
          date: row.completedAt ? formatDateTime(row.completedAt, formats) : "",
        });
        return row.approvedAt
          ? `${done} ${t("historyApproved", { person: texts.person(row.approvedBy) })}`
          : done;
      }
      case "pending_approval":
        return t("historyLinePending");
      case "rework":
        return t("historyLineRework");
      case "skipped":
        return t("historyLineSkipped", {
          person: texts.person(row.skippedBy),
          date: row.skippedAt ? formatDateTime(row.skippedAt, formats) : "",
        });
      case "expired":
        return t("historyLineExpired");
      case "missed":
        return t("historyLineMissed");
      case "due_today":
        return t("historyLineToday");
      case "open":
        return t("historyLineOpen");
    }
  };
}
