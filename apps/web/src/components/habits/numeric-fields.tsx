"use client";

import { useTranslations } from "next-intl";

import {
  habitUnits,
  HABIT_QUANTITY,
  decimalSeparator,
  isDiscreteUnit,
  parseQuantity,
  type HabitUnit,
} from "@madeora/domain/habits";

import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import {
  CUSTOM_UNIT,
  draftUnit,
  withUnit,
  type TrackingDraft,
  type TrackingErrors,
} from "@/habits/tracking-draft";

import { useNumericTexts } from "./use-numeric-texts";

export interface QuantityFieldProps {
  readonly label: string;
  readonly description?: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  /** Whole-number units refuse decimals. */
  readonly unit?: HabitUnit | null;
  /** A problem found when submitting (an empty field), shown even before anything is typed. */
  readonly error?: string | undefined;
  readonly testId?: string;
  readonly disabled?: boolean;
}

/**
 * A quantity typed in the viewer's locale (`1,5` in Dutch, `1.5` in English). It refuses the other
 * locale's separator, thousands separators and signs with a reason instead of guessing, and shows the
 * normalized value it will save before anything is sent.
 */
export function QuantityField({
  label,
  description,
  value,
  onChange,
  unit,
  error,
  testId,
  disabled,
}: QuantityFieldProps) {
  const t = useTranslations("HabitsNumeric");
  const texts = useNumericTexts();
  const parsed = value.trim() === "" ? null : parseQuantity(value, texts.locale, unit ?? undefined);
  const problem = parsed && !parsed.ok ? texts.problem(parsed.problem) : undefined;
  const normalized =
    parsed?.ok === true
      ? t("normalized", { value: texts.number(parsed.thousandths / 1000) })
      : undefined;
  const hint = [description, normalized].filter(Boolean).join(" ");
  return (
    <TextField
      label={label}
      {...(hint === "" ? {} : { description: hint })}
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      placeholder={t("placeholder", { example: `1${decimalSeparator(texts.locale)}5` })}
      value={value}
      disabled={disabled}
      error={error ?? problem}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      {...(testId ? { "data-testid": testId } : {})}
    />
  );
}

export interface QuickAddsEditorProps {
  readonly values: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
  readonly unit: HabitUnit | null;
  readonly errors?: TrackingErrors["quickAdds"];
  readonly testId?: string;
}

