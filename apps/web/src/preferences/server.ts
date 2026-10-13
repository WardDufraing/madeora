import "server-only";

import { cookies } from "next/headers";

import { parseSidebar, parseTheme, SIDEBAR_COOKIE, THEME_COOKIE } from "./preferences";

/** The theme and sidebar preferences saved on this device, validated. */
export async function getDevicePreferences() {
  const store = await cookies();
  return {
    theme: parseTheme(store.get(THEME_COOKIE)?.value),
    sidebar: parseSidebar(store.get(SIDEBAR_COOKIE)?.value),
  };
}
