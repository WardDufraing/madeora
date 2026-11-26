/**
 * Presentation preferences kept on this device in first-party cookies, so the server can render
 * the chosen theme, language and sidebar width on the first paint (no flash of the wrong theme
 * and no hydration mismatch). They hold no identity or personal data and are never used for
 * access decisions. The browser writes them, so they are not HttpOnly. Once accounts exist (S07),
 * the account's saved language takes precedence and these remain the device fallback.
 */

export const THEME_COOKIE = "md-theme";
export const SIDEBAR_COOKIE = "md-sidebar";
export const LOCALE_COOKIE = "md-locale";
export const FAVORITES_COOKIE = "md-favorites";

export const themePreferences = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof themePreferences)[number];

export const sidebarStates = ["expanded", "collapsed"] as const;
export type SidebarState = (typeof sidebarStates)[number];

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** A saved theme, or "system" (follow the device) when missing or invalid. */
export function parseTheme(value: unknown): ThemePreference {
  return oneOf(themePreferences, value, "system");
}

/** A saved sidebar state, or "collapsed" (the slim icon rail) when missing or invalid. */
export function parseSidebar(value: unknown): SidebarState {
  return oneOf(sidebarStates, value, "collapsed");
}

/** The `data-theme` value for `<html>`: none for "system", so CSS follows the device setting. */
export function themeAttribute(theme: ThemePreference): "light" | "dark" | undefined {
  return theme === "system" ? undefined : theme;
}

/** A `Set-Cookie`-style string for `document.cookie`. Values are allow-listed by the callers. */
export function preferenceCookie(name: string, value: string, secure: boolean): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${String(ONE_YEAR_SECONDS)}`,
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** The most module shortcuts a person can pin. */
export const MAX_FAVORITES = 8;

/** The cookie value for "pinned nothing", so it differs from "never chose" (the context defaults). */
const NO_FAVORITES = "-";

/**
 * Pinned module ids from the cookie, or `null` when the person never chose (the context's default
 * shortcuts apply). Only lower-case words are kept; the caller still checks them against the
 * modules that can be pinned, so a hand-edited cookie cannot add anything.
 */
export function parseFavorites(value: unknown): readonly string[] | null {
  if (typeof value !== "string" || value === "") return null;
  if (value === NO_FAVORITES) return [];
  const ids = value.split(",").filter((id) => /^[a-z]{2,24}$/.test(id));
  return [...new Set(ids)].slice(0, MAX_FAVORITES);
}

/** The cookie value for a list of pinned module ids. */
export function serializeFavorites(ids: readonly string[]): string {
  return ids.length === 0 ? NO_FAVORITES : ids.slice(0, MAX_FAVORITES).join(",");
}
