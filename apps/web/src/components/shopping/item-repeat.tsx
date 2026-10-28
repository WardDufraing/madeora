"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import {
  isValidSchedule,
  nextDueDays,
  shoppingFrequencies,
  type IsoWeekday,
  type ShoppingSchedule,
} from "@madeora/domain/shopping";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { TextField } from "@/components/ui/text-field";
import type { DateTimeFormats } from "@/invitations/format";
import {
  sendShoppingRequest,
  shoppingItemEndpoint,
  shoppingRecurrenceEndpoint,
  type ShoppingItem,
  type ShoppingListDetail,
  type ShoppingRecurrence,
} from "@/shopping/api";
import { formatTaskDate } from "@/tasks/format";

import { useFieldMessage } from "./field-message";
import { useShoppingFailure } from "./use-shopping-texts";
import { useShoppingMutation } from "./use-shopping-mutation";

const weekdays = [1, 2, 3, 4, 5, 6, 7] as const satisfies readonly IsoWeekday[];

function isWeekday(value: number): value is IsoWeekday {
  return (weekdays as readonly number[]).includes(value);
}

const scheduleForm = z
  .strictObject({
    frequency: z.enum(shoppingFrequencies),
    // Several checkboxes under one name: the checked values, or false when none is.
    weekdays: z.union([z.array(z.string()), z.literal(false)]),
    monthDay: z.string(),
    startOn: z.string(),
  })
  .transform((values, context): ShoppingSchedule => {
    const days = (values.weekdays || []).map(Number).filter(isWeekday);
    const monthDay = Number(values.monthDay);
    if (values.frequency === "weekly" && days.length === 0) {
      context.addIssue({ code: "custom", message: "weekdaysRequired", path: ["weekdays"] });
      return z.NEVER;
    }
    if (
      values.frequency === "monthly" &&
      !(Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 31)
    ) {
      context.addIssue({ code: "custom", message: "invalid", path: ["monthDay"] });
      return z.NEVER;
    }
    if (values.startOn !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(values.startOn)) {
      context.addIssue({ code: "custom", message: "invalid", path: ["startOn"] });
      return z.NEVER;
    }
    return {
      frequency: values.frequency,
      weekdays: values.frequency === "weekly" ? [...new Set(days)].sort((a, b) => a - b) : null,
      monthDay: values.frequency === "monthly" ? monthDay : null,
      startOn: values.startOn === "" ? null : values.startOn,
    };
  });
type ScheduleInput = z.input<typeof scheduleForm>;

/** Localized weekday names, Monday first (1 Monday … 7 Sunday). */
function useWeekdayNames(): (day: IsoWeekday) => string {
  const locale = useLocale();
  const format = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
  // 2024-01-01 was a Monday.
  return (day) => format.format(new Date(Date.UTC(2024, 0, day)));
}

/** "Repeats every week on Monday and Thursday", in the viewer's language. */
function useScheduleText(): (schedule: ShoppingSchedule) => string {
  const t = useTranslations("Shopping");
  const locale = useLocale();
  const weekday = useWeekdayNames();
  return (schedule) => {
    if (schedule.frequency === "daily") return t("repeatsDaily");
    if (schedule.frequency === "monthly") {
      return t("repeatsMonthly", { day: schedule.monthDay ?? 1 });
    }
    const list = new Intl.ListFormat(locale, { type: "conjunction" });
    return t("repeatsWeekly", { days: list.format((schedule.weekdays ?? []).map(weekday)) });
  };
}

/**
 * Repeat for an item (S26): daily, weekly on chosen weekdays, or monthly on a day (months without
 * it use their last day), with an optional start date and the next three dates. The rule keeps
 * the item's details; at most one of its items is active at a time, and missed days give one item,
 * never a backlog. Change (from the next occurrence), Pause, Resume (from today) and Stop.
 */
export function ItemRepeat({
  item,
  list,
  formats,
  today,
}: {
  readonly item: ShoppingItem;
  readonly list: ShoppingListDetail;
  readonly formats: DateTimeFormats;
  readonly today: string;
}) {
  const t = useTranslations("Shopping");
  const failure = useShoppingFailure();
  const describe = useScheduleText();
  const rule = list.recurrences.find((candidate) => candidate.id === item.recurrenceId) ?? null;
  const [editing, setEditing] = useState(false);
  const [ruleId] = useState(() => crypto.randomUUID());

  const start = useShoppingMutation(
    `shopping-item:${item.id}`,
    (schedule: ShoppingSchedule) =>
      sendShoppingRequest<object>("POST", shoppingItemEndpoint(item.id, "recurrence"), {
        id: ruleId,
        schedule,
      }),
    () => {
      setEditing(false);
    },
  );
  const change = useShoppingMutation(
    `shopping-rule:${rule?.id ?? "none"}`,
    (body: object) =>
      sendShoppingRequest<object>("PATCH", shoppingRecurrenceEndpoint(rule?.id ?? ""), {
        revision: rule?.revision ?? 1,
        ...body,
      }),
    () => {
      setEditing(false);
    },
  );
  const error = start.error ?? change.error;

  return (
    <section
      aria-labelledby={`repeat-${item.id}`}
      className="flex flex-col gap-3 border-t border-line pt-4"
      data-testid="shopping-repeat"
    >
      <h3 id={`repeat-${item.id}`} className="text-body font-semibold text-fg">
        {t("repeatHeading")}
      </h3>
      {rule ? (
        <RuleSummary rule={rule} describe={describe} formats={formats} />
      ) : (
        <p className="text-helper text-fg-muted">{t("repeatNone")}</p>
      )}
      {editing ? (
        <ScheduleForm
          initial={rule}
          today={today}
          formats={formats}
          busy={start.busy || change.busy}
          onCancel={() => {
            setEditing(false);
          }}
          onSave={(schedule) => {
            if (rule) change.mutate({ action: "schedule", schedule, fromItemId: item.id });
            else start.mutate(schedule);
          }}
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {rule ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  change.reset();
                  setEditing(true);
                }}
              >
                {t("repeatChange")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={change.busy}
                onClick={() => {
                  change.mutate({ action: rule.paused ? "resume" : "pause" });
                }}
                data-testid="shopping-repeat-pause"
              >
                {rule.paused ? t("repeatResume") : t("repeatPause")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={change.busy}
                onClick={() => {
                  change.mutate({ action: "stop" });
                }}
                data-testid="shopping-repeat-stop"
              >
                {t("repeatStop")}
              </Button>
            </>
          ) : item.completedAt === null && !list.archived ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                start.reset();
                setEditing(true);
              }}
              data-testid="shopping-repeat-start"
            >
              {t("repeatStart")}
            </Button>
          ) : null}
        </div>
      )}
      {error ? (
        <FormAlert tone="error" announce>
          {error.failure === "conflict" ? t("ruleChangedMeanwhile") : failure(error.failure)}
        </FormAlert>
      ) : null}
    </section>
  );
}

