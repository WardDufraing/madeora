/**
 * The interface languages Madeora supports (architecture.md §18: start with Dutch and English).
 * English is the source language: every message is written in English first, and it is the
 * fallback when nothing else matches.
 */
export const locales = ["en", "nl"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

/** Each language's own name, for the language switch (shown in that language, not translated). */
export const localeNames: Readonly<Record<Locale, string>> = {
  en: "English",
  nl: "Nederlands",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

// Languages written right to left. None is supported yet, but the layout must already work for
// them (spec: handle right-to-left supported languages), so direction comes from this list and
// never from a hard-coded "ltr".
const rightToLeft = new Set(["ar", "ckb", "dv", "fa", "he", "ks", "ps", "sd", "ug", "ur", "yi"]);

/** Text direction for a language tag such as `nl` or `ar-EG`. */
export function localeDirection(tag: string): "ltr" | "rtl" {
  const language = tag.toLowerCase().split("-")[0] ?? "";
  return rightToLeft.has(language) ? "rtl" : "ltr";
}
