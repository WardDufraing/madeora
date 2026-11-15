import { defaultOraSettings, type OraSettings } from "@/ora/settings";

import { claimCelebration } from "./server";

interface State {
  settings: OraSettings | null;
  rpc: { data: unknown; error: { code: string } | null };
  calls: unknown[];
  now: string;
}
const state = vi.hoisted((): State => ({
  settings: null,
  rpc: { data: null, error: null },
  calls: [],
  now: "",
}));

vi.mock("server-only", () => ({}));
vi.mock("@/ora/server", () => ({ getOraSettings: () => Promise.resolve(state.settings) }));
vi.mock("@/preferences/server", () => ({
  getEffectiveTimeZone: () => Promise.resolve({ timeZone: "UTC" }),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (fn: string, args: unknown) => {
        state.calls.push({ fn, args });
        return Promise.resolve(state.rpc);
      },
    }),
}));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const inHome = {
  home: {
    id: HOME,
    membership: { homeId: HOME, role: "member" as const, grantedCapabilities: new Set<never>() },
  },
};

beforeEach(() => {
  vi.useRealTimers();
  state.settings = defaultOraSettings;
  state.rpc = { data: null, error: null };
  state.calls = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("claimCelebration", () => {
  it("claims through the database for this Home and returns the grouped line", async () => {
    state.rpc = { data: { count: 1, points: 5, title: "Dishes" }, error: null };
    const result = await claimCelebration(inHome);
    expect(result).toEqual({
      status: "ok",
      celebration: { count: 1, points: 5, title: "Dishes" },
    });
    expect(state.calls).toEqual([{ fn: "claim_ora_celebrations", args: { p_home_id: HOME } }]);
  });

  it("never names a chore when several awards are grouped", async () => {
    state.rpc = { data: { count: 3, points: 11, title: "Dishes" }, error: null };
    expect(await claimCelebration(inHome)).toEqual({
      status: "ok",
      celebration: { count: 3, points: 11, title: null },
    });
  });

  it("says nothing when there is nothing new", async () => {
    expect(await claimCelebration(inHome)).toEqual({ status: "ok", celebration: null });
  });

  it("celebrates nothing in Personal space and asks the database nothing", async () => {
    expect(await claimCelebration({ home: null })).toEqual({ status: "ok", celebration: null });
    expect(state.calls).toEqual([]);
  });

  it("claims nothing when Ora is off, Quiet is chosen or the switch is off", async () => {
    for (const settings of [
      { ...defaultOraSettings, enabled: false },
      { ...defaultOraSettings, frequency: "quiet" as const },
      {
        ...defaultOraSettings,
        categories: { ...defaultOraSettings.categories, celebrations: false },
      },
    ]) {
      state.settings = settings;
      expect(await claimCelebration(inHome)).toEqual({ status: "ok", celebration: null });
    }
    expect(state.calls).toEqual([]);
  });

  it("holds back, without claiming, when settings are unknown", async () => {
    state.settings = null;
    expect(await claimCelebration(inHome)).toEqual({
      status: "ok",
      celebration: null,
      deferred: true,
    });
    expect(state.calls).toEqual([]);
  });

  it("holds back, without claiming, during quiet hours", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-16T23:30:00Z") });
    state.settings = { ...defaultOraSettings, quietHours: { start: "22:00", end: "07:00" } };
    expect(await claimCelebration(inHome)).toEqual({
      status: "ok",
      celebration: null,
      deferred: true,
    });
    expect(state.calls).toEqual([]);
  });

  it("is unavailable when the database fails or answers something unexpected", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.rpc = { data: null, error: { code: "XX000" } };
    expect(await claimCelebration(inHome)).toEqual({ status: "unavailable" });
    state.rpc = { data: { count: "many" }, error: null };
    expect(await claimCelebration(inHome)).toEqual({ status: "unavailable" });
    expect(log).toHaveBeenCalledTimes(2);
  });
});
