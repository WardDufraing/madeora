"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { FormAlert } from "@/components/auth/form-alert";
import { detectDeviceTimeZone } from "@/components/preferences/device-time-zone";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useHydrated } from "@/components/ui/use-hydrated";
import type { Locale } from "@/i18n/locales";
import { formatTime } from "@/preferences/regional";
import type { StoredPreferences, TimeFormat } from "@/preferences/schema";
import { FALLBACK_TIME_ZONE, normalizeTimeZone } from "@/preferences/timezone";

import { RadioOption } from "./radio-option";
import { SaveFailureAlert } from "./save-failure";
import { useSavePreferences } from "./use-save-preferences";

const formSchema = z.object({
  mode: z.enum(["automatic", "chosen"]),
  zone: z.string().min(1),
});
type FormValues = z.infer<typeof formSchema>;

export interface TimeZoneSettingProps {
  /** The zone chosen on the account, or `null` for Automatic. */
  readonly chosen: string | null;
  /** The zone this device reported last time, as the server read it from the cookie. */
  readonly deviceSaved: string | undefined;
  /** Every zone to offer, sorted. */
  readonly choices: readonly string[];
  readonly locale: Locale;
  readonly timeFormat: TimeFormat;
}

/**
 * The personal timezone (spec, "Confirmed personal timezone detection"): Automatic follows each
 * device's own zone; a chosen zone applies on every device until the person returns to
 * Automatic. Only how times are shown changes; nothing stored is moved.
 */
export function TimeZoneSetting({
  chosen,
  deviceSaved,
  choices,
  locale,
  timeFormat,
}: TimeZoneSettingProps) {
  const t = useTranslations("Settings");
  const hydrated = useHydrated();
  const legendId = useId();
  const [saved, setSaved] = useState(false);
  // The server cannot know this device's zone before the browser has reported it, so the live
  // detection is used only after hydration; both renders start from the saved cookie value.
  const deviceZone = (hydrated ? detectDeviceTimeZone() : null) ?? normalizeTimeZone(deviceSaved);
  const defaults = (zone: string | null): FormValues => ({
    mode: zone ? "chosen" : "automatic",
    zone: zone ?? normalizeTimeZone(deviceSaved) ?? FALLBACK_TIME_ZONE,
  });
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults(chosen),
  });
  const values = useWatch({ control: form.control }) as FormValues;
  const { mutation, saving, failure } = useSavePreferences((preferences: StoredPreferences) => {
    form.reset(defaults(preferences.timeZone));
    setSaved(true);
  });
  const register = (name: keyof FormValues) =>
    form.register(name, {
      onChange: () => {
        setSaved(false);
      },
    });

  const previewZone = values.mode === "chosen" ? values.zone : (deviceZone ?? FALLBACK_TIME_ZONE);

  // This browser may not know a zone chosen on a device with newer timezone data: then the
  // preview shows the zone without the time instead of failing the page.
  const previewText = () => {
    try {
      return t("timeZoneNow", {
        zone: previewZone,
        time: formatTime(new Date(), previewZone, timeFormat, locale),
      });
    } catch {
      return previewZone;
    }
  };
  // Read during render, so React Hook Form tracks whether anything was changed.
  const { isDirty } = form.formState;

  // On a device's first visit the server does not know its zone yet. Once the browser reports
  // it, preselect it in the list, as long as the person has not changed anything.
  useEffect(() => {
    if (!deviceZone || isDirty || form.getValues("mode") === "chosen") return;
    form.setValue("zone", deviceZone, { shouldDirty: false });
  }, [deviceZone, isDirty, form]);

  const onSubmit = form.handleSubmit((submitted) => {
    setSaved(false);
    // Unchanged: send nothing, so a page left open never undoes a choice made on another device.
    if (!isDirty) return;
    mutation.mutate({ timeZone: submitted.mode === "chosen" ? submitted.zone : null });
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
          {t("timeZone")}
        </legend>
        <RadioOption
          value="automatic"
          label={t("timeZoneAutomatic")}
          description={
            deviceZone
              ? t("timeZoneDetected", { zone: deviceZone })
              : t("timeZoneNotDetected", { zone: FALLBACK_TIME_ZONE })
          }
          {...register("mode")}
        />
        <RadioOption value="chosen" label={t("timeZoneChosen")} {...register("mode")} />
      </fieldset>

      {values.mode === "chosen" ? (
        <SelectField
          label={t("timeZoneSelect")}
          options={choices.map((zone) => ({ value: zone, label: zone.replaceAll("_", " ") }))}
          {...register("zone")}
        />
      ) : null}

      <p className="text-body text-fg" data-preview="time-zone">
        {hydrated ? previewText() : null}
      </p>

      <SaveFailureAlert failure={failure} />
      {saved && !mutation.isPending ? (
        <FormAlert tone="success" announce>
          {t("timeZoneSaved")}
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
