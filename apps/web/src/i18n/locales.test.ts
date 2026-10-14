import { defaultLocale, isLocale, localeDirection, localeNames, locales } from "./locales";

describe("locales", () => {
  it("supports Dutch and English, with English as the source and fallback", () => {
    expect([...locales].sort()).toEqual(["en", "nl"]);
    expect(defaultLocale).toBe("en");
    expect(localeNames).toEqual({ en: "English", nl: "Nederlands" });
  });

  it("recognises only supported locale codes", () => {
    expect(isLocale("nl")).toBe(true);
    expect(isLocale("NL")).toBe(false);
    expect(isLocale("toString")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it("gives every supported language a direction, and right-to-left for those that need it", () => {
    for (const locale of locales) expect(localeDirection(locale)).toBe("ltr");
    expect(localeDirection("ar")).toBe("rtl");
    expect(localeDirection("he-IL")).toBe("rtl");
    expect(localeDirection("fa")).toBe("rtl");
    expect(localeDirection("de")).toBe("ltr");
  });
});
