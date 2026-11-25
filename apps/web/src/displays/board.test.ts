import { getDisplayBoard, toDisplayBoard } from "./board";

const rpc = vi.hoisted(() => vi.fn());
const sessionState = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc }),
}));
vi.mock("./display-actions", () => ({
  readDisplaySessionState: (...args: unknown[]) => Promise.resolve(sessionState(...args)),
}));

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
      ambientAfterSeconds: 300,
      ambientShows: { chores: false, shopping: false },
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
    expect(board.unlock).toBeNull();
  });

  it("refuses an unexpected shape", () => {
    expect(toDisplayBoard({ ...base, locked: "yes" })).toBeNull();
    expect(toDisplayBoard(null)).toBeNull();
  });
});

describe("getDisplayBoard (UX8a)", () => {
  const unlockedRow = {
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
    shopping: [],
  };

  it("adds the Home's ambient timing and the open session for this display", async () => {
    rpc.mockResolvedValueOnce({ data: unlockedRow, error: null, status: 200 });
    sessionState.mockReturnValueOnce({
      ambientAfterSeconds: 600,
      ambientShows: { chores: true, shopping: false },
      unlock: { membershipId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011", secondsLeft: 90 },
    });
    const result = await getDisplayBoard();
    expect(sessionState).toHaveBeenCalledWith(base.display_id);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok" || result.board.locked) throw new Error("unexpected board");
    expect(result.board.ambientAfterSeconds).toBe(600);
    expect(result.board.ambientShows).toEqual({ chores: true, shopping: false });
    expect(result.board.unlock).toEqual({
      membershipId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011",
      secondsLeft: 90,
    });
  });

  it("never sends a session with a locked board", async () => {
    rpc.mockResolvedValueOnce({
      data: { ...base, locked: true, lock_message: null },
      error: null,
      status: 200,
    });
    sessionState.mockReturnValueOnce({
      ambientAfterSeconds: 120,
      ambientShows: { chores: true, shopping: true },
      unlock: { membershipId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011", secondsLeft: 90 },
    });
    const result = await getDisplayBoard();
    if (result.kind !== "ok") throw new Error("unexpected result");
    expect(result.board).not.toHaveProperty("unlock");
    expect(result.board.ambientShows).toEqual({ chores: false, shopping: false });
    expect(result.board.ambientAfterSeconds).toBe(120);
  });
});
