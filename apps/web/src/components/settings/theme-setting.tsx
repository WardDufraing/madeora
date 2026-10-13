"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { saveTheme } from "@/preferences/client";
import { themePreferences, type ThemePreference } from "@/preferences/preferences";

import { RadioOption } from "./radio-option";

export interface ThemeSettingProps {
  readonly initialTheme: ThemePreference;
}

const labelKey = {
  light: "themeLight",
  dark: "themeDark",
  system: "themeSystem",
} as const satisfies Record<ThemePreference, string>;

/** Light, dark or the device's setting. Applies at once and is remembered on this device. */
export function ThemeSetting({ initialTheme }: ThemeSettingProps) {
  const t = useTranslations("Settings");
  const router = useRouter();
  const [theme, setTheme] = useState(initialTheme);
  const [, startTransition] = useTransition();
  const hintId = useId();

  return (
    <fieldset aria-describedby={hintId} className="flex flex-col gap-1">
      <legend className="mb-1 text-body font-semibold text-fg">{t("theme")}</legend>
      {themePreferences.map((option) => (
        <RadioOption
          key={option}
          name="theme"
          value={option}
          label={t(labelKey[option])}
          checked={theme === option}
          onChange={() => {
            setTheme(option);
            saveTheme(option);
            // Refresh the server-rendered data too, so Back and Forward never show a page
            // rendered with the previous theme.
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
