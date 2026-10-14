import { negotiateLocale, resolveLocale } from "./resolve-locale";

describe("negotiateLocale", () => {
  it.each([
    ["nl", "nl"],
    ["en-GB,en;q=0.9", "en"],
    ["nl-BE,nl;q=0.9,en;q=0.8", "nl"],
    ["NL-be", "nl"],
    ["fr-FR,fr;q=0.9,nl;q=0.5,en;q=0.4", "nl"],
    ["en;q=0.4,nl;q=0.6", "nl"],
    ["de, en;q=0.2, nl;q=0.2", "en"],
  ])("picks the best supported language from %j", (header, expected) => {
    expect(negotiateLocale(header)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["*"],
    ["fr, de;q=0.5"],
    ["nl;q=0, en;q=0"],
    ["<script>, ../../etc"],
    [`${"x".repeat(2000)},nl`],
  ])("returns nothing usable for %j", (header) => {
    expect(negotiateLocale(header)).toBeUndefined();
  });

  it("treats an unreadable q-value as the default quality", () => {
    expect(negotiateLocale("nl;q=abc, en;q=0.5")).toBe("nl");
  });
});

describe("resolveLocale", () => {
  it("prefers the account's language over this device's and the browser's", () => {
    expect(resolveLocale({ account: "nl", saved: "en", acceptLanguage: "en" })).toBe("nl");
    expect(resolveLocale({ account: "en", saved: "nl", acceptLanguage: "nl" })).toBe("en");
  });

  it.each([null, undefined, "fr", "NL"])(
    "uses this device's language when the account has none or an invalid one (%j)",
    (account) => {
      expect(resolveLocale({ account, saved: "nl", acceptLanguage: "en" })).toBe("nl");
    },
  );

  it("prefers the language saved on this device", () => {
    expect(resolveLocale({ saved: "nl", acceptLanguage: "en" })).toBe("nl");
  });

  it("falls back to the browser's languages, then English", () => {
    expect(resolveLocale({ saved: undefined, acceptLanguage: "nl-NL" })).toBe("nl");
    expect(resolveLocale({ saved: undefined, acceptLanguage: "fr" })).toBe("en");
    expect(resolveLocale({ saved: undefined, acceptLanguage: null })).toBe("en");
  });

  it.each(["fr", "NL", "", "nl;", "en-US", "__proto__"])(
    "ignores the invalid saved value %j",
    (saved) => {
      expect(resolveLocale({ saved, acceptLanguage: "nl" })).toBe("nl");
    },
  );
});
