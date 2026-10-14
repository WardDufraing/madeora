import {
  detectRegionalFormats,
  formatDate,
  formatNumber,
  formatTime,
  formatWeekday,
  isoDate,
  regionalPreview,
  regionalSamples,
  regionalTag,
  resolveRegionalFormats,
  sampleMeasurements,
  weekdayNames,
} from "./regional";
import type { RegionalOverrides } from "./schema";

const automatic: RegionalOverrides = {
  dateFormat: null,
  timeFormat: null,
  weekStart: null,
  numberFormat: null,
  measurementSystem: null,
};

describe("regionalTag", () => {
  it("takes the browser's most preferred language, of any language, with its region", () => {
    expect(regionalTag("nl-BE,nl;q=0.9,en-US;q=0.8", "en")).toBe("nl-BE");
    expect(regionalTag("fr-FR,en;q=0.5", "nl")).toBe("fr-FR");
    expect(regionalTag("en;q=0.5, de-CH", "en")).toBe("de-CH");
    expect(regionalTag("en-gb", "nl")).toBe("en-GB");
  });

  it("skips wildcards, refused and invalid entries", () => {
    expect(regionalTag("*, nl-NL", "en")).toBe("nl-NL");
    expect(regionalTag("fr;q=0, en-GB", "nl")).toBe("en-GB");
    expect(regionalTag("not a tag!, sv-SE", "en")).toBe("sv-SE");
  });

  it("falls back to the interface language without a usable header", () => {
    expect(regionalTag(null, "nl")).toBe("nl");
    expect(regionalTag("", "en")).toBe("en");
    expect(regionalTag("x".repeat(2000), "nl")).toBe("nl");
  });
});

describe("detectRegionalFormats", () => {
  it.each([
    [
      "nl-BE",
      {
        dateFormat: "dmy-slash",
        timeFormat: "24h",
        weekStart: "monday",
        numberFormat: "dot-comma",
        measurementSystem: "metric",
      },
    ],
    [
      "nl-NL",
      {
        dateFormat: "dmy-dash",
        timeFormat: "24h",
        weekStart: "monday",
        numberFormat: "dot-comma",
        measurementSystem: "metric",
      },
    ],
    [
      "nl",
      {
        dateFormat: "dmy-dash",
        timeFormat: "24h",
        weekStart: "monday",
        numberFormat: "dot-comma",
        measurementSystem: "metric",
      },
    ],
    [
      "en-US",
      {
        dateFormat: "mdy-slash",
        timeFormat: "12h",
        weekStart: "sunday",
        numberFormat: "comma-dot",
        measurementSystem: "us-customary",
      },
    ],
    [
      "en",
      {
        dateFormat: "mdy-slash",
        timeFormat: "12h",
        weekStart: "sunday",
        numberFormat: "comma-dot",
        measurementSystem: "us-customary",
      },
    ],
    [
      "en-GB",
      {
        dateFormat: "dmy-slash",
        timeFormat: "24h",
        weekStart: "monday",
        numberFormat: "comma-dot",
        measurementSystem: "metric",
      },
    ],
    [
      "de-DE",
      {
        dateFormat: "dmy-dot",
        timeFormat: "24h",
        weekStart: "monday",
        numberFormat: "dot-comma",
        measurementSystem: "metric",
      },
    ],
    [
      "sv-SE",
      {
        dateFormat: "ymd-dash",
        timeFormat: "24h",
        weekStart: "monday",
        numberFormat: "space-comma",
        measurementSystem: "metric",
      },
    ],
    [
      "fr-FR",
      {
        dateFormat: "dmy-slash",
        timeFormat: "24h",
        weekStart: "monday",
        numberFormat: "space-comma",
        measurementSystem: "metric",
      },
    ],
    [
      "ar-EG",
      {
        dateFormat: "dmy-slash",
        timeFormat: "12h",
        weekStart: "saturday",
        numberFormat: "comma-dot",
        measurementSystem: "metric",
      },
    ],
  ] as const)("%s", (tag, expected) => {
    expect(detectRegionalFormats(tag)).toEqual(expected);
  });

  it("falls back to English conventions for a tag it cannot read", () => {
    expect(detectRegionalFormats("!!")).toEqual(detectRegionalFormats("en"));
  });
});

describe("resolveRegionalFormats", () => {
  const detected = detectRegionalFormats("nl-BE");

  it("uses the detected value for every Automatic setting", () => {
    expect(resolveRegionalFormats(automatic, detected)).toEqual(detected);
  });

  it("overrides each setting independently", () => {
    expect(
      resolveRegionalFormats(
        { ...automatic, timeFormat: "12h", measurementSystem: "us-customary" },
        detected,
      ),
    ).toEqual({ ...detected, timeFormat: "12h", measurementSystem: "us-customary" });
  });
});

