import type { Mock } from "vitest";

import { POST as markRead } from "./read/route";
import { PUT as setPreference } from "./preferences/route";
import { POST as resetPreference } from "./preferences/reset/route";
import { PUT as setQuietHours } from "./quiet-hours/route";
import { POST as resetQuietHours } from "./quiet-hours/reset/route";

interface State {
  identity: { userId: string } | null;
  result: { data: unknown; error: unknown };
  rpc: Mock<(name: string, args: Record<string, unknown>) => void>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  result: { data: "ok", error: null },
  rpc: vi.fn(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const NOTIFICATION_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0002";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => {
        state.rpc(name, args);
        return Promise.resolve(state.result);
      },
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function request(path: string, method: "POST" | "PUT", body: unknown, headers = {}) {
  return new Request(`https://madeora.example/api/v1/me/notifications${path}`, {
    method,
    headers: { "content-type": "application/json", ...sameOrigin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.result = { data: "ok", error: null };
  state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const preference = { homeId: HOME_ID, category: "invitations", channel: "email", enabled: true };
const quiet = {
  homeId: null,
  enabled: true,
  start: "22:00",
  end: "07:00",
  timeZone: "Europe/Brussels",
};

describe("PUT /api/v1/me/notifications/preferences", () => {
  it("sets a Home override with the person's own session", async () => {
    const response = await setPreference(request("/preferences", "PUT", preference));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.rpc).toHaveBeenCalledWith("set_notification_preference", {
      p_home_id: HOME_ID,
      p_category: "invitations",
      p_channel: "email",
      p_enabled: true,
    });
  });

  it("sets the account default without a Home", async () => {
    await setPreference(request("/preferences", "PUT", { ...preference, homeId: null }));
    expect(state.rpc).toHaveBeenCalledWith("set_notification_preference", {
      p_category: "invitations",
      p_channel: "email",
      p_enabled: true,
    });
  });

  it("says not-found for a Home the person does not belong to", async () => {
    state.result = { data: "not_found", error: null };
    const response = await setPreference(request("/preferences", "PUT", preference));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not-found" });
  });

  it("refuses essential categories, other channels and extra fields before the database", async () => {
    for (const body of [
      { ...preference, category: "security" },
      { ...preference, channel: "sms" },
      { ...preference, userId: "someone-else" },
    ]) {
      const response = await setPreference(request("/preferences", "PUT", body));
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/me/notifications/preferences/reset", () => {
  it("removes an override", async () => {
    const { enabled: _enabled, ...body } = preference;
    const response = await resetPreference(request("/preferences/reset", "POST", body));
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("reset_notification_preference", {
      p_home_id: HOME_ID,
      p_category: "invitations",
      p_channel: "email",
    });
  });
});

describe("PUT /api/v1/me/notifications/quiet-hours", () => {
  it("sets quiet hours", async () => {
    const response = await setQuietHours(request("/quiet-hours", "PUT", quiet));
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("set_notification_quiet_hours", {
      p_enabled: true,
      p_start: "22:00",
      p_end: "07:00",
      p_time_zone: "Europe/Brussels",
    });
  });

  it.each([
    { ...quiet, end: "22:00" },
    { ...quiet, timeZone: "Nowhere/Land" },
    { ...quiet, start: "25:00" },
  ])("refuses %j", async (body) => {
    expect((await setQuietHours(request("/quiet-hours", "PUT", body))).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("says not-found for another person's Home", async () => {
    state.result = { data: "not_found", error: null };
    const response = await setQuietHours(
      request("/quiet-hours", "PUT", { ...quiet, homeId: HOME_ID }),
    );
    expect(response.status).toBe(404);
  });

  it("resets one scope", async () => {
    const response = await resetQuietHours(
      request("/quiet-hours/reset", "POST", { homeId: HOME_ID }),
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("reset_notification_quiet_hours", {
      p_home_id: HOME_ID,
    });
  });
});

describe("POST /api/v1/me/notifications/read", () => {
  it("marks the listed notifications and reports how many changed", async () => {
    state.result = { data: 1, error: null };
    const response = await markRead(request("/read", "POST", { ids: [NOTIFICATION_ID] }));
    expect(await response.json()).toEqual({ updated: 1 });
    expect(state.rpc).toHaveBeenCalledWith("mark_notifications_read", { p_ids: [NOTIFICATION_ID] });
  });

  it("marks everything", async () => {
    state.result = { data: 4, error: null };
    await markRead(request("/read", "POST", { all: true }));
    expect(state.rpc).toHaveBeenCalledWith("mark_notifications_read", {});
  });

  it("refuses more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, () => NOTIFICATION_ID);
    expect((await markRead(request("/read", "POST", { ids }))).status).toBe(400);
  });
});

describe.each([
  ["preferences", () => setPreference(request("/preferences", "PUT", preference))],
  [
    "preferences reset",
    () =>
      resetPreference(
        request("/preferences/reset", "POST", {
          homeId: null,
          category: "invitations",
          channel: "email",
        }),
      ),
  ],
  ["quiet hours", () => setQuietHours(request("/quiet-hours", "PUT", quiet))],
  [
    "quiet hours reset",
    () => resetQuietHours(request("/quiet-hours/reset", "POST", { homeId: null })),
  ],
  ["read", () => markRead(request("/read", "POST", { all: true }))],
])("%s: common checks", (_name, call) => {
  it("needs a signed-in person", async () => {
    state.identity = null;
    const response = await call();
    expect(response.status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps a lost session at the database to 401 and a malformed value to 400", async () => {
    state.result = { data: null, error: { code: "42501" } };
    expect((await call()).status).toBe(401);
    state.result = { data: null, error: { code: "22023" } };
    expect((await call()).status).toBe(400);
  });

  it("hides database errors behind a code-only log and a 500", async () => {
    state.result = { data: null, error: { code: "XX000", message: "secret@example.test" } };
    const response = await call();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
    expect(console.error).toHaveBeenCalledWith(expect.not.stringContaining("secret"));
  });
});

describe("cross-site and malformed requests", () => {
  it("refuses a cross-origin request before anything else", async () => {
    const response = await setPreference(
      request("/preferences", "PUT", preference, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a form post and bodies that are not JSON or too large", async () => {
    expect(
      (await setPreference(request("/preferences", "PUT", "a=b", { "content-type": "text/plain" })))
        .status,
    ).toBe(415);
    expect((await setPreference(request("/preferences", "PUT", "{nope"))).status).toBe(400);
    expect(
      (
        await setPreference(
          request("/preferences", "PUT", JSON.stringify({ pad: "x".repeat(5000) })),
        )
      ).status,
    ).toBe(413);
  });
});
