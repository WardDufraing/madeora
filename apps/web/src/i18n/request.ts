import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

import { LOCALE_COOKIE } from "@/preferences/preferences";

import type { Locale } from "./locales";
import { resolveLocale } from "./resolve-locale";

const dictionaries = {
  en: () => import("./messages/en.json"),
  nl: () => import("./messages/nl.json"),
} satisfies Record<Locale, () => Promise<unknown>>;

// next-intl calls this once per request on the server. The locale is resolved here, never from
// the URL, because the interface language is a personal preference (spec, "Confirmed individual
// interface language across Homes"). Responses depend on the request's cookies and headers, so
// Next.js renders them per request and never shares them between people.
export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale({
    saved: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerList.get("accept-language"),
  });
  const messages = (await dictionaries[locale]()).default;
  return { locale, messages };
});