describe("formatting", () => {
  // 31 December 2026, 23:30 UTC: already 1 January 2027 in Brussels.
  const lateEvening = new Date(Date.UTC(2026, 11, 31, 23, 30));

  it("shows the calendar date of the given timezone, in the chosen order and separators", () => {
    expect(formatDate(lateEvening, "UTC", "dmy-slash")).toBe("31/12/2026");
    expect(formatDate(lateEvening, "UTC", "dmy-dash")).toBe("31-12-2026");
    expect(formatDate(lateEvening, "UTC", "dmy-dot")).toBe("31.12.2026");
    expect(formatDate(lateEvening, "UTC", "mdy-slash")).toBe("12/31/2026");
    expect(formatDate(lateEvening, "UTC", "ymd-dash")).toBe("2026-12-31");
    expect(formatDate(lateEvening, "Europe/Brussels", "dmy-slash")).toBe("01/01/2027");
    expect(isoDate(lateEvening, "Europe/Brussels")).toBe("2027-01-01");
    expect(isoDate(lateEvening, "America/New_York")).toBe("2026-12-31");
  });

  it("shows the time in 24- or 12-hour form, with day periods in the interface language", () => {
    expect(formatTime(lateEvening, "UTC", "24h", "en")).toBe("23:30");
    expect(formatTime(lateEvening, "Europe/Brussels", "24h", "nl")).toBe("00:30");
    // ICU versions differ in the space before the day period (U+0020 or U+202F).
    expect(formatTime(lateEvening, "UTC", "12h", "en")).toMatch(/^11:30\sPM$/u);
    expect(formatTime(lateEvening, "UTC", "12h", "nl")).toMatch(/^11:30\sp\.m\.$/u);
  });

  it("handles a daylight-saving change without guessing a different instant", () => {
    // 29 March 2026: Brussels jumps from 02:00 to 03:00 at 01:00 UTC.
    expect(formatTime(new Date(Date.UTC(2026, 2, 29, 0, 59)), "Europe/Brussels", "24h", "en")).toBe(
      "01:59",
    );
    expect(formatTime(new Date(Date.UTC(2026, 2, 29, 1, 0)), "Europe/Brussels", "24h", "en")).toBe(
      "03:00",
    );
  });

  it("names the weekday in the interface language and the given timezone", () => {
    expect(formatWeekday(lateEvening, "UTC", "en")).toBe("Thursday");
    expect(formatWeekday(lateEvening, "Europe/Brussels", "nl")).toBe("vrijdag");
  });

  it("applies the chosen separators to numbers and units, with Latin digits", () => {
    expect(formatNumber(1234567.89, "comma-dot", "nl")).toBe("1,234,567.89");
    expect(formatNumber(1234567.89, "dot-comma", "en")).toBe("1.234.567,89");
    expect(formatNumber(1234567.89, "space-comma", "en")).toBe("1\u00a0234\u00a0567,89");
    expect(formatNumber(1234.5, "dot-comma", "nl", { style: "unit", unit: "kilometer" })).toBe(
      "1.234,5 km",
    );
  });

  it("lists the week from the chosen first day", () => {
    expect(weekdayNames("monday", "en")).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(weekdayNames("sunday", "en")[0]).toBe("Sun");
    expect(weekdayNames("saturday", "nl", "long")[0]).toBe("zaterdag");
  });

  it("previews representative measurements in each system", () => {
    expect(sampleMeasurements("metric", "dot-comma", "en")).toEqual({
      distance: "5,5 km",
      temperature: "21°C",
      weight: "1,5 kg",
    });
    expect(sampleMeasurements("us-customary", "comma-dot", "en")).toEqual({
      distance: "3.4 mi",
      temperature: "70°F",
      weight: "3.3 lb",
    });
  });

  it("previews every format together from samples made once, on the server", () => {
    const formats = {
      dateFormat: "dmy-slash",
      timeFormat: "24h",
      weekStart: "monday",
      numberFormat: "dot-comma",
      measurementSystem: "metric",
    } as const;
    const samples = regionalSamples("en");
    expect(regionalPreview(samples, formats)).toEqual({
      date: "31/12/2026",
      time: "14:30",
      week: "Mon Tue Wed Thu Fri Sat Sun",
      number: "1.234.567,89",
      units: "5,5 km · 21°C · 1,5 kg",
    });
    expect(samples.firstDay).toEqual({ monday: "Monday", saturday: "Saturday", sunday: "Sunday" });
    expect(samples.numberLabel["space-comma"]).toBe("1\u00a0234,5");
    expect(regionalSamples("nl").firstDay.monday).toBe("maandag");
  });
});
