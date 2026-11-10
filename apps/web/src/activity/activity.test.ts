import { createTranslator } from "next-intl";

import en from "@/i18n/messages/en.json";
import nl from "@/i18n/messages/nl.json";

import { ALL_ACTIVITY_KINDS, isActivityKind, kindKey } from "./catalogue";
import {
  activityQuery,
  hasActivityFilters,
  matchingKinds,
  newestPageHref,
  normalizeForSearch,
  olderPageHref,
  parseActivityCursor,
  parseActivityFilters,
} from "./filters";
import {
  buildCsv,
  buildJson,
  csvCell,
  reportFileName,
  zonedTimestamp,
  type ReportLabels,
} from "./report";
import { securityReportRequestSchema } from "./schema";

const HOME = "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001";
const ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";

describe("activity catalogue", () => {
  it.each([
    ["en", en],
    ["nl", nl],
  ] as const)("names every event code in %s", (locale, messages) => {
    const t = createTranslator({ locale, messages, namespace: "Activity" });
    for (const kind of ALL_ACTIVITY_KINDS) {
      expect(t(kindKey(kind))).not.toMatch(/^Activity\./);
    }
  });

  it("maps dotted codes to message keys", () => {
    expect(kindKey("home_membership.joined")).toBe("kind_home_membership_joined");
    expect(isActivityKind("signed_in")).toBe(true);
    expect(isActivityKind("reauthenticated")).toBe(false);
  });
});

describe("activity filters", () => {
  it("keeps only valid values", () => {
    expect(
      parseActivityFilters({
        category: "security",
        outcome: "blocked",
        from: "2026-10-01",
        to: "not-a-date",
        home: HOME,
        q: "  password  ",
      }),
    ).toEqual({
      category: "security",
      outcome: "blocked",
      from: "2026-10-01",
      to: "",
      home: HOME,
      q: "password",
    });
    expect(
      parseActivityFilters({ category: "staff", outcome: ["x"], home: "1", q: "x".repeat(300) }),
    ).toMatchObject({ category: "", outcome: "", home: "", q: "x".repeat(100) });
    expect(hasActivityFilters(parseActivityFilters({}))).toBe(false);
  });

  it("reads a cursor only when both halves are valid", () => {
    expect(
      parseActivityCursor({ before: "2026-11-07T09:52:44.123456+00:00", beforeId: ID }),
    ).toEqual({ createdAt: "2026-11-07T09:52:44.123456+00:00", id: ID });
    expect(parseActivityCursor({ before: "2026-11-07T09:52:44+00:00" })).toBeNull();
    expect(parseActivityCursor({ before: "yesterday", beforeId: ID })).toBeNull();
  });

  it("searches translated labels without case or accents", () => {
    expect(normalizeForSearch("Réglé")).toBe("regle");
    const labelOf = (kind: string) => (kind === "password_changed" ? "Wachtwoord gewijzigd" : kind);
    expect(matchingKinds("WACHTWOORD", labelOf)).toEqual(["password_changed"]);
    expect(matchingKinds("   ", labelOf)).toEqual([]);
  });

  it("turns calendar days in the viewer's zone into an instant range", () => {
    const filters = parseActivityFilters({
      from: "2026-10-25",
      to: "2026-10-25",
      home: HOME,
      q: "maple",
    });
    const args = activityQuery({
      filters,
      cursor: null,
      timeZone: "Europe/Brussels",
      labelOf: () => "nothing",
      limit: 26,
    });
    // 25 October 2026 is the clock change in Brussels: 25 hours long.
    expect(args).toEqual({
      p_from: "2026-10-24T22:00:00.000Z",
      p_to: "2026-10-25T23:00:00.000Z",
      p_home_id: HOME,
      p_kinds: [],
      p_text: "maple",
      p_limit: 26,
    });
  });

  it("fixes the category on the Security page and ignores the Home filter there", () => {
    const args = activityQuery({
      filters: parseActivityFilters({ category: "profile", home: HOME }),
      cursor: { createdAt: "2026-11-07T09:00:00+00:00", id: ID },
      timeZone: "UTC",
      labelOf: () => "",
      scope: "security",
      limit: 10,
    });
    expect(args).toEqual({
      p_categories: ["security"],
      p_before_created_at: "2026-11-07T09:00:00+00:00",
      p_before_id: ID,
      p_limit: 10,
    });
  });

  it("builds paging links that keep the filters", () => {
    const filters = parseActivityFilters({ category: "profile", q: "naam" });
    expect(newestPageHref("/settings/activity", filters)).toBe(
      "/settings/activity?category=profile&q=naam",
    );
    expect(
      olderPageHref("/settings/activity", filters, {
        createdAt: "2026-11-07T09:00:00+00:00",
        id: ID,
      }),
    ).toBe(
      `/settings/activity?category=profile&q=naam&before=2026-11-07T09%3A00%3A00%2B00%3A00&beforeId=${ID}`,
    );
  });
});

