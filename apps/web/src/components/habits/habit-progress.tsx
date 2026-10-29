"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";

import {
  areUnitsConvertible,
  convertThousandths,
  habitUnits,
  parseQuantity,
  progressFraction,
  thousandthsToDecimal,
  toThousandths,
  type HabitUnit,
} from "@madeora/domain/habits";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { HabitProgress, HabitSummary } from "@/habits/api";
import { habitsPath, newId } from "@/habits/format";

import { QuantityField } from "./numeric-fields";
import { useHabitContributions } from "./use-habit-contributions";
import { useNumericTexts } from "./use-numeric-texts";

/** A numeric habit's unit as the domain helpers take it. */
export function trackingUnit(habit: Pick<HabitSummary, "tracking">): HabitUnit | null {
  const { unit, unitKind } = habit.tracking;
  return unit === null || unitKind === null ? null : { unit, kind: unitKind };
}

export function isNumeric(habit: Pick<HabitSummary, "tracking">): boolean {
  return habit.tracking.mode === "numeric";
}

/** Amount against target as text, a bar capped at the target, and the excess when there is one. */
export function ProgressMeter({
  habit,
  progress,
}: {
  readonly habit: Pick<HabitSummary, "name">;
  readonly progress: HabitProgress;
}) {
  const t = useTranslations("HabitsNumeric");
  const texts = useNumericTexts();
  const summary = texts.progress(progress.total, progress.target, progress.unit, progress.unitKind);
  return (
    <div className="flex flex-col gap-1.5" data-testid="habit-progress">
      <p className="text-body font-medium text-fg" data-testid="habit-progress-text">
        {summary}
      </p>
      <div
        role="progressbar"
        aria-label={t("progressBarLabel", { habit: habit.name })}
        aria-valuemin={0}
        aria-valuemax={progress.target}
        aria-valuenow={Math.min(progress.total, progress.target)}
        aria-valuetext={summary}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{
            width: `${String(Math.round(progressFraction(progress.total, progress.target) * 100))}%`,
          }}
        />
      </div>
      {progress.above ? (
        <p className="text-helper text-fg-muted" data-testid="habit-progress-above">
          {t("aboveTarget", {
            excess: texts.amount(toExcess(progress), progress.unit, progress.unitKind),
          })}
        </p>
      ) : progress.met ? (
        <p className="text-helper text-fg-muted">{t("targetReached")}</p>
      ) : null}
    </div>
  );
}

/** The part above the target, exact in thousandths. */
function toExcess(progress: HabitProgress): number {
  return (toThousandths(progress.total) - toThousandths(progress.target)) / 1000;
}

/** Quick-add presets as buttons: one tap adds the amount to today. */
export function QuickAddButtons({
  habit,
  source,
  compact = false,
}: {
  readonly habit: HabitSummary;
  readonly source: "app" | "widget";
  readonly compact?: boolean;
}) {
  const t = useTranslations("HabitsNumeric");
  const texts = useNumericTexts();
  const hydrated = useHydrated();
  const contributions = useHabitContributions(`habit:${habit.id}`);
  const { unit, unitKind } = habit.tracking;
  if (unit === null || unitKind === null || habit.tracking.quickAdds.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-2" aria-label={t("quickAddsTitle")}>
        {habit.tracking.quickAdds.map((amount) => {
          const label = texts.amount(amount, unit, unitKind);
          return (
            <li key={amount}>
              <Button
                size={compact ? "sm" : "md"}
                variant="secondary"
                disabled={!hydrated || contributions.add.busy}
                aria-label={t("quickAddButtonLabel", { amount: label, habit: habit.name })}
                onClick={() => {
                  contributions.reset();
                  contributions.add.mutate({
                    id: newId(),
                    habitId: habit.id,
                    name: habit.name,
                    quantity: thousandthsToDecimal(toThousandths(amount)),
                    label,
                    onDate: null,
                    enteredUnit: null,
                    source,
                    revision: source === "widget" ? habit.revision : null,
                  });
                }}
                data-testid="habit-quick-add"
              >
                {`+${label}`}
              </Button>
            </li>
          );
        })}
      </ul>
      {contributions.failureText ? (
        <FormAlert tone="error" announce>
          {contributions.failureText}
        </FormAlert>
      ) : null}
    </div>
  );
}

/** Other units of the habit's own dimension, for an entry in a different but convertible unit. */
function alternateUnits(unit: HabitUnit | null): readonly HabitUnit[] {
  if (unit === null || unit.kind !== "preset") return [];
  return habitUnits
    .map((definition): HabitUnit => ({ unit: definition.code, kind: "preset" }))
    .filter((candidate) => candidate.unit !== unit.unit && areUnitsConvertible(candidate, unit));
}

/**
 * Manual entry of progress for a day (today unless `onDate`): the amount typed in the viewer's
 * locale, optionally in another unit of the same kind, with the converted amount shown before saving.
 * A conversion that would need more than three decimals is refused with the rounded amount.
 */
