"use client";

import {
  isoWeekday,
  recurrenceFrequencies,
  upcomingDates,
  type IsoWeekday,
  type RecurrenceRule,
} from "@madeora/domain/tasks";
import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import { z } from "zod";

import { RadioOption } from "@/components/settings/radio-option";
import { Checkbox } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import type { DateFormat } from "@/preferences/schema";
import type { TaskSeries } from "@/tasks/api";
import { formatTaskDate } from "@/tasks/format";
import { dateOnlySchema, recurrenceSchema, type RecurrenceInput } from "@/tasks/schema";

/**
 * The repeat fields of a task (S19): how often, which weekdays, and when it ends. The draft is what
 * the inputs hold (strings while typing); `repeatSchema` turns it into a schedule without its first
 * date, which the form adds (the due date when creating, the chosen date when editing).
 */

export const repeatChoices = ["none", ...recurrenceFrequencies] as const;
export type RepeatChoice = (typeof repeatChoices)[number];
export const repeatEnds = ["never", "on", "after"] as const;

/** What the inputs hold (strings while typing). */
export type RepeatDraft = z.input<typeof repeatSchema>;

export type RepeatError = "interval" | "weekdays" | "endsOn" | "count";

/** A schedule without its first date. */
export type RepeatValue = Omit<RecurrenceInput, "startsOn">;

export const noRepeat: RepeatDraft = {
  frequency: "none",
  interval: "1",
  weekdays: [],
  ends: "never",
  endsOn: "",
  count: "",
};

/** The draft of an existing series' schedule. */
export function repeatDraftOf(series: TaskSeries): RepeatDraft {
  return {
    frequency: series.frequency,
    interval: String(series.interval),
    weekdays: [...(series.weekdays ?? [])],
    ends: series.count !== null ? "after" : series.endsOn !== null ? "on" : "never",
    endsOn: series.endsOn ?? "",
    count: series.count !== null ? String(series.count) : "",
  };
}

const wholeNumber = /^\d{1,4}$/;

/** Validates a draft; the output is null for "Does not repeat". */
export const repeatSchema = z
  .object({
    frequency: z.enum(repeatChoices),
    interval: z.string(),
    weekdays: z.array(z.number()),
    ends: z.enum(repeatEnds),
    endsOn: z.string(),
    count: z.string(),
  })
  .superRefine((draft, context) => {
    if (draft.frequency === "none") return;
    const interval = draft.interval.trim();
    if (!wholeNumber.test(interval) || Number(interval) < 1 || Number(interval) > 99) {
      context.addIssue({
        code: "custom",
        message: "interval" satisfies RepeatError,
        path: ["interval"],
      });
    }
    if (draft.frequency === "weekly" && draft.weekdays.length === 0) {
      context.addIssue({
        code: "custom",
        message: "weekdays" satisfies RepeatError,
        path: ["weekdays"],
      });
    }
    if (draft.ends === "on" && !dateOnlySchema.safeParse(draft.endsOn).success) {
      context.addIssue({
        code: "custom",
        message: "endsOn" satisfies RepeatError,
        path: ["endsOn"],
      });
    }
    const count = draft.count.trim();
    if (
      draft.ends === "after" &&
      (!wholeNumber.test(count) || Number(count) < 1 || Number(count) > 999)
    ) {
      context.addIssue({ code: "custom", message: "count" satisfies RepeatError, path: ["count"] });
    }
  })
  .transform((draft): RepeatValue | null => {
    if (draft.frequency === "none") return null;
    return {
      frequency: draft.frequency,
      interval: Number(draft.interval.trim()),
      weekdays:
        draft.frequency === "weekly"
          ? ([...new Set(draft.weekdays)].sort((a, b) => a - b) as IsoWeekday[])
          : null,
      endsOn: draft.ends === "on" ? draft.endsOn : null,
      count: draft.ends === "after" ? Number(draft.count.trim()) : null,
    };
  });

/** The full schedule from its parts, or null when it would not be accepted. */
export function ruleOf(value: RepeatValue | null, startsOn: string | null): RecurrenceRule | null {
  if (!value || !startsOn) return null;
  const parsed = recurrenceSchema.safeParse({ ...value, startsOn });
  return parsed.success ? parsed.data : null;
}

