import { defaultLocale, isLocale, locales, type Locale } from "./locales";

// A real Accept-Language header is short; ignore anything absurdly long instead of parsing it.
const MAX_HEADER_LENGTH = 1024;
const MAX_ENTRIES = 32;

/**
 * Picks the best supported locale from an `Accept-Language` header, honouring q-values and
 * matching regional variants to their language (`nl-BE` → `nl`). Returns `undefined` when nothing
 * supported is acceptable.
 */
export function negotiateLocale(header: string | null | undefined): Locale | undefined {
  if (!header || header.length > MAX_HEADER_LENGTH) return undefined;

  const ranges = header
    .split(",")
    .slice(0, MAX_ENTRIES)
    .map((entry, index) => {
      const [tag = "", ...params] = entry.trim().split(";");
      let quality = 1;
      for (const param of params) {
        const match = /^\s*q\s*=\s*([01](?:\.\d{1,3})?)\s*$/i.exec(param);
        if (match) quality = Number(match[1]);
      }
      return { tag: tag.trim().toLowerCase(), quality, index };
    })
    .filter(({ tag, quality }) => quality > 0 && /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/.test(tag))
    // Highest quality first; equal qualities keep the order the browser sent them in.
    .sort((a, b) => b.quality - a.quality || a.index - b.index);

  for (const { tag } of ranges) {
    if (isLocale(tag)) return tag;
    const language = tag.split("-")[0];
    const match = locales.find((locale) => locale === language);
    if (match) return match;
  }
  return undefined;
}

/**
 * The interface language for a request: the language saved on the account (the same on every
 * device and in every Home), else the choice saved on this device, else the browser's preferred
 * languages, else English. Invalid saved values are ignored.
 */
export function resolveLocale(input: {
  readonly account?: string | null | undefined;
  readonly saved: string | undefined;
  readonly acceptLanguage: string | null | undefined;
}): Locale {
  if (isLocale(input.account)) return input.account;
  if (isLocale(input.saved)) return input.saved;
  return negotiateLocale(input.acceptLanguage) ?? defaultLocale;
}
