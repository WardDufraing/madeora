import { toDisplayBoard } from "./board";

vi.mock("server-only", () => ({}));
vi.mock("@/auth/supabase-server", () => ({ createSupabaseServerClient: vi.fn() }));

const base = {
  display_id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0071",
  timezone: "Europe/Brussels",
  theme: "dark",
  clock_format: "24h",
  density: "compact",
  orientation: "portrait",
  signal_version: 7,
};

describe("toDisplayBoard", () => {
  it("keeps only the lock screen's fields while locked", () => {
    expect(
      toDisplayBoard({ ...base, locked: true, lock_message: "Welkom!", home_name: "Thuis" }),
    ).toEqual({
      displayId: base.display_id,
      timeZone: "Europe/Brussels",
      preferences: {
        orientation: "portrait",
        theme: "dark",
        density: "compact",
        clockFormat: "24h",
      },
      signalVersion: 7,
      locked: true,
      lockMessage: "Welkom!",
    });
  });

  it("maps an unlocked board and falls back to the default layout", () => {
    const board = toDisplayBoard({
      ...base,
      locked: false,
      display_name: "Keuken",
      home_name: "Thuis",
      layout: null,
      actions: true,
      require_pin: false,
      members: [],
      lock_managers: [],
      chores: [],
      shopping: [
        {
          list_id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0031",
          name: "Groceries",
          remaining: 1,
          items: [
            {
              item_id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041",
              name: "Milk",
              quantity: "2",
              unit: "bogus",
            },
          ],
        },
      ],
    });
    expect(board?.locked).toBe(false);
    if (board?.locked !== false) return;
    expect(board.layout.widgets.map((widget) => widget.type)).toEqual([
      "clock",
      "chores",
      "shopping",
    ]);
    expect(board.shopping[0]?.items[0]?.unit).toBeNull();
  });

  it("refuses an unexpected shape", () => {
    expect(toDisplayBoard({ ...base, locked: "yes" })).toBeNull();
    expect(toDisplayBoard(null)).toBeNull();
  });
});
