import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";

import { getStoredPreferences } from "@/preferences/account";
import { LOCALE_COOKIE } from "@/preferences/preferences";
import { getEffectiveTimeZone } from "@/preferences/server";

import type { Locale } from "./locales";
import { resolveLocale } from "./resolve-locale";

const dictionaries = {
  en: () => import("./messages/en.json"),
  nl: () => import("./messages/nl.json"),
} satisfies Record<Locale, () => Promise<unknown>>;

// next-intl calls this once per request on the server. The locale is resolved here, never from
// the URL, because the interface language is a personal preference (spec, "Confirmed individual
// interface language across Homes"): the account's language when signed in, else this device's.
// Responses depend on the request's cookies, session and headers, so Next.js renders them per
// request and never shares them between people.
export default getRequestConfig(async () => {
  const [cookieStore, headerList, stored, { timeZone }] = await Promise.all([
    cookies(),
    headers(),
    getStoredPreferences(),
    getEffectiveTimeZone(),
  ]);
  const locale = resolveLocale({
    account: stored.locale,
    saved: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerList.get("accept-language"),
  });
  const messages = (await dictionaries[locale]()).default;
  return { locale, messages, timeZone };
});
