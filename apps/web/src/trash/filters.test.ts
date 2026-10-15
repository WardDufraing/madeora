import { hasTrashFilters, parseTrashFilters, startOfDayInZone, trashQuery } from "./filters";

describe("startOfDayInZone", () => {
  it("starts the day at the zone's own midnight", () => {
    expect(startOfDayInZone("2026-10-15", "UTC").toISOString()).toBe("2026-10-15T00:00:00.000Z");
    // Brussels is UTC+2 in summer time and UTC+1 after the clocks go back on 25 October.
    expect(startOfDayInZone("2026-10-15", "Europe/Brussels").toISOString()).toBe(
      "2026-10-14T22:00:00.000Z",
    );
    expect(startOfDayInZone("2026-10-26", "Europe/Brussels").toISOString()).toBe(
      "2026-10-25T23:00:00.000Z",
    );
    expect(startOfDayInZone("2026-10-15", "America/New_York").toISOString()).toBe(
      "2026-10-15T04:00:00.000Z",
    );
    expect(startOfDayInZone("2026-10-15", "Asia/Kolkata").toISOString()).toBe(
      "2026-10-14T18:30:00.000Z",
    );
  });

  it("copes with the day a clock change happens", () => {
    // The day the clocks go back: 25 October is 25 hours long in Brussels.
    const start = startOfDayInZone("2026-10-25", "Europe/Brussels").getTime();
    const end = startOfDayInZone("2026-10-26", "Europe/Brussels").getTime();
    expect((end - start) / 3_600_000).toBe(25);
    // Sao Paulo had no midnight on days its clocks went forward: the day starts after the gap.
    const gap = startOfDayInZone("2018-11-04", "America/Sao_Paulo");
    expect(gap.toISOString()).toBe("2018-11-04T03:00:00.000Z");
  });
});

describe("parseTrashFilters", () => {
  it("keeps only known values and valid dates", () => {
    expect(
      parseTrashFilters({ module: "sample", type: "sample", from: "2026-10-01", to: "2026-10-31" }),
    ).toEqual({ module: "sample", itemType: "sample", from: "2026-10-01", to: "2026-10-31" });
    const unknown = parseTrashFilters({ module: "x", type: ["a"], from: "2026-02-31", to: "soon" });
    expect(unknown).toEqual({ module: "", itemType: "", from: "", to: "" });
    expect(hasTrashFilters(unknown)).toBe(false);
  });
});

describe("trashQuery", () => {
  it("turns the day range into instants, the end day included", () => {
    expect(
      trashQuery(
        { module: "sample", itemType: "", from: "2026-10-01", to: "2026-10-31" },
        "Europe/Brussels",
        "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001",
      ),
    ).toEqual({
      homeId: "0b6f6c55-3a4e-4f7a-9f15-9a8a1d0c0001",
      module: "sample",
      deletedFrom: "2026-09-30T22:00:00.000Z",
      deletedTo: "2026-10-31T23:00:00.000Z",
    });
    expect(trashQuery({ module: "", itemType: "", from: "", to: "" }, "UTC", null)).toEqual({});
  });
});
