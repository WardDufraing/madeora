import {
  checkDisplayLayout,
  defaultDisplayLayout,
  layoutOffersActions,
  lockMessageSchema,
  readDisplayLayout,
  widgetSpan,
} from "./layout";

const ID_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const ID_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";
const LIST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031";

describe("checkDisplayLayout", () => {
  it("accepts the display catalogue with defaults filled in", () => {
    expect(
      checkDisplayLayout({
        version: 1,
        widgets: [
          { id: ID_A, type: "chores", size: "large", config: { actions: false } },
          { id: ID_B, type: "shopping", size: "small", config: { listIds: [LIST] } },
        ],
      }),
    ).toEqual({
      version: 1,
      widgets: [
        { id: ID_A, type: "chores", size: "large", config: { actions: false, count: 10 } },
        { id: ID_B, type: "shopping", size: "small", config: { listIds: [LIST], count: 10 } },
      ],
    });
  });

  it.each([
    ["a widget outside the catalogue", { id: ID_A, type: "tasks", size: "small", config: {} }],
    ["an unknown setting", { id: ID_A, type: "clock", size: "small", config: { secret: 1 } }],
    ["an unknown size", { id: ID_A, type: "clock", size: "huge", config: {} }],
    [
      "too many lists",
      {
        id: ID_A,
        type: "shopping",
        size: "small",
        config: {
          listIds: ["1", "2", "3", "4", "5", "6"].map(
            (n) => `6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a003${n}`,
          ),
        },
      },
    ],
    [
      "a list twice",
      { id: ID_A, type: "shopping", size: "small", config: { listIds: [LIST, LIST] } },
    ],
  ])("refuses %s", (_name, widget) => {
    expect(checkDisplayLayout({ version: 1, widgets: [widget] })).toBeNull();
  });

  it("refuses duplicate ids and too many widgets", () => {
    const clock = { id: ID_A, type: "clock", size: "small", config: {} };
    expect(checkDisplayLayout({ version: 1, widgets: [clock, clock] })).toBeNull();
    const many = Array.from({ length: 9 }, (_, n) => ({
      ...clock,
      id: `6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00${String(10 + n)}`,
    }));
    expect(checkDisplayLayout({ version: 1, widgets: many })).toBeNull();
  });
});

describe("readDisplayLayout", () => {
  it("uses the default layout for null and drops what it does not understand", () => {
    expect(readDisplayLayout(null)).toBe(defaultDisplayLayout);
    expect(
      readDisplayLayout({
        version: 1,
        widgets: [
          { id: ID_A, type: "photos", size: "small", config: {} },
          { id: ID_B, type: "clock", size: "small", config: {} },
        ],
      }).widgets.map((widget) => widget.type),
    ).toEqual(["clock"]);
    expect(readDisplayLayout({ version: 2, widgets: [] })).toBe(defaultDisplayLayout);
  });
});

describe("layout helpers", () => {
  it("offers actions only with a chores widget that allows them", () => {
    expect(layoutOffersActions(defaultDisplayLayout)).toBe(true);
    expect(layoutOffersActions({ version: 1, widgets: [] })).toBe(false);
  });

  it("never spans more columns than the grid has", () => {
    expect(widgetSpan("large", 2)).toEqual({ columns: 2, rows: 2 });
    expect(widgetSpan("medium", 3)).toEqual({ columns: 2, rows: 2 });
    expect(widgetSpan("medium", 1)).toEqual({ columns: 1, rows: 2 });
    expect(widgetSpan("small", 3)).toEqual({ columns: 1, rows: 1 });
  });

  it("checks the lock message like the database", () => {
    expect(lockMessageSchema.parse("  ")).toBeNull();
    expect(lockMessageSchema.parse(" Welkom! ")).toBe("Welkom!");
    expect(lockMessageSchema.safeParse("x".repeat(81)).success).toBe(false);
    expect(lockMessageSchema.safeParse("a\u0007b").success).toBe(false);
  });
});
