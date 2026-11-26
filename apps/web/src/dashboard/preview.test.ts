import {
  layoutPreview,
  layoutPreviewSchema,
  copyName,
  versionChange,
  type LayoutPreview,
} from "./preview";
import { personalStarterLayout } from "./starter";

function preview(
  widgets: readonly [id: string, type: "welcome" | "notifications" | "tasks", hidden?: boolean][],
  place: (id: string, index: number) => { x: number; y: number; w: number; h: number },
): LayoutPreview {
  const placements = widgets.map(([id], index) => ({ id, ...place(id, index) }));
  return {
    widgets: widgets.map(([id, type, hidden = false]) => ({ id, type, hidden })),
    placements: { lg: placements, md: placements, sm: placements },
  };
}

describe("layoutPreview", () => {
  it("keeps only widget types, hidden flags and places, never settings or Home bindings", () => {
    const result = layoutPreview(personalStarterLayout);
    expect(result.widgets).toHaveLength(personalStarterLayout.widgets.length);
    for (const widget of result.widgets) {
      expect(Object.keys(widget).sort()).toEqual(["hidden", "id", "type"]);
    }
    expect(result.placements).toEqual(personalStarterLayout.placements);
  });
});

describe("layoutPreviewSchema", () => {
  it("leaves out widget types this client does not know, with their places", () => {
    const parsed = layoutPreviewSchema.parse({
      widgets: [
        { id: "a", type: "welcome", hidden: false },
        { id: "b", type: "from-the-future", hidden: false },
      ],
      placements: {
        lg: [
          { id: "a", x: 0, y: 0, w: 6, h: 2 },
          { id: "b", x: 6, y: 0, w: 6, h: 2 },
        ],
        md: [],
        sm: [{ id: "b", x: 0, y: 0, w: 1, h: 2 }],
      },
    });
    expect(parsed.widgets.map((w) => w.id)).toEqual(["a"]);
    expect(parsed.placements.lg.map((p) => p.id)).toEqual(["a"]);
    expect(parsed.placements.sm).toEqual([]);
  });
});

describe("versionChange", () => {
  const at = (_: string, index: number) => ({ x: 0, y: index * 2, w: 6, h: 2 });
  const base = preview(
    [
      ["a", "welcome"],
      ["b", "notifications"],
    ],
    at,
  );

  it("treats the oldest kept version as everything added", () => {
    expect(versionChange(null, base)).toEqual({
      added: ["welcome", "notifications"],
      removed: [],
      rearranged: false,
    });
  });

  it("lists added and removed widgets by identity, not by type", () => {
    const next = preview(
      [
        ["a", "welcome"],
        ["c", "notifications"],
        ["d", "tasks"],
      ],
      at,
    );
    expect(versionChange(base, next)).toEqual({
      added: ["notifications", "tasks"],
      removed: ["notifications"],
      rearranged: false,
    });
  });

  it("notices a move, a resize or a hidden widget", () => {
    const moved = preview(
      [
        ["a", "welcome"],
        ["b", "notifications"],
      ],
      (id, index) => (id === "b" ? { x: 6, y: 0, w: 6, h: 2 } : at(id, index)),
    );
    expect(versionChange(base, moved).rearranged).toBe(true);
    const hidden = preview(
      [
        ["a", "welcome"],
        ["b", "notifications", true],
      ],
      at,
    );
    expect(versionChange(base, hidden)).toEqual({ added: [], removed: [], rearranged: true });
    expect(versionChange(base, base)).toEqual({ added: [], removed: [], rearranged: false });
  });
});

describe("copyName", () => {
  const format = (name: string, n: number) =>
    n === 1 ? `${name} (copy)` : `${name} (copy ${String(n)})`;

  it("picks the first free copy name, ignoring case and surrounding spaces", () => {
    expect(copyName("Morning", ["Morning"], format, 80)).toBe("Morning (copy)");
    expect(copyName("Morning", ["Morning", " morning (COPY) "], format, 80)).toBe(
      "Morning (copy 2)",
    );
    expect(copyName("Morning", ["Morning (copy)", "Morning (copy 2)"], format, 80)).toBe(
      "Morning (copy 3)",
    );
  });

  it("shortens a long name so the copy still fits the limit", () => {
    const long = "x".repeat(80);
    const result = copyName(long, [long], format, 80);
    expect(result.length).toBeLessThanOrEqual(80);
    expect(result.endsWith(" (copy)")).toBe(true);
  });
});
