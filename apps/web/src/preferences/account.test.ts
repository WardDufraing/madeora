import type { Mock } from "vitest";

import { getAccountPreferences, getStoredPreferences, patchToColumns } from "./account";
import { noPreferences } from "./schema";

interface State {
  identity: { userId: string } | null;
  result: { data: unknown; error: unknown };
  eq: Mock<(...args: unknown[]) => void>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  result: { data: null, error: null },
  eq: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth/identity", () => ({ getVerifiedIdentity: () => Promise.resolve(state.identity) }));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      from: () => ({
        select: () => ({
          eq: (column: string, value: string) => {
            state.eq(column, value);
            return { maybeSingle: () => Promise.resolve(state.result) };
          },
        }),
      }),
    }),
}));

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.result = { data: null, error: null };
  state.eq.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("getAccountPreferences", () => {
  it("is signed-out without a confirmed identity, and reads nothing", async () => {
    state.identity = null;
    expect(await getAccountPreferences()).toEqual({ status: "signed-out" });
    expect(state.eq).not.toHaveBeenCalled();
  });

  it("gives the defaults to an account that never saved anything", async () => {
    expect(await getAccountPreferences()).toEqual({ status: "ok", preferences: noPreferences });
    expect(state.eq).toHaveBeenCalledWith("user_id", "user-a");
  });

  it("reads the saved row", async () => {
    state.result = {
      data: {
        display_name: "Sam",
        locale: "nl",
        date_format: "dmy-dot",
        time_format: null,
        week_start: "sunday",
        number_format: null,
        measurement_system: "metric",
        timezone: "Asia/Tokyo",
      },
      error: null,
    };
    expect(await getAccountPreferences()).toEqual({
      status: "ok",
      preferences: {
        ...noPreferences,
        displayName: "Sam",
        locale: "nl",
        dateFormat: "dmy-dot",
        weekStart: "sunday",
        measurementSystem: "metric",
        timeZone: "Asia/Tokyo",
      },
    });
  });

  it("is unavailable when the row cannot be read, and the defaults apply", async () => {
    state.result = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    expect(await getAccountPreferences()).toEqual({ status: "unavailable" });
    expect(await getStoredPreferences()).toEqual(noPreferences);
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({ event: "preferences.read_failed", code: "42P01" }),
    );
  });
});

describe("patchToColumns", () => {
  it("maps only the fields present in the change", () => {
    expect(patchToColumns({ locale: "en", timeZone: null })).toEqual({
      locale: "en",
      timezone: null,
    });
    expect(
      patchToColumns({
        displayName: "Sam",
        dateFormat: "ymd-dash",
        timeFormat: "12h",
        weekStart: "monday",
        numberFormat: "comma-dot",
        measurementSystem: "us-customary",
      }),
    ).toEqual({
      display_name: "Sam",
      date_format: "ymd-dash",
      time_format: "12h",
      week_start: "monday",
      number_format: "comma-dot",
      measurement_system: "us-customary",
    });
  });
});