describe("security report files", () => {
  const labels: ReportLabels = {
    event: (kind) => (kind === "signed_in" ? "Signed in" : kind),
    outcome: (outcome) => (outcome === "completed" ? "Completed" : outcome),
    columns: { time: "Time", event: "Event", outcome: "Result", device: "Device", home: "Home" },
    notes: ["Times are in Europe/Brussels."],
  };
  const meta = {
    from: "2026-10-01",
    to: "2026-11-07",
    timeZone: "Europe/Brussels",
    snapshotAt: "2026-11-07T09:00:00Z",
    generatedAt: "2026-11-07T09:05:00Z",
  };
  const rows = [
    {
      kind: "signed_in",
      outcome: "completed",
      homeName: null,
      device: "Safari on iPhone",
      createdAt: "2026-07-01T08:30:00Z",
    },
    {
      kind: "ownership_recovery",
      outcome: "pending",
      homeName: '=HYPERLINK("x"), "Home"',
      device: null,
      createdAt: "2026-11-01T08:30:00Z",
    },
  ];

  it("writes wall-clock times with their offset", () => {
    expect(zonedTimestamp("2026-07-01T08:30:00Z", "Europe/Brussels")).toBe(
      "2026-07-01 10:30:00 +02:00",
    );
    expect(zonedTimestamp("2026-11-01T08:30:00Z", "Europe/Brussels")).toBe(
      "2026-11-01 09:30:00 +01:00",
    );
    expect(zonedTimestamp("2026-07-01T08:30:00Z", "America/St_Johns")).toBe(
      "2026-07-01 06:00:00 -02:30",
    );
  });

  it("neutralises formulas and quotes cells in the CSV", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    const csv = buildCsv(rows, meta, labels);
    expect(csv.startsWith("\u{FEFF}Time,Event,Result,Device,Home\r\n")).toBe(true);
    expect(csv).toContain("2026-07-01 10:30:00 +02:00,Signed in,Completed,Safari on iPhone,\r\n");
    expect(csv).toContain(`"'=HYPERLINK(""x""), ""Home"""`);
  });

  it("describes the snapshot and timezone in the JSON", () => {
    const json = JSON.parse(buildJson(rows, meta, labels)) as {
      report: Record<string, unknown>;
      events: Record<string, unknown>[];
    };
    expect(json.report).toMatchObject({
      timeZone: "Europe/Brussels",
      from: "2026-10-01",
      to: "2026-11-07",
      snapshotAt: "2026-11-07 10:00:00 +01:00",
      notes: ["Times are in Europe/Brussels."],
    });
    expect(json.events[0]).toEqual({
      time: "2026-07-01 10:30:00 +02:00",
      event: "signed_in",
      description: "Signed in",
      outcome: "completed",
      device: "Safari on iPhone",
      home: null,
    });
    expect(reportFileName(meta, "json")).toBe(
      "madeora-security-report-2026-10-01-to-2026-11-07.json",
    );
  });

  it("validates report requests", () => {
    expect(
      securityReportRequestSchema.safeParse({
        from: "2026-10-01",
        to: "2026-11-07",
        timeZone: "Europe/Brussels",
      }).success,
    ).toBe(true);
    expect(
      securityReportRequestSchema.safeParse({
        from: "2026-11-08",
        to: "2026-11-07",
        timeZone: "UTC",
      }).success,
    ).toBe(false);
    expect(
      securityReportRequestSchema.safeParse({
        from: "2026-10-01",
        to: "2026-11-07",
        timeZone: "Mars/Base",
      }).success,
    ).toBe(false);
  });
});
