"use client";

import { useTranslations } from "next-intl";

import type { TaskFailure, TaskPerson } from "@/tasks/api";
import { personName, type MemberNames } from "@/tasks/format";
import type { TaskPriority } from "@/tasks/schema";

const failureKey = {
  signedOut: "errorSignedOut",
  invalid: "errorInvalid",
  notFound: "errorNotFound",
  notPermitted: "errorNotPermitted",
  conflict: "errorConflict",
  duplicateName: "errorDuplicateName",
  limitReached: "errorLimitReached",
  listUnavailable: "errorListUnavailable",
  hasTasks: "errorHasTasks",
  hasOpenTasks: "errorHasOpenTasks",
  network: "errorNetwork",
  failed: "errorFailed",
} as const satisfies Record<TaskFailure, string>;

const priorityKey = {
  low: "priorityLow",
  normal: "priorityNormal",
  high: "priorityHigh",
  urgent: "priorityUrgent",
} as const satisfies Record<TaskPriority, string>;

/** The task texts that depend on data: people, priorities, failures. Works in client components. */
export function useTaskTexts(names: MemberNames) {
  const t = useTranslations("Tasks");
  function person(who: TaskPerson): string {
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
    member(memberId: string): string {
      return person({ me: false, member: memberId });
    },
    priority(priority: TaskPriority | null): string {
      return priority ? t(priorityKey[priority]) : t("priorityUnset");
    },
    failure(failure: TaskFailure, count: number | null = null): string {
      return t(failureKey[failure], { count: count ?? 0 });
    },
  };
}
