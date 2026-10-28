"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";

import {
  habitWeekdayOrder,
  type HabitScheduleKind,
  type HabitWeekStart,
} from "@madeora/domain/habits";

import { SelectField } from "@/components/ui/select-field";
import { formatWeekday } from "@/habits/format";

/** A schedule as a form edits it. */
export interface ScheduleDraft {
  readonly kind: HabitScheduleKind;
  readonly weekdays: readonly number[];
  readonly target: number;
}

export const defaultSchedule: ScheduleDraft = { kind: "daily", weekdays: [], target: 3 };

/** The draft as the API takes it. */
export function scheduleBody(draft: ScheduleDraft) {
  return {
    kind: draft.kind,
    weekdays: draft.kind === "weekdays" ? [...draft.weekdays].sort((a, b) => a - b) : null,
    target: draft.kind === "weekly" ? draft.target : null,
  };
}

export interface HabitScheduleFieldsProps {
  readonly value: ScheduleDraft;
  readonly onChange: (value: ScheduleDraft) => void;
  readonly weekStart: HabitWeekStart;
  /** The weekdays error, already translated. */
  readonly error?: string | undefined;
  readonly disabled?: boolean;
}

/**
 * Picks a schedule: every day, chosen weekdays (in the habit's week order), or a number of days per
 * habit week. Native radio buttons and checkboxes, grouped with legends, so keyboards and screen
 * readers work without extra code.
 */
export function HabitScheduleFields({
  value,
  onChange,
  weekStart,
  error,
  disabled = false,
}: HabitScheduleFieldsProps) {
  const t = useTranslations("Habits");
  const locale = useLocale();
  const name = useId();
  const errorId = `${name}-error`;
  const kinds = [
    { kind: "daily", label: t("kindDaily") },
    { kind: "weekdays", label: t("kindWeekdays") },
    { kind: "weekly", label: t("kindWeekly") },
  ] as const;
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="text-body font-medium text-fg">{t("fieldSchedule")}</legend>
        <div className="flex flex-wrap gap-4">
          {kinds.map((option) => (
            <label key={option.kind} className="flex items-center gap-2 text-body text-fg">
              <input
                type="radio"
                name={name}
                value={option.kind}
                checked={value.kind === option.kind}
                className="size-4 accent-accent"
                onChange={() => {
                  onChange({ ...value, kind: option.kind });
                }}
                data-testid={`habit-kind-${option.kind}`}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      {value.kind === "weekdays" ? (
        <fieldset
          className="flex flex-col gap-2"
          disabled={disabled}
          aria-describedby={error ? errorId : undefined}
        >
          <legend className="text-body font-medium text-fg">{t("fieldWeekdays")}</legend>
          <div className="flex flex-wrap gap-3">
            {habitWeekdayOrder(weekStart).map((day) => (
              <label key={day} className="flex items-center gap-1.5 text-body text-fg">
                <input
                  type="checkbox"
                  checked={value.weekdays.includes(day)}
                  className="size-4 accent-accent"
                  onChange={(event) => {
                    onChange({
                      ...value,
                      weekdays: event.target.checked
                        ? [...value.weekdays, day]
                        : value.weekdays.filter((other) => other !== day),
                    });
                  }}
                  data-testid={`habit-weekday-${String(day)}`}
                />
                {formatWeekday(day, locale, "long")}
              </label>
            ))}
          </div>
          {error ? (
            <p id={errorId} className="text-helper text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {value.kind === "weekly" ? (
        <SelectField
          label={t("fieldTarget")}
          description={t("fieldTargetHint")}
          value={String(value.target)}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...value, target: Number(event.target.value) });
          }}
          options={[1, 2, 3, 4, 5, 6, 7].map((count) => ({
            value: String(count),
            label: t("targetOption", { count }),
          }))}
          data-testid="habit-target"
        />
      ) : null}
    </div>
  );
}
