"use client";

import { useTranslations } from "next-intl";

import type { ChoreFailure, ChorePerson } from "@/chores/api";
import { personName, type MemberNames } from "@/tasks/format";

const failureKey = {
  signedOut: "errorSignedOut",
  invalid: "errorInvalid",
  notFound: "errorNotFound",
  notPermitted: "errorNotPermitted",
  conflict: "errorConflict",
  duplicateName: "errorDuplicateName",
  limitReached: "errorLimitReached",
  stepsIncomplete: "errorStepsIncomplete",
  alreadyCompleted: "errorAlreadyCompleted",
  alreadySkipped: "errorAlreadySkipped",
  alreadySubmitted: "errorAlreadySubmitted",
  pendingApproval: "errorPendingApproval",
  notPending: "errorNotPending",
  contributorUnavailable: "errorContributorUnavailable",
  notCompleted: "errorNotCompleted",
  occurrenceClosed: "errorOccurrenceClosed",
  needsConfirmation: "errorNeedsConfirmation",
  scopeUnavailable: "errorScopeUnavailable",
  notRecurring: "errorNotRecurring",
  scheduleEnded: "errorScheduleEnded",
  network: "errorNetwork",
  failed: "errorFailed",
} as const satisfies Record<ChoreFailure, string>;

/** The chore texts that depend on data: people and failures. Works in client components. */
export function useChoreTexts(names: MemberNames) {
  const t = useTranslations("Chores");
  function person(who: ChorePerson | null): string {
    if (who === null) return t("personFormer");
    const name = personName(who, names);
    switch (name.kind) {
      case "me":
        return t("personYou");
      case "member":
        return name.name;
      case "unnamed":
        return t("personUnnamed");
      case "former":
        return t("personFormer");
    }
  }
  return {
    person,
    /** A membership id, or a departed member's empty place (null). */
    member(memberId: string | null): string {
      return memberId === null ? t("emptyPlace") : person({ me: false, member: memberId });
    },
    failure(failure: ChoreFailure, count: number | null = null): string {
      return t(failureKey[failure], { count: count ?? 0 });
    },
  };
}
