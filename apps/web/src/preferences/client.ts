import {
  LOCALE_COOKIE,
  preferenceCookie,
  SIDEBAR_COOKIE,
  THEME_COOKIE,
  themeAttribute,
  type SidebarState,
  type ThemePreference,
} from "./preferences";
import type { Locale } from "@/i18n/locales";

// Browser-only helpers. Each takes an already-typed value, so only allow-listed values are written.

function write(name: string, value: string): void {
  document.cookie = preferenceCookie(name, value, window.location.protocol === "https:");
}

/** Saves the theme and applies it to `<html>` at once, without a reload. */
export function saveTheme(theme: ThemePreference): void {
  write(THEME_COOKIE, theme);
  const attribute = themeAttribute(theme);
  if (attribute) document.documentElement.dataset.theme = attribute;
  else delete document.documentElement.dataset.theme;
}

export function saveSidebar(state: SidebarState): void {
  write(SIDEBAR_COOKIE, state);
}

/** Saves the language; the caller refreshes the page data so the server renders it. */
export function saveLocale(locale: Locale): void {
  write(LOCALE_COOKIE, locale);
}
