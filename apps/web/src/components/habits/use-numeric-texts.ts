"use client";

import { useLocale, useTranslations } from "next-intl";

import type { HabitUnitKind, QuantityProblem } from "@madeora/domain/habits";

import { isPresetUnit, unitMessageKey } from "@/habits/numeric-keys";
import type { ContributionBlock } from "@/habits/shapes";

const unitOptionKey = {
  glasses: "unitOptionGlasses",
  pages: "unitOptionPages",
  repetitions: "unitOptionRepetitions",
  ml: "unitOptionMl",
  l: "unitOptionL",
  min: "unitOptionMin",
  h: "unitOptionH",
  m: "unitOptionM",
  km: "unitOptionKm",
} as const;

const problemKey = {
  empty: "problemEmpty",
  malformed: "problemMalformed",
  separator: "problemSeparator",
  precision: "problemPrecision",
  "not-positive": "problemNotPositive",
  range: "problemRange",
  whole: "problemWhole",
} as const satisfies Record<QuantityProblem, string>;

const blockKey = {
  archived: "blockArchived",
  future: "blockFuture",
  outside_window: "blockOutsideWindow",
  untracked: "blockUntracked",
  not_scheduled: "blockNotScheduled",
  already_completed: "blockNotScheduled",
  paused: "blockPaused",
  target_reached: "blockNotScheduled",
  not_numeric: "blockNotNumeric",
} as const satisfies Record<ContributionBlock, string>;

/** Quantity texts of numeric habits in the viewer's language: amounts, units and entry problems. */
export function useNumericTexts() {
  const t = useTranslations("HabitsNumeric");
  const locale = useLocale();
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  const number = (value: number) => format.format(value);
  /** A unit's name for a count: presets are translated, a custom label is shown as written. */
  const unitLabel = (unit: string, kind: HabitUnitKind, count = 2) =>
    kind === "preset" && isPresetUnit(unit) ? t(unitMessageKey(unit, count, locale)) : unit;
  const unitOption = (unit: string) => (isPresetUnit(unit) ? t(unitOptionKey[unit]) : unit);
  const amount = (value: number, unit: string, kind: HabitUnitKind) =>
    t("amount", { value: number(value), unit: unitLabel(unit, kind, value) });
  const progress = (total: number, target: number, unit: string, kind: HabitUnitKind) =>
    t("progressText", {
      total: number(total),
      target: number(target),
      unit: unitLabel(unit, kind, target),
    });
  return {
    t,
    locale,
    number,
    unitLabel,
    unitOption,
    amount,
    progress,
    problem: (problem: QuantityProblem) => t(problemKey[problem]),
    block: (block: ContributionBlock) => t(blockKey[block]),
  };
}
