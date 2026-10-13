import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";

import { localeDirection } from "@/i18n/locales";
import { themeAttribute } from "@/preferences/preferences";
import { getDevicePreferences } from "@/preferences/server";

import "./globals.css";

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const [locale, { theme }] = await Promise.all([getLocale(), getDevicePreferences()]);

  // Language, direction and theme are set on <html> on the server, so the first paint is right
  // and the client hydrates the same values. "System" leaves data-theme out and CSS follows the
  // device. The theme (and later the accent) belongs on <html> (ADR 0004).
  return (
    <html lang={locale} dir={localeDirection(locale)} data-theme={themeAttribute(theme)}>
      <body className="min-h-dvh antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
