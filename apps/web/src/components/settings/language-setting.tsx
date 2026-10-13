"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { localeNames, locales, type Locale } from "@/i18n/locales";
import { saveLocale } from "@/preferences/client";

import { RadioOption } from "./radio-option";

export interface LanguageSettingProps {
  readonly currentLocale: Locale;
}

/**
 * The interface language. The server renders every message, so after saving the choice the page
 * data is refreshed; <html lang> and every text follow without a full reload. Content people
 * write is never translated (spec).
 */
export function LanguageSetting({ currentLocale }: LanguageSettingProps) {
  const t = useTranslations("Settings");
  const router = useRouter();
  const [selected, setSelected] = useState(currentLocale);
  const [pending, startTransition] = useTransition();
  const hintId = useId();

  return (
    <fieldset aria-describedby={hintId} aria-busy={pending} className="flex flex-col gap-1">
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
            saveLocale(locale);
            startTransition(() => {
              router.refresh();
            });
          }}
        />
      ))}
      <p id={hintId} className="text-helper text-fg-muted">
        {t("savedOnDevice")}
      </p>
    </fieldset>
  );
}
