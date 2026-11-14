import type { Mock } from "vitest";

import { PATCH } from "./route";

interface State {
  identity: { userId: string } | null;
  upsert: Mock<(...args: unknown[]) => void>;
  errors: Record<string, { code: string } | null>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  upsert: vi.fn(),
  errors: {},
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      from: (table: string) => ({
        upsert: (row: unknown, options: unknown) => {
          state.upsert(table, row, options);
          return Promise.resolve({ error: state.errors[table] ?? null });
        },
      }),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function patch(body: unknown, headers: Record<string, string> = {}) {
  return PATCH(
    new Request("https://madeora.example/api/v1/me/ora", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.upsert.mockReset();
  state.errors = {};
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("PATCH /api/v1/me/ora", () => {
  it("writes only the fields sent, as the signed-in person's own row", async () => {
    const response = await patch({ enabled: false, motion: "none" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.upsert).toHaveBeenCalledTimes(1);
    expect(state.upsert).toHaveBeenCalledWith(
      "ora_preferences",
      { user_id: "user-a", enabled: false, motion: "none" },
      { onConflict: "user_id" },
    );
  });

  it("saves the teaser mute as the person's own setting", async () => {
    await patch({ teasersMuted: true });
    expect(state.upsert).toHaveBeenCalledWith(
      "ora_preferences",
      { user_id: "user-a", teasers_muted: true },
      { onConflict: "user_id" },
    );
  });

  it("maps frequency, category switches and quiet hours to the person's own columns (S47b)", async () => {
    await patch({ frequency: "quiet", categories: { celebrations: false, reminders: true } });
    expect(state.upsert).toHaveBeenLastCalledWith(
      "ora_preferences",
      { user_id: "user-a", frequency: "quiet", cat_celebrations: false, cat_reminders: true },
      { onConflict: "user_id" },
    );
    await patch({ quietHours: { start: "22:00", end: "07:00" } });
    expect(state.upsert).toHaveBeenLastCalledWith(
      "ora_preferences",
      { user_id: "user-a", quiet_start: "22:00", quiet_end: "07:00" },
      { onConflict: "user_id" },
    );
    await patch({ quietHours: null });
    expect(state.upsert).toHaveBeenLastCalledWith(
      "ora_preferences",
      { user_id: "user-a", quiet_start: null, quiet_end: null },
      { onConflict: "user_id" },
    );
  });

  it("refuses a bad time or window without writing", async () => {
    state.upsert.mockClear();
    expect((await patch({ quietHours: { start: "25:00", end: "07:00" } })).status).toBe(400);
    expect((await patch({ quietHours: { start: "08:00", end: "08:00" } })).status).toBe(400);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("records the introduction and the Personal colour", async () => {
    await patch({ intro: "skipped", personalPalette: "denim" });
    expect(state.upsert).toHaveBeenCalledWith(
      "ora_preferences",
      { user_id: "user-a", intro: "skipped", personal_palette: "denim" },
      { onConflict: "user_id" },
    );
  });

  it("writes a Home colour for the signed-in person only, in the named Home", async () => {
    const response = await patch({ homePalette: { homeId: HOME_ID, palette: "olive" } });
    expect(response.status).toBe(200);
    expect(state.upsert).toHaveBeenCalledTimes(1);
    expect(state.upsert).toHaveBeenCalledWith(
      "ora_home_palettes",
      { home_id: HOME_ID, user_id: "user-a", palette: "olive" },
      { onConflict: "home_id,user_id" },
    );
  });

  it("answers 403 when the database refuses a Home the person does not belong to", async () => {
    state.errors.ora_home_palettes = { code: "42501" };
    const response = await patch({ homePalette: { homeId: HOME_ID, palette: "olive" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("cannot be pointed at another person: extra fields are refused", async () => {
    for (const body of [
      { enabled: true, userId: "user-b" },
      { homePalette: { homeId: HOME_ID, palette: "olive", userId: "user-b" } },
    ]) {
      expect((await patch(body)).status).toBe(400);
    }
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("refuses values outside the allowed lists, an empty change and a malformed Home id", async () => {
    for (const body of [
      {},
      { motion: "wild" },
      { intro: "later" },
      { personalPalette: "Heather" },
      { homePalette: { homeId: "not-a-uuid", palette: "olive" } },
      { enabled: "yes" },
    ]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("answers 400 for a check-constraint refusal and 500 without leaking details otherwise", async () => {
    state.errors.ora_preferences = { code: "23514" };
    expect((await patch({ enabled: true })).status).toBe(400);
    state.errors.ora_preferences = { code: "XX000" };
    const response = await patch({ enabled: true });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "failed" });
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({ event: "ora.settings_write_failed", code: "XX000" }),
    );
  });

  it("refuses cross-site, non-JSON and signed-out requests", async () => {
    expect((await patch({ enabled: true }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await patch({ enabled: true }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await patch("{broken")).status).toBe(400);
    state.identity = null;
    expect((await patch({ enabled: true })).status).toBe(401);
    expect(state.upsert).not.toHaveBeenCalled();
  });
});
