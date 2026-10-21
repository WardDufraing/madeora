// S20: the client-safe contract for the Home-wide history query and bulk changes.
import { bulkSchema, homeHistorySearch, parseHomeHistoryQuery } from "./schema";

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";

describe("the Home-wide history query", () => {
  it("falls back to defaults for unknown values and keeps the rest", () => {
    expect(
      parseHomeHistoryQuery({
        q: ["  bins   out ", "ignored"],
        member: "not-an-id",
        from: "2026-10-01",
        to: "2026-13-40",
        basis: "completed",
        state: "bogus",
        approval: "approved",
      }),
    ).toEqual({
      q: "bins out",
      member: undefined,
      chore: undefined,
      from: "2026-10-01",
      to: undefined,
      basis: "completed",
      state: "all",
      approval: "approved",
    });
  });

  it("cuts a long search at 100 characters and drops an end before the start", () => {
    const query = parseHomeHistoryQuery({
      q: "x".repeat(150),
      from: "2026-10-10",
      to: "2026-10-01",
    });
    expect(query.q).toHaveLength(100);
    expect(query.to).toBeUndefined();
  });

  it("writes only what differs from the defaults", () => {
    const query = parseHomeHistoryQuery({ q: "100% soap", state: "missed" });
    expect(homeHistorySearch(query)).toBe("q=100%25+soap&state=missed");
    expect(homeHistorySearch(parseHomeHistoryQuery({}))).toBe("");
  });
});

describe("a bulk change", () => {
  const base = { homeId: HOME, items: [{ id: OCCURRENCE, revision: 1 }], dryRun: true };

  it("takes exactly the value its action needs", () => {
    expect(bulkSchema.safeParse({ ...base, action: "skip", reason: "  Away " }).data).toMatchObject(
      {
        reason: "Away",
        member: null,
        dueDate: null,
      },
    );
    expect(bulkSchema.safeParse({ ...base, action: "reassign" }).success).toBe(false);
    expect(
      bulkSchema.safeParse({ ...base, action: "due_date", dueDate: "2026-02-30" }).success,
    ).toBe(false);
    expect(
      bulkSchema.safeParse({ ...base, action: "reassign", member: HOME, reason: "x" }).success,
    ).toBe(false);
  });

  it("refuses an empty, repeated or oversized selection", () => {
    const many = Array.from({ length: 101 }, (_, index) => ({
      id: `6f2c1f0e-1d7a-4b8e-9c55-${String(index).padStart(12, "0")}`,
      revision: 1,
    }));
    for (const items of [[], [base.items[0], base.items[0]], many]) {
      expect(bulkSchema.safeParse({ ...base, action: "skip", items }).success).toBe(false);
    }
  });
});