function RuleSummary({
  rule,
  describe,
  formats,
}: {
  readonly rule: ShoppingRecurrence;
  readonly describe: (schedule: ShoppingSchedule) => string;
  readonly formats: DateTimeFormats;
}) {
  const t = useTranslations("Shopping");
  return (
    <div className="flex flex-col gap-1 text-body text-fg" data-testid="shopping-rule">
      <p>{describe(rule)}</p>
      <p className="text-helper text-fg-muted">
        {rule.paused
          ? t("repeatPaused")
          : t("repeatNext", { date: formatTaskDate(rule.nextOn, formats) })}
      </p>
      <p className="text-helper text-fg-muted">{t("repeatAppliesNext")}</p>
      {rule.categoryLost ? <FormAlert tone="info">{t("repeatCategoryLost")}</FormAlert> : null}
      {rule.stalled === "list_full" ? (
        <FormAlert tone="info">{t("repeatListFull")}</FormAlert>
      ) : null}
    </div>
  );
}

function ScheduleForm({
  initial,
  today,
  formats,
  busy,
  onCancel,
  onSave,
}: {
  readonly initial: ShoppingRecurrence | null;
  readonly today: string;
  readonly formats: DateTimeFormats;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (schedule: ShoppingSchedule) => void;
}) {
  const t = useTranslations("Shopping");
  const message = useFieldMessage();
  const weekday = useWeekdayNames();
  const form = useForm<ScheduleInput, unknown, ShoppingSchedule>({
    resolver: zodResolver(scheduleForm),
    defaultValues: {
      frequency: initial?.frequency ?? "weekly",
      weekdays: (initial?.weekdays ?? []).map(String),
      monthDay: String(initial?.monthDay ?? 1),
      startOn: initial?.startOn ?? "",
    },
  });
  const values = useWatch({ control: form.control });
  const frequency = values.frequency ?? "weekly";
  const preview = scheduleForm.safeParse(values);
  const dates =
    preview.success && isValidSchedule(preview.data) ? nextDueDays(preview.data, today) : [];
  const errors = form.formState.errors;
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        void form.handleSubmit(onSave)(event);
      }}
      data-testid="shopping-schedule-form"
    >
      <SelectField
        label={t("fieldFrequency")}
        options={shoppingFrequencies.map((value) => ({
          value,
          label: t(`frequency_${value}`),
        }))}
        data-testid="shopping-schedule-frequency"
        {...form.register("frequency")}
      />
      {frequency === "weekly" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-body font-medium text-fg">{t("fieldWeekdays")}</legend>
          <div className="flex flex-wrap gap-3">
            {weekdays.map((day) => (
              <label key={day} className="flex items-center gap-1.5 text-body text-fg">
                <input
                  type="checkbox"
                  value={String(day)}
                  className="size-4 accent-accent"
                  {...form.register("weekdays")}
                />
                {weekday(day)}
              </label>
            ))}
          </div>
          {errors.weekdays?.message ? (
            <p className="text-helper text-danger" role="alert">
              {message(errors.weekdays.message)}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {frequency === "monthly" ? (
        <TextField
          label={t("fieldMonthDay")}
          description={t("fieldMonthDayHint")}
          type="number"
          min={1}
          max={31}
          inputMode="numeric"
          error={message(errors.monthDay?.message)}
          {...form.register("monthDay")}
        />
      ) : null}
      <TextField
        label={t("fieldStartOn")}
        description={t("fieldStartOnHint")}
        type="date"
        error={message(errors.startOn?.message)}
        {...form.register("startOn")}
      />
      {dates.length > 0 ? (
        <p
          className="text-helper text-fg-muted"
          aria-live="polite"
          data-testid="shopping-schedule-preview"
        >
          {t("schedulePreview", {
            dates: dates.map((date) => formatTaskDate(date, formats)).join(", "),
          })}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" size="sm" loading={busy} data-testid="shopping-schedule-save">
          {t("repeatSave")}
        </Button>
      </div>
    </form>
  );
}
