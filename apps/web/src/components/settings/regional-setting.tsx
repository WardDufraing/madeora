"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  regionalPreview,
  resolveRegionalFormats,
  type RegionalSamples,
} from "@/preferences/regional";
import {
  dateFormats,
  measurementSystems,
  numberFormats,
  regionalSettings,
  timeFormats,
  weekStarts,
  type PreferencesPatchInput,
  type RegionalFormats,
  type RegionalOverrides,
  type StoredPreferences,
} from "@/preferences/schema";

import { RadioOption } from "./radio-option";
import { SaveFailureAlert } from "./save-failure";
import { useSavePreferences } from "./use-save-preferences";

const AUTO = "auto";
const choice = <T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.literal(AUTO), z.enum(values)]);

const formSchema = z.object({
  mode: z.enum(["automatic", "custom"]),
  dateFormat: choice(dateFormats),
  timeFormat: choice(timeFormats),
  weekStart: choice(weekStarts),
  numberFormat: choice(numberFormats),
  measurementSystem: choice(measurementSystems),
});
type FormValues = z.infer<typeof formSchema>;

function toFormValues(overrides: RegionalOverrides): FormValues {
  return {
    mode: regionalSettings.some((setting) => overrides[setting] !== null) ? "custom" : "automatic",
    dateFormat: overrides.dateFormat ?? AUTO,
    timeFormat: overrides.timeFormat ?? AUTO,
    weekStart: overrides.weekStart ?? AUTO,
    numberFormat: overrides.numberFormat ?? AUTO,
    measurementSystem: overrides.measurementSystem ?? AUTO,
  };
}

/** Automatic clears every override; Custom keeps each select's choice (or its Automatic). */
function toOverrides(values: FormValues): RegionalOverrides {
  const custom = values.mode === "custom";
  const pick = <T extends string>(value: T | typeof AUTO): T | null =>
    custom && value !== AUTO ? value : null;
  return {
    dateFormat: pick(values.dateFormat),
    timeFormat: pick(values.timeFormat),
    weekStart: pick(values.weekStart),
    numberFormat: pick(values.numberFormat),
    measurementSystem: pick(values.measurementSystem),
  };
}

/**
 * The change to send. Switching to Automatic is an explicit reset of every format. Otherwise only
 * the settings changed in this form are sent, so a page left open on one device never undoes a
 * choice made on another device in the meantime (spec: never silently reset custom choices).
 */
function regionalChange(
  values: FormValues,
  changed: Partial<Record<keyof FormValues, boolean>>,
): PreferencesPatchInput {
  const overrides = toOverrides(values);
  if (values.mode === "automatic") return changed.mode ? overrides : {};
  const patch: { -readonly [K in keyof RegionalOverrides]?: RegionalOverrides[K] } = {};
  for (const setting of regionalSettings) {
    if (changed[setting]) Object.assign(patch, { [setting]: overrides[setting] });
  }
  return patch;
}

export interface RegionalSettingProps {
  readonly overrides: RegionalOverrides;
  /** What Automatic means right now, from the browser's language preferences. */
  readonly detected: RegionalFormats;
  /** Every example text, made on the server (see `regionalSamples`). */
  readonly samples: RegionalSamples;
}

/**
 * Regional formats (spec, "Confirmed automatic regional defaults with independent overrides"):
 * Automatic or Custom, each setting separately, with a live preview before saving. Formats only
 * change how values are shown, never the values.
 */
