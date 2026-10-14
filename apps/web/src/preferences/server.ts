import "server-only";

import { getLocale } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { cache } from "react";

import { getStoredPreferences } from "./account";
import { parseSidebar, parseTheme, SIDEBAR_COOKIE, THEME_COOKIE } from "./preferences";
import { detectRegionalFormats, regionalTag, resolveRegionalFormats } from "./regional";
import type { RegionalFormats } from "./schema";
import { resolveTimeZone, TIMEZONE_COOKIE, type EffectiveTimeZone } from "./timezone";

/** The theme and sidebar preferences saved on this device, validated. */
export async function getDevicePreferences() {
  const store = await cookies();
  return {
    theme: parseTheme(store.get(THEME_COOKIE)?.value),
    sidebar: parseSidebar(store.get(SIDEBAR_COOKIE)?.value),
  };
}

/** The zone this device last reported (cookie written by `DeviceTimeZone`), unvalidated. */
export async function getDeviceTimeZone(): Promise<string | undefined> {
  return (await cookies()).get(TIMEZONE_COOKIE)?.value;
}

/** The timezone for this request: the account's chosen zone, else this device's, else UTC. */
export const getEffectiveTimeZone = cache(async (): Promise<EffectiveTimeZone> => {
  const [stored, device] = await Promise.all([getStoredPreferences(), getDeviceTimeZone()]);
  return resolveTimeZone({ chosen: stored.timeZone, device });
});

export interface RegionalContext {
  /** What Automatic means for this request (from the browser's language preferences). */
  readonly detected: RegionalFormats;
  /** The formats in effect: each custom choice, else the detected value. */
  readonly effective: RegionalFormats;
}

/** Regional formats for this request. Call it from pages, not from the next-intl request config. */
export const getRegionalFormats = cache(async (): Promise<RegionalContext> => {
  const [stored, locale, headerList] = await Promise.all([
    getStoredPreferences(),
    getLocale(),
    headers(),
  ]);
  const detected = detectRegionalFormats(regionalTag(headerList.get("accept-language"), locale));
  return { detected, effective: resolveRegionalFormats(stored, detected) };
});