/** The rule from a draft as it stands while typing (for the live summary), or null. */
export function draftRule(draft: RepeatDraft, startsOn: string | null): RecurrenceRule | null {
  const parsed = repeatSchema.safeParse(draft);
  return parsed.success ? ruleOf(parsed.data, startsOn) : null;
}

const weekdayOrder: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];
/** 2024-01-01 was a Monday: weekday n is 2024-01-0n. */
const weekdayDate = (day: IsoWeekday) => new Date(Date.UTC(2024, 0, day));

/** Plain-language texts of a schedule in the page's language. */
export function useRecurrenceText(dateFormat: DateFormat) {
  const t = useTranslations("Tasks");
  const locale = useLocale();
  const weekdayName = (day: IsoWeekday) =>
    new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(weekdayDate(day));
  const list = (items: readonly string[]) =>
    new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
  const date = (value: string) => formatTaskDate(value, { dateFormat });

  function rule(value: RecurrenceRule): string {
    const interval = value.interval;
    const [year, month, day] = value.startsOn.split("-").map(Number) as [number, number, number];
    let text: string;
    switch (value.frequency) {
      case "daily":
        text = t("repeatSummaryDaily", { interval });
        break;
      case "weekly":
        text = t("repeatSummaryWeekly", {
          interval,
          days: list((value.weekdays ?? []).map(weekdayName)),
        });
        break;
      case "monthly":
        text = t("repeatSummaryMonthly", { interval, day });
        if (day > 28) text = `${text} ${t("repeatSummaryMonthEnd")}`;
        break;
      case "yearly": {
        const monthDay = new Intl.DateTimeFormat(locale, {
          day: "numeric",
          month: "long",
          timeZone: "UTC",
        }).format(new Date(Date.UTC(year, month - 1, day)));
        text = t("repeatSummaryYearly", { interval, date: monthDay });
        if (month === 2 && day === 29) text = `${text} ${t("repeatSummaryLeapDay")}`;
        break;
      }
    }
    if (value.count !== null) {
      return t("repeatSummaryEnd", {
        rule: text,
        end: t("repeatEndsAfterSummary", { count: value.count }),
      });
    }
    if (value.endsOn !== null) {
      return t("repeatSummaryEnd", {
        rule: text,
        end: t("repeatEndsOnSummary", { date: date(value.endsOn) }),
      });
    }
    return text;
  }

  return { rule, weekdayName, list, date };
}

const frequencyKey = {
  none: "repeatNone",
  daily: "repeatDaily",
  weekly: "repeatWeekly",
  monthly: "repeatMonthly",
  yearly: "repeatYearly",
} as const satisfies Record<RepeatChoice, string>;

const errorKey = {
  interval: "repeatErrorInterval",
  weekdays: "repeatErrorWeekdays",
  endsOn: "repeatErrorEndsOn",
  count: "repeatErrorCount",
} as const satisfies Record<RepeatError, string>;

export interface RepeatFieldsProps {
  readonly value: RepeatDraft;
  readonly onChange: (value: RepeatDraft) => void;
  /** The first date, for the summary and the weekday chosen first; null until there is one. */
  readonly startsOn: string | null;
  readonly errors: Partial<Record<RepeatError, string | undefined>>;
  readonly dateFormat: DateFormat;
  /** Offers "Does not repeat" (creating); a series' schedule always repeats. */
  readonly allowNone: boolean;
}

/**
 * The repeat inputs with a plain-language summary and the next three dates, so the person sees
 * what the schedule means before saving. Everything is a native, labelled control.
 */
