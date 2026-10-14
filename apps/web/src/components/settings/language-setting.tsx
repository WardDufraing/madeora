"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { localeNames, locales, type Locale } from "@/i18n/locales";
import { saveLocale } from "@/preferences/client";

import { RadioOption } from "./radio-option";
import { SaveFailureAlert } from "./save-failure";
import { useSavePreferences } from "./use-save-preferences";

export interface LanguageSettingProps {
  readonly currentLocale: Locale;
}

/**
 * The interface language, saved on the account so it is the same on every device and in every
 * Home (spec, "Confirmed individual interface language across Homes"). It is also remembered on
 * this device, for the sign-in pages. The server renders every message, so after saving, the page
 * data is refreshed; <html lang> and every text follow without a full reload. Content people
 * write is never translated (spec).
 */
export function LanguageSetting({ currentLocale }: LanguageSettingProps) {
  const t = useTranslations("Settings");
  const [selected, setSelected] = useState(currentLocale);
  const { mutation, saving, failure } = useSavePreferences((saved) => {
    if (saved.locale) saveLocale(saved.locale);
  });
  const hintId = useId();

  return (
    <fieldset aria-describedby={hintId} aria-busy={saving} className="flex flex-col gap-1">
      <legend className="mb-1 text-body font-semibold text-fg">{t("language")}</legend>
      {locales.map((locale) => (
        <RadioOption
          key={locale}
          name="language"
          value={locale}
          label={localeNames[locale]}
          labelLang={locale}
          checked={selected === locale}
          onChange={() => {
            setSelected(locale);
            mutation.mutate(
              { locale },
              {
                // Show the language that is really in use again when the save failed.
                onError: () => {
                  setSelected(currentLocale);
                },
              },
            );
          }}
        />
      ))}
      <p id={hintId} className="text-helper text-fg-muted">
        {t("savedOnAccount")}
      </p>
      <SaveFailureAlert failure={failure} />
    </fieldset>
  );
}
