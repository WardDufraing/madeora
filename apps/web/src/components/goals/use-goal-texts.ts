"use client";

import { useLocale, useTranslations } from "next-intl";

import type { GoalEntryKind, GoalStatus } from "@madeora/domain/goals";
import type { HabitUnitKind } from "@madeora/domain/habits";

import { useNumericTexts } from "@/components/habits/use-numeric-texts";
import type { GoalFailure, GoalSummary } from "@/goals/api";
import { formatHabitDate } from "@/habits/format";
import { personName, type MemberNames } from "@/tasks/format";

const failureKey = {
  signedOut: "failureSignedOut",
  invalid: "failureInvalid",
  notFound: "failureNotFound",
  notPermitted: "failureNotPermitted",
  conflict: "failureConflict",
  idTaken: "failureFailed",
  invalidDates: "failureInvalidDates",
  limitReached: "failureLimitReached",
  archived: "failureArchived",
  achieved: "failureAchieved",
  notMeasurable: "failureNotMeasurable",
  stale: "failureStale",
  alreadyReversed: "failureAlreadyReversed",
  negativeTotal: "failureNegativeTotal",
  targetNotReached: "failureTargetNotReached",
  confirmUnit: "failureConfirmUnit",
  confirmStatus: "failureConfirmStatus",
  noDeadline: "failureNoDeadline",
  network: "failureNetwork",
  failed: "failureFailed",
} as const satisfies Record<GoalFailure, string>;

const statusKey = {
  active: "statusActive",
  overdue: "statusOverdue",
  achieved: "statusAchieved",
  archived: "statusArchived",
} as const satisfies Record<GoalStatus, string>;

const entryKindKey = {
  initial: "entryInitial",
  contribution: "entryContribution",
  adjustment: "entryAdjustment",
} as const satisfies Record<GoalEntryKind, string>;

const fieldKey = {
  required: "fieldRequired",
  tooLong: "fieldTooLong",
  invalidCharacters: "fieldInvalidCharacters",
  invalid: "fieldInvalid",
  pastDeadline: "fieldPastDeadline",
} as const;
type FieldError = keyof typeof fieldKey;

function isFieldError(code: string): code is FieldError {
  return Object.hasOwn(fieldKey, code);
}

/** Texts of goals in the viewer's language: states, amounts, people, dates and failures. */
export function useGoalTexts() {
  const t = useTranslations("Goals");
  const locale = useLocale();
  const numeric = useNumericTexts();
  /** Who did something: "you", a member's name, or a neutral word for an unnamed or former one. */
  const who = (by: string | null, mine: boolean, names: MemberNames) => {
    const person = personName({ me: mine, member: by }, names);
    if (person.kind === "me") return t("personYou");
    if (person.kind === "member") return person.name;
    return person.kind === "unnamed" ? t("personUnnamed") : t("personFormer");
  };
  /** An amount in a goal's unit ("2.5 km", "3 books"). */
  const amount = (value: number, unit: string | null, kind: HabitUnitKind | null) =>
    unit && kind ? numeric.amount(value, unit, kind) : numeric.number(value);
  /** A measurable goal's progress ("7.5 / 10 km"). */
  const progress = (goal: Pick<GoalSummary, "total" | "target" | "unit" | "unitKind">) =>
    goal.target !== null && goal.unit && goal.unitKind
      ? numeric.progress(goal.total, goal.target, goal.unit, goal.unitKind)
      : numeric.number(goal.total);
  /** An instant in the goal's timezone, so the server and the browser render the same text. */
  const instant = (at: string, timeZone: string) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(at));
  return {
    t,
    locale,
    numeric,
    who,
    amount,
    progress,
    instant,
    status: (status: GoalStatus) => t(statusKey[status]),
    entryKind: (kind: GoalEntryKind) => t(entryKindKey[kind]),
    failure: (failure: GoalFailure) => t(failureKey[failure]),
    field: (code: string | undefined) =>
      code && isFieldError(code) ? t(fieldKey[code]) : t("fieldInvalid"),
    date: (date: string, style: "long" | "short" = "long") => formatHabitDate(date, locale, style),
  };
}
