"use client";

import { useLocale, useTranslations } from "next-intl";

import type { HabitDayState, HabitStatus, HabitWeekStart } from "@madeora/domain/habits";

import type {
  HabitBlock,
  HabitFailure,
  HabitScheduleVersion,
  HabitStreak,
  HabitSummary,
} from "@/habits/api";
import { formatHabitDate, formatWeekday } from "@/habits/format";
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
  ended: "failureEnded",
  notEnded: "failureNotEnded",
  checkinsAfterEnd: "failureCheckinsAfterEnd",
  alreadyPaused: "failureAlreadyPaused",
  pauseEnded: "failurePauseEnded",
  alreadyCompleted: "failureAlreadyCompleted",
  targetReached: "failureTargetReached",
  outsideWindow: "failureOutsideWindow",
  untracked: "failureUntracked",
  notScheduled: "failureNotScheduled",
  paused: "failurePaused",
  future: "failureFuture",
  alreadyUndone: "failureAlreadyUndone",
  alreadySnoozed: "failureAlreadySnoozed",
  notNeeded: "failureNotNeeded",
  windowClosed: "failureWindowClosed",
  quietHours: "failureQuietHours",
  notParticipant: "failureNotParticipant",
  network: "failureNetwork",
  failed: "failureFailed",
} as const satisfies Record<HabitFailure, string>;

const stateKey = {
  untracked: "stateUntracked",
  not_scheduled: "stateNotScheduled",
  completed: "stateCompleted",
  paused: "statePaused",
  future: "stateFuture",
  open: "stateOpen",
  pending: "statePending",
  missed: "stateMissed",
} as const satisfies Record<HabitDayState, string>;

const statusKey = {
  active: "statusActive",
  paused: "statusPaused",
  ended: "statusEnded",
  upcoming: "statusUpcoming",
  archived: "statusArchived",
} as const satisfies Record<HabitStatus, string>;

const blockKey = {
  archived: "failureArchived",
  future: "failureFuture",
  outside_window: "failureOutsideWindow",
  untracked: "failureUntracked",
  not_scheduled: "failureNotScheduled",
  already_completed: "blockAlreadyCompleted",
  paused: "failurePaused",
  target_reached: "failureTargetReached",
} as const satisfies Record<HabitBlock, string>;

const weekStartKey = {
  monday: "weekStart_monday",
  saturday: "weekStart_saturday",
  sunday: "weekStart_sunday",
} as const satisfies Record<HabitWeekStart, string>;

const fieldKey = {
  required: "fieldRequired",
  tooLong: "fieldTooLong",
  invalidCharacters: "fieldInvalidCharacters",
  invalid: "fieldInvalid",
  weekdaysRequired: "fieldWeekdaysRequired",
  endBeforeStart: "fieldEndBeforeStart",
  timesRequired: "fieldTimesRequired",
} as const;
type FieldError = keyof typeof fieldKey;

function isFieldError(code: string): code is FieldError {
  return Object.hasOwn(fieldKey, code);
}

/** Texts of habits in the viewer's language: schedules, states, streaks and failures. */
export function useHabitTexts() {
  const t = useTranslations("Habits");
  const locale = useLocale();
  const weekdays = (days: readonly number[]) =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
      [...days].sort((a, b) => a - b).map((day) => formatWeekday(day, locale, "long")),
    );
  const schedule = (
    version:
      | (Pick<HabitScheduleVersion, "kind" | "target"> & {
          readonly weekdays: readonly number[] | null;
        })
      | null,
  ) => {
    if (!version) return t("scheduleNone");
    if (version.kind === "daily") return t("scheduleDaily");
    if (version.kind === "weekdays") {
      return t("scheduleWeekdays", { days: weekdays(version.weekdays ?? []) });
    }
    return t("scheduleWeekly", { count: version.target ?? 1 });
  };
  const streak = (value: Pick<HabitStreak, "current" | "unit">) =>
    value.unit === "weeks"
      ? t("streakWeeks", { count: value.current })
      : t("streakOccurrences", { count: value.current });
  const longest = (value: Pick<HabitStreak, "longestOccurrences" | "longestWeeks">) => {
    const parts = [
      ...(value.longestOccurrences > 0 || value.longestWeeks === 0
        ? [t("longestOccurrences", { count: value.longestOccurrences })]
        : []),
      ...(value.longestWeeks > 0 ? [t("longestWeeks", { count: value.longestWeeks })] : []),
    ];
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
  };
  const status = (habit: Pick<HabitSummary, "status" | "pause" | "pausedBy">) => {
    if (habit.status === "paused" && habit.pause) {
      return habit.pause.resumesOn
        ? t("statusPausedUntil", { date: formatHabitDate(habit.pause.resumesOn, locale, "short") })
        : t("statusPausedOpen");
    }
    if (habit.status === "paused" && habit.pausedBy === "vacation")
      return t("statusPausedVacation");
    return t(statusKey[habit.status]);
  };
  /** Who did something: "you", a member's name, or a neutral word for an unnamed or former one. */
  const who = (by: string | null, mine: boolean, names: MemberNames) => {
    const person = personName({ me: mine, member: by }, names);
    if (person.kind === "me") return t("personYou");
    if (person.kind === "member") return person.name;
    return person.kind === "unnamed" ? t("personUnnamed") : t("personFormer");
  };
  return {
    who,
    schedule,
    weekdays,
    streak,
    longest,
    status,
    state: (state: HabitDayState) => t(stateKey[state]),
    block: (block: HabitBlock) => t(blockKey[block]),
    weekStart: (weekStart: HabitWeekStart) => t(weekStartKey[weekStart]),
    failure: (failure: HabitFailure) => t(failureKey[failure]),
    field: (code: string | undefined) =>
      code && isFieldError(code) ? t(fieldKey[code]) : t("fieldInvalid"),
    date: (date: string, style: "long" | "short" | "weekday" | "month" = "long") =>
      formatHabitDate(date, locale, style),
  };
}
