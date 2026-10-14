import {
  accentColorSchema,
  accentFill,
  accentPalette,
  DEFAULT_ACCENT,
  effectiveAccent,
  parseAccentColor,
} from "./accent";
import { closestClash, similarity, suggestDistinctColors } from "./similarity";

describe("accentColorSchema", () => {
  it("accepts #rrggbb in any case and stores it in lower case", () => {
    expect(accentColorSchema.parse("#2563EB")).toBe("#2563eb");
    expect(accentColorSchema.parse(" #16a34a ")).toBe("#16a34a");
  });

  it.each(["2563eb", "#256", "#2563eb00", "blue", "rgb(0,0,0)", "#zzzzzz", "", "#2563eb;x"])(
    "refuses %j",
    (value) => {
      expect(accentColorSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe("parseAccentColor", () => {
  it("keeps stored colours and ignores anything unexpected", () => {
    expect(parseAccentColor("#2563eb")).toBe("#2563eb");
    expect(parseAccentColor("#2563EB")).toBeNull();
    expect(parseAccentColor(null)).toBeNull();
    expect(parseAccentColor(42)).toBeNull();
  });
});

describe("effectiveAccent", () => {
  it("uses the Home override, else the global accent, else the default", () => {
    expect(effectiveAccent("#2563eb", "#16a34a")).toBe("#2563eb");
    expect(effectiveAccent(null, "#16a34a")).toBe("#16a34a");
    expect(effectiveAccent(null, null)).toBe(DEFAULT_ACCENT);
  });
});

describe("accentPalette", () => {
  it("has unique ids and valid, unique colours, starting with the default", () => {
    expect(accentPalette[0].color).toBe(DEFAULT_ACCENT);
    expect(new Set(accentPalette.map((entry) => entry.id)).size).toBe(accentPalette.length);
    expect(new Set(accentPalette.map((entry) => entry.color)).size).toBe(accentPalette.length);
    for (const entry of accentPalette) {
      expect(accentColorSchema.parse(entry.color)).toBe(entry.color);
    }
  });

  it("keeps every palette colour apart from the others", () => {
    for (const entry of accentPalette) {
      const others = accentPalette.filter((other) => other !== entry).map((o) => o.color);
      expect(closestClash(entry.color, others)).toBe("distinct");
    }
  });
});

describe("accentFill", () => {
  it("keeps a colour that carries readable text and adjusts one that does not", () => {
    expect(accentFill("#2563eb")).toMatchObject({ fill: "#2563eb", adjusted: false });
    expect(accentFill("#ffff00").adjusted).toBe(false);
    expect(accentFill("#777777")).toMatchObject({ fill: "#757575", adjusted: true });
  });
});

describe("similarity", () => {
  it("tells identical, similar and distinct colours apart", () => {
    expect(similarity("#2563eb", "#2563eb")).toBe("identical");
    expect(similarity("#2563eb", "#2a66ee")).toBe("similar");
    expect(similarity("#2563eb", "#16a34a")).toBe("distinct");
  });

  it("reports the most serious clash", () => {
    expect(closestClash("#2563eb", [])).toBe("distinct");
    expect(closestClash("#2563eb", ["#16a34a", "#2a66ee"])).toBe("similar");
    expect(closestClash("#2563eb", ["#2a66ee", "#2563eb"])).toBe("identical");
  });
});

describe("suggestDistinctColors", () => {
  it("offers palette colours far from everyone else's", () => {
    const others = ["#2563eb", "#0284c7"] as const;
    const suggestions = suggestDistinctColors(others);
    expect(suggestions).toHaveLength(3);
    for (const suggestion of suggestions) {
      expect(closestClash(suggestion.color, others)).toBe("distinct");
    }
    expect(suggestions.map((s) => s.id)).not.toContain("blue");
  });

  it("falls back to the palette order with nobody to compare with", () => {
    expect(suggestDistinctColors([]).map((s) => s.id)).toEqual(["purple", "blue", "sky"]);
  });
});