export function RegionalSetting({ overrides, detected, samples }: RegionalSettingProps) {
  const t = useTranslations("Settings");
  const hydrated = useHydrated();
  const previewId = useId();
  const legendId = useId();
  const [saved, setSaved] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: toFormValues(overrides),
  });
  const values = useWatch({ control: form.control }) as FormValues;
  // Read during render, so React Hook Form tracks which fields were changed.
  const { dirtyFields } = form.formState;
  const preview = regionalPreview(samples, resolveRegionalFormats(toOverrides(values), detected));
  const { mutation, saving, failure } = useSavePreferences((preferences: StoredPreferences) => {
    form.reset(toFormValues(preferences));
    setSaved(true);
  });
  const register = (name: keyof FormValues) =>
    form.register(name, {
      onChange: () => {
        setSaved(false);
      },
    });

  const automatic = (example: string) => ({
    value: AUTO,
    label: t("automaticOption", { example }),
  });
  const timeLabel = (format: RegionalFormats["timeFormat"]) =>
    format === "24h"
      ? t("time24h", { example: samples.time[format] })
      : t("time12h", { example: samples.time[format] });
  const unitsLabel = (system: RegionalFormats["measurementSystem"]) =>
    system === "metric" ? t("unitsMetric") : t("unitsUsCustomary");

  const onSubmit = form.handleSubmit((submitted) => {
    setSaved(false);
    const change = regionalChange(submitted, dirtyFields);
    // Nothing to store (nothing changed, or Custom with every format left on Automatic): send
    // nothing and claim nothing.
    if (Object.keys(change).length === 0) return;
    mutation.mutate(change);
  });

  return (
    <form
      aria-labelledby={legendId}
      method="post"
      noValidate
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="flex flex-col gap-5"
    >
      <fieldset className="flex flex-col gap-1">
        <legend id={legendId} className="mb-1 text-body font-semibold text-fg">
          {t("regionalFormats")}
        </legend>
        <RadioOption
          value="automatic"
          label={t("regionalAutomatic")}
          description={t("regionalAutomaticHint")}
          {...register("mode")}
        />
        <RadioOption
          value="custom"
          label={t("regionalCustom")}
          description={t("regionalCustomHint")}
          {...register("mode")}
        />
      </fieldset>

      {values.mode === "custom" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t("dateFormat")}
            options={[
              automatic(samples.date[detected.dateFormat]),
              ...dateFormats.map((format) => ({ value: format, label: samples.date[format] })),
            ]}
            {...register("dateFormat")}
          />
          <SelectField
            label={t("timeFormat")}
            options={[
              automatic(samples.time[detected.timeFormat]),
              ...timeFormats.map((format) => ({ value: format, label: timeLabel(format) })),
            ]}
            {...register("timeFormat")}
          />
          <SelectField
            label={t("weekStart")}
            options={[
              automatic(samples.firstDay[detected.weekStart]),
              ...weekStarts.map((start) => ({ value: start, label: samples.firstDay[start] })),
            ]}
            {...register("weekStart")}
          />
          <SelectField
            label={t("numberFormat")}
            options={[
              automatic(samples.numberLabel[detected.numberFormat]),
              ...numberFormats.map((format) => ({
                value: format,
                label: samples.numberLabel[format],
              })),
            ]}
            {...register("numberFormat")}
          />
          <SelectField
            label={t("measurementSystem")}
            options={[
              automatic(unitsLabel(detected.measurementSystem)),
              ...measurementSystems.map((system) => ({ value: system, label: unitsLabel(system) })),
            ]}
            {...register("measurementSystem")}
          />
        </div>
      ) : null}

      <section aria-labelledby={previewId} className="rounded-control border border-line p-4">
        <h3 id={previewId} className="mb-2 text-body font-semibold text-fg">
          {t("preview")}
        </h3>
        {/* Announced politely, so a screen-reader user hears the effect of each choice. */}
        <dl aria-live="polite" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
          <dt className="text-fg-muted">{t("dateFormat")}</dt>
          <dd data-preview="date">{preview.date}</dd>
          <dt className="text-fg-muted">{t("timeFormat")}</dt>
          <dd data-preview="time">{preview.time}</dd>
          <dt className="text-fg-muted">{t("weekStart")}</dt>
          <dd data-preview="week">{preview.week}</dd>
          <dt className="text-fg-muted">{t("numberFormat")}</dt>
          <dd data-preview="number">{preview.number}</dd>
          <dt className="text-fg-muted">{t("measurementSystem")}</dt>
          <dd data-preview="units">{preview.units}</dd>
        </dl>
      </section>

      <SaveFailureAlert failure={failure} />
      {saved && !mutation.isPending ? (
        <FormAlert tone="success" announce>
          {t("regionalSaved")}
        </FormAlert>
      ) : null}
      <div>
        <Button type="submit" disabled={!hydrated} loading={saving}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