export function ProgressEntry({
  habit,
  onDate = null,
  source = "app",
  onDone,
}: {
  readonly habit: HabitSummary;
  readonly onDate?: string | null;
  readonly source?: "app" | "widget";
  readonly onDone?: () => void;
}) {
  const t = useTranslations("HabitsNumeric");
  const texts = useNumericTexts();
  const hydrated = useHydrated();
  const contributions = useHabitContributions(`habit:${habit.id}`);
  const own = trackingUnit(habit);
  const alternates = alternateUnits(own);
  const [text, setText] = useState("");
  const [entered, setEntered] = useState("");
  const [attempt, setAttempt] = useState(newId);
  const [missing, setMissing] = useState(false);
  const enteredUnit: HabitUnit | null = entered === "" ? null : { unit: entered, kind: "preset" };
  const parsed = parseQuantity(text, texts.locale, enteredUnit ?? own ?? undefined);
  const conversion =
    parsed.ok && enteredUnit && own
      ? convertThousandths(parsed.thousandths, enteredUnit, own)
      : null;
  const refused = contributions.add.error?.failure === "precision";
  const rounded = contributions.add.error?.details.converted;
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!parsed.ok) {
          setMissing(true);
          return;
        }
        if (conversion && !conversion.exact) return;
        contributions.reset();
        const label = enteredUnit
          ? texts.amount(parsed.thousandths / 1000, enteredUnit.unit, "preset")
          : own
            ? texts.amount(parsed.thousandths / 1000, own.unit, own.kind)
            : text;
        contributions.add.mutate(
          {
            id: attempt,
            habitId: habit.id,
            name: habit.name,
            quantity: thousandthsToDecimal(parsed.thousandths),
            label,
            onDate,
            enteredUnit: enteredUnit?.unit ?? null,
            source,
          },
          {
            onSuccess: () => {
              setText("");
              setMissing(false);
              setAttempt(newId());
              onDone?.();
            },
          },
        );
      }}
      data-testid="habit-progress-form"
    >
      <QuantityField
        label={t("addProgressLabel")}
        value={text}
        unit={enteredUnit ?? own}
        error={missing && text.trim() === "" ? texts.problem("empty") : undefined}
        onChange={(next) => {
          setText(next);
          setMissing(false);
          contributions.reset();
        }}
        testId="habit-progress-quantity"
      />
      {alternates.length > 0 ? (
        <SelectField
          label={t("enteredUnitLabel")}
          value={entered}
          options={[
            { value: "", label: own ? texts.unitOption(own.unit) : "" },
            ...alternates.map((candidate) => ({
              value: candidate.unit,
              label: texts.unitOption(candidate.unit),
            })),
          ]}
          onChange={(event) => {
            setEntered(event.target.value);
            contributions.reset();
          }}
          data-testid="habit-progress-unit"
        />
      ) : null}
      {conversion && own ? (
        <p className="text-helper text-fg-muted" data-testid="habit-progress-conversion">
          {conversion.exact
            ? t("conversionPreview", {
                amount: texts.amount(conversion.thousandths / 1000, own.unit, own.kind),
              })
            : t("conversionPrecision", {
                amount: texts.amount(conversion.thousandths / 1000, own.unit, own.kind),
              })}
        </p>
      ) : null}
      {refused && typeof rounded === "number" && own ? (
        <FormAlert tone="error" announce>
          {t("conversionPrecision", { amount: texts.amount(rounded, own.unit, own.kind) })}
        </FormAlert>
      ) : contributions.failureText ? (
        <FormAlert tone="error" announce>
          {contributions.failureText}
        </FormAlert>
      ) : null}
      <div>
        <Button
          type="submit"
          disabled={!hydrated || (conversion !== null && !conversion.exact)}
          loading={contributions.add.busy}
          data-testid="habit-progress-submit"
        >
          {t("addProgress")}
        </Button>
      </div>
    </form>
  );
}

/**
 * A numeric habit in the list and the widget: today's amount against the target, and (in the
 * widget) the quick-add buttons; the habit's page takes manual entry. Complete never appears here, as
 * a quantity cannot be invented.
 */
export function NumericToday({
  habit,
  source,
  compact,
}: {
  readonly habit: HabitSummary;
  readonly source: "app" | "widget";
  readonly compact: boolean;
}) {
  const t = useTranslations("HabitsNumeric");
  const texts = useNumericTexts();
  const may = habit.access !== "view" && habit.contributionBlock === null;
  return (
    <div className="flex flex-col gap-2" data-testid="habit-numeric-today">
      {habit.progress ? (
        <ProgressMeter habit={habit} progress={habit.progress} />
      ) : (
        <p className="text-helper text-fg-muted" data-testid="habit-today-state">
          {habit.contributionBlock ? texts.block(habit.contributionBlock) : t("noProgressToday")}
        </p>
      )}
      {may && compact ? <QuickAddButtons habit={habit} source={source} compact /> : null}
      {may ? (
        <Link
          href={habitsPath(habit.homeId, habit.id)}
          className="text-body font-medium text-accent-fg underline"
          aria-label={t("openHabit", { habit: habit.name })}
          data-testid="habit-open"
        >
          {t("open")}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Today's progress on the habit's page: the meter, quick-add buttons and manual entry for people who
 * may add progress, or why they cannot today. View-only members see the total only.
 */
export function HabitProgressCard({
  habit,
  onEditQuickAdds,
}: {
  readonly habit: HabitSummary;
  readonly onEditQuickAdds?: (() => void) | undefined;
}) {
  const t = useTranslations("HabitsNumeric");
  const texts = useNumericTexts();
  const may = habit.access !== "view" && habit.contributionBlock === null;
  return (
    <div className="flex flex-col gap-4" data-testid="habit-progress-card">
      {habit.progress ? (
        <ProgressMeter habit={habit} progress={habit.progress} />
      ) : (
        <p className="text-body text-fg-muted" data-testid="habit-today-state">
          {habit.contributionBlock ? texts.block(habit.contributionBlock) : t("noProgressToday")}
        </p>
      )}
      {habit.access === "view" ? (
        <p className="text-helper text-fg-muted">{t("viewOnly")}</p>
      ) : null}
      {may ? (
        <>
          <QuickAddButtons habit={habit} source="app" />
          <ProgressEntry habit={habit} />
        </>
      ) : null}
      {onEditQuickAdds ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={onEditQuickAdds}
            data-testid="habit-edit-quick-adds"
          >
            {t("editQuickAdds")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
