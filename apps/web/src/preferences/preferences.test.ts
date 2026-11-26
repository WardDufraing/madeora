import {
  MAX_FAVORITES,
  parseFavorites,
  parseSidebar,
  serializeFavorites,
  parseTheme,
  preferenceCookie,
  themeAttribute,
  THEME_COOKIE,
} from "./preferences";

describe("device preferences", () => {
  it("accepts only known theme values and otherwise follows the device", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBe("system");
    for (const junk of [undefined, "", "Dark", "blue", "light;", "__proto__", 1]) {
      expect(parseTheme(junk)).toBe("system");
    }
  });

  it("accepts only known sidebar states and otherwise uses the slim rail", () => {
    expect(parseSidebar("collapsed")).toBe("collapsed");
    expect(parseSidebar("expanded")).toBe("expanded");
    for (const junk of [undefined, "", "closed", "COLLAPSED"]) {
      expect(parseSidebar(junk)).toBe("collapsed");
    }
  });

  it("sets data-theme only for an explicit light or dark choice", () => {
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
    expect(themeAttribute("system")).toBeUndefined();
  });

  it("writes a first-party cookie for a year, Lax, and Secure on https", () => {
    expect(preferenceCookie(THEME_COOKIE, "dark", false)).toBe(
      "md-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax",
    );
    expect(preferenceCookie(THEME_COOKIE, "dark", true)).toBe(
      "md-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    expect(preferenceCookie(THEME_COOKIE, "a;b=c", false)).toContain("md-theme=a%3Bb%3Dc;");
  });
});

describe("module shortcuts cookie", () => {
  it("tells never chose (null) from pinned nothing ([])", () => {
    expect(parseFavorites(undefined)).toBeNull();
    expect(parseFavorites("")).toBeNull();
    expect(parseFavorites(serializeFavorites([]))).toEqual([]);
  });

  it("round-trips ids, drops junk and duplicates, and caps the count", () => {
    expect(parseFavorites(serializeFavorites(["pets", "chores"]))).toEqual(["pets", "chores"]);
    expect(parseFavorites("pets,Pets,../x,pets,a,chores;x")).toEqual(["pets"]);
    const many = Array.from({ length: 20 }, (_, i) => `mod${"abcdefghijklmnopqrst"[i] ?? "z"}`);
    expect(parseFavorites(many.join(","))).toHaveLength(MAX_FAVORITES);
  });
});