export function RepeatFields({
  value,
  onChange,
  startsOn,
  errors,
  dateFormat,
  allowNone,
}: RepeatFieldsProps) {
  const t = useTranslations("Tasks");
  const text = useRecurrenceText(dateFormat);
  const summaryId = useId();
  const message = (error: string | undefined) =>
    error && error in errorKey ? t(errorKey[error as RepeatError]) : undefined;
  const set = (patch: Partial<RepeatDraft>) => {
    onChange({ ...value, ...patch });
  };
  const rule = draftRule(value, startsOn);
  const next = rule ? upcomingDates(rule, rule.startsOn, 3) : [];
  const choices = allowNone ? repeatChoices : recurrenceFrequencies;

  return (
    <fieldset className="flex flex-col gap-4" data-testid="repeat-fields">
      <legend className="sr-only">{t("repeatLegend")}</legend>
      <SelectField
        label={t("repeatLabel")}
        value={value.frequency}
        onChange={(event) => {
          const frequency = event.target.value as RepeatChoice;
          set({
            frequency,
            // Weekly starts with the first date's weekday, so a valid schedule is one step away.
            weekdays:
              frequency === "weekly" && value.weekdays.length === 0 && startsOn
                ? [isoWeekday(startsOn)]
                : value.weekdays,
          });
        }}
        options={choices.map((choice) => ({ value: choice, label: t(frequencyKey[choice]) }))}
        data-testid="repeat-frequency"
      />
      {value.frequency !== "none" ? (
        <>
          <TextField
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            label={t("repeatInterval", { frequency: value.frequency })}
            description={t("repeatIntervalHelp")}
            value={value.interval}
            onChange={(event) => {
              set({ interval: event.target.value });
            }}
            error={message(errors.interval)}
            className="max-w-48"
            data-testid="repeat-interval"
          />
          {value.frequency === "weekly" ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="text-body font-medium text-fg">{t("repeatWeekdays")}</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {weekdayOrder.map((day) => (
                  <Checkbox
                    key={day}
                    label={text.weekdayName(day)}
                    checked={value.weekdays.includes(day)}
                    onChange={(event) => {
                      set({
                        weekdays: event.target.checked
                          ? [...value.weekdays, day]
                          : value.weekdays.filter((other) => other !== day),
                      });
                    }}
                  />
                ))}
              </div>
              {message(errors.weekdays) ? (
                <p className="text-helper text-danger" role="alert">
                  {message(errors.weekdays)}
                </p>
              ) : null}
            </fieldset>
          ) : null}
          <fieldset className="flex flex-col gap-1">
            <legend className="text-body font-medium text-fg">{t("repeatEnds")}</legend>
            <RadioOption
              name={`${summaryId}-ends`}
              value="never"
              label={t("repeatEndsNever")}
              checked={value.ends === "never"}
              onChange={() => {
                set({ ends: "never" });
              }}
            />
            <RadioOption
              name={`${summaryId}-ends`}
              value="on"
              label={t("repeatEndsOn")}
              checked={value.ends === "on"}
              onChange={() => {
                set({ ends: "on" });
              }}
            />
            {value.ends === "on" ? (
              <TextField
                type="date"
                label={t("repeatEndDate")}
                value={value.endsOn}
                onChange={(event) => {
                  set({ endsOn: event.target.value });
                }}
                error={message(errors.endsOn)}
                className="ms-8 max-w-60"
                data-testid="repeat-ends-on"
              />
            ) : null}
            <RadioOption
              name={`${summaryId}-ends`}
              value="after"
              label={t("repeatEndsAfter")}
              checked={value.ends === "after"}
              onChange={() => {
                set({ ends: "after" });
              }}
            />
            {value.ends === "after" ? (
              <TextField
                type="number"
                inputMode="numeric"
                min={1}
                max={999}
                label={t("repeatCount")}
                value={value.count}
                onChange={(event) => {
                  set({ count: event.target.value });
                }}
                error={message(errors.count)}
                className="ms-8 max-w-48"
                data-testid="repeat-count"
              />
            ) : null}
          </fieldset>
          <div
            id={summaryId}
            className="rounded-card border border-line bg-surface-sunken p-3 text-body"
            aria-live="polite"
            data-testid="repeat-summary"
          >
            {rule ? (
              <>
                <p className="font-medium text-fg">{text.rule(rule)}</p>
                <p className="text-fg-muted">
                  {t("repeatNextDates", { dates: text.list(next.map(text.date)) })}
                </p>
              </>
            ) : (
              <p className="text-fg-muted">
                {startsOn ? t("repeatSummaryIncomplete") : t("repeatNeedsDate")}
              </p>
            )}
          </div>
        </>
      ) : null}
    </fieldset>
  );
}