/** Up to five quick-add presets: a quantity each, added or removed one at a time. */
export function QuickAddsEditor({ values, onChange, unit, errors, testId }: QuickAddsEditorProps) {
  const t = useTranslations("HabitsNumeric");
  const texts = useNumericTexts();
  return (
    <fieldset className="flex flex-col gap-3" data-testid={testId}>
      <legend className="text-body font-medium text-fg">{t("quickAddsTitle")}</legend>
      <p className="text-helper text-fg-muted">
        {t("quickAddsHint", { max: HABIT_QUANTITY.quickAdds })}
      </p>
      {values.map((value, index) => {
        const problem = errors?.[index];
        return (
          <div key={index} className="flex flex-wrap items-end gap-2">
            <QuantityField
              label={t("quickAddLabel", { position: index + 1 })}
              value={value}
              unit={unit}
              error={
                problem === undefined
                  ? undefined
                  : problem === "duplicate"
                    ? t("problemDuplicate")
                    : texts.problem(problem)
              }
              onChange={(text) => {
                onChange(values.map((current, at) => (at === index ? text : current)));
              }}
              testId={`${testId ?? "quick-add"}-${String(index)}`}
            />
            <Button
              variant="secondary"
              size="sm"
              aria-label={t("quickAddRemove", { position: index + 1 })}
              onClick={() => {
                onChange(values.filter((_, at) => at !== index));
              }}
            >
              {t("remove")}
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={values.length >= HABIT_QUANTITY.quickAdds}
          onClick={() => {
            onChange([...values, ""]);
          }}
          data-testid={`${testId ?? "quick-add"}-add`}
        >
          {t("quickAddAdd")}
        </Button>
      </div>
    </fieldset>
  );
}

/** A sample of how progress reads in the chosen unit ("500 / 2,000 mL", "3 / 8 glasses"). */
function exampleProgress(
  unit: HabitUnit | null,
  progress: (total: number, target: number, unit: string, kind: HabitUnit["kind"]) => string,
): string {
  const chosen = unit ?? { unit: "glasses", kind: "preset" as const };
  if (chosen.kind === "preset" && chosen.unit === "ml") return progress(500, 2000, "ml", "preset");
  return isDiscreteUnit(chosen) || chosen.kind === "custom"
    ? progress(3, 8, chosen.unit, chosen.kind)
    : progress(0.5, 2, chosen.unit, chosen.kind);
}

export interface TrackingFieldsProps {
  readonly value: TrackingDraft;
  readonly onChange: (value: TrackingDraft) => void;
  /** A weekly schedule cannot be numeric. */
  readonly weekly: boolean;
  readonly errors?: TrackingErrors | undefined;
  /** Hides the mode choice (changing the target of a habit that is already numeric). */
  readonly fixedNumeric?: boolean;
  /** Hides the presets (they are edited on their own). */
  readonly withoutQuickAdds?: boolean;
}

/**
 * The tracking of a habit: complete once, or a daily target in a unit. A daily target is "per
 * eligible day"; there is no weekly target. The example line shows how progress will read.
 */
export function TrackingFields({
  value,
  onChange,
  weekly,
  errors,
  fixedNumeric = false,
  withoutQuickAdds = false,
}: TrackingFieldsProps) {
  const t = useTranslations("HabitsNumeric");
  const texts = useNumericTexts();
  const unit = draftUnit(value);
  const unitOptions = [
    ...habitUnits.map((definition) => ({
      value: definition.code,
      label: texts.unitOption(definition.code),
    })),
    { value: CUSTOM_UNIT, label: t("unitOptionCustom") },
  ];
  const numeric = value.numeric && !weekly;
  return (
    <div className="flex flex-col gap-4" data-testid="tracking-fields">
      {fixedNumeric ? null : (
        <SelectField
          label={t("trackingLabel")}
          description={weekly ? t("trackingNeedsDaily") : t("trackingHint")}
          disabled={weekly}
          value={numeric ? "numeric" : "once"}
          options={[
            { value: "once", label: t("trackingOnce") },
            { value: "numeric", label: t("trackingNumeric") },
          ]}
          onChange={(event) => {
            onChange({ ...value, numeric: event.target.value === "numeric" });
          }}
          data-testid="tracking-mode"
        />
      )}
      {numeric ? (
        <>
          <SelectField
            label={t("unitLabel")}
            value={value.unit}
            options={unitOptions}
            onChange={(event) => {
              onChange(withUnit(value, event.target.value, value.custom, texts.locale));
            }}
            data-testid="tracking-unit"
          />
          {value.unit === CUSTOM_UNIT ? (
            <TextField
              label={t("customUnitLabel")}
              description={t("customUnitHint", { max: HABIT_QUANTITY.customUnitLength })}
              value={value.custom}
              maxLength={HABIT_QUANTITY.customUnitLength * 2}
              autoComplete="off"
              error={
                errors?.unit === "required"
                  ? t("problemUnitRequired")
                  : errors?.unit === "tooLong"
                    ? t("problemUnitTooLong", { max: HABIT_QUANTITY.customUnitLength })
                    : undefined
              }
              onChange={(event) => {
                onChange(withUnit(value, CUSTOM_UNIT, event.target.value, texts.locale));
              }}
              data-testid="tracking-custom-unit"
            />
          ) : null}
          <QuantityField
            label={t("targetLabel")}
            description={t("targetHint")}
            value={value.target}
            unit={unit}
            error={errors?.target === undefined ? undefined : texts.problem(errors.target)}
            onChange={(text) => {
              onChange({ ...value, target: text });
            }}
            testId="tracking-target"
          />
          <p className="text-helper text-fg-muted">
            {t("example", { example: exampleProgress(unit, texts.progress) })}
          </p>
          {withoutQuickAdds ? null : (
            <QuickAddsEditor
              values={value.quickAdds}
              unit={unit}
              {...(errors ? { errors: errors.quickAdds } : {})}
              onChange={(quickAdds) => {
                onChange({ ...value, quickAdds });
              }}
              testId="tracking-quick-adds"
            />
          )}
        </>
      ) : null}
    </div>
  );
}
