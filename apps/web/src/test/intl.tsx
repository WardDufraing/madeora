import { render, type RenderResult } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";

import type { Locale } from "@/i18n/locales";
import en from "@/i18n/messages/en.json";
import nl from "@/i18n/messages/nl.json";

export const dictionaries = { en, nl } as const;

/** Renders a component with the real dictionaries, as the app's provider would. */
export function renderWithIntl(ui: ReactElement, locale: Locale = "en"): RenderResult {
  return render(
    <NextIntlClientProvider locale={locale} messages={dictionaries[locale]}>
      {ui}
    </NextIntlClientProvider>,
  );
}
