import type { Mock } from "vitest";

import { PATCH } from "./route";

type Role = "owner" | "administrator" | "member";
interface State {
  identity: { userId: string } | null;
  context: { status: "ok"; role: Role } | { status: "not-found" } | { status: "unavailable" };
  upsert: Mock<(...args: unknown[]) => void>;
  result: { data: unknown; error: unknown };
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok", role: "member" },
  upsert: vi.fn(),
  result: { data: null, error: null },
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/homes/server", () => ({
  getHomeContext: (homeId: string) => {
    if (state.context.status !== "ok") return Promise.resolve(state.context);
    return Promise.resolve({
      status: "ok",
      context: {
        home: { id: homeId, name: "Thuis", timeZone: "Europe/Brussels" },
        membership: { homeId, role: state.context.role, grantedCapabilities: new Set() },
      },
    });
  },
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      from: (table: string) => ({
        upsert: (row: unknown, options: unknown) => {
          state.upsert(table, row, options);
          return { select: () => ({ single: () => Promise.resolve(state.result) }) };
        },
      }),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function patch(body: unknown, homeId = HOME_ID, headers: Record<string, string> = {}) {
  return PATCH(
    new Request(`https://madeora.example/api/v1/homes/${homeId}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "member" };
  state.upsert.mockReset();
  state.result = {
    data: { nickname: "Ali", display_name: null, accent_color: "#2563eb" },
    error: null,
  };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("PATCH /api/v1/homes/{homeId}/profile", () => {
  it.each(["owner", "administrator", "member"] as const)(
    "lets a %s change their own presentation, written as their own row in exactly this Home",
    async (role) => {
      state.context = { status: "ok", role };
      const response = await patch({ nickname: " Ali ", accentColor: "#2563EB" });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        profile: { nickname: "Ali", displayName: null, accentColor: "#2563eb" },
      });
      expect(state.upsert).toHaveBeenCalledWith(
        "home_member_profiles",
        { home_id: HOME_ID, user_id: "user-a", nickname: "Ali", accent_color: "#2563eb" },
        { onConflict: "home_id,user_id" },
      );
    },
  );

  it("resets a field with null or an empty name, and leaves fields not sent alone", async () => {
    await patch({ nickname: "", displayName: null });
    expect(state.upsert).toHaveBeenCalledWith(
      "home_member_profiles",
      { home_id: HOME_ID, user_id: "user-a", nickname: null, display_name: null },
      { onConflict: "home_id,user_id" },
    );
    await patch({ accentColor: null });
    expect(state.upsert).toHaveBeenLastCalledWith(
      "home_member_profiles",
      { home_id: HOME_ID, user_id: "user-a", accent_color: null },
      { onConflict: "home_id,user_id" },
    );
  });

  it("cannot be pointed at another member: an extra user id is refused", async () => {
    const response = await patch({ nickname: "Boss", userId: "user-b" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", fields: [] });
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ nickname: "Al\u{200B}i" }],
    [{ displayName: "\u{202E}ecilA" }],
    [{ nickname: "a".repeat(51) }],
    [{ accentColor: "blue" }],
    [{ accentColor: "#2563eb; color: red" }],
    [{ nickname: 42 }],
    [[]],
    ["null"],
  ])("refuses %j", async (body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("answers 404 for a Home the person does not belong to, as for one that does not exist", async () => {
    state.context = { status: "not-found" };
    const response = await patch({ nickname: "Ali" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not-found" });
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("refuses signed-out requests", async () => {
    state.identity = null;
    expect((await patch({ nickname: "Ali" })).status).toBe(401);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("refuses cross-site requests, other content types and oversized bodies", async () => {
    expect(
      (await patch({ nickname: "Ali" }, HOME_ID, { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect(
      (await patch({ nickname: "Ali" }, HOME_ID, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect((await patch({ nickname: "a".repeat(4000) })).status).toBe(413);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("answers 404 when the membership ended before the write", async () => {
    state.result = { data: null, error: { code: "42501" } };
    expect((await patch({ nickname: "Ali" })).status).toBe(404);
    state.result = { data: null, error: { code: "23503" } };
    expect((await patch({ nickname: "Ali" })).status).toBe(404);
  });

  it("answers 400 when the database refuses a value and 500 when it fails", async () => {
    state.result = { data: null, error: { code: "23514" } };
    expect((await patch({ nickname: "Ali" })).status).toBe(400);
    state.result = { data: null, error: { code: "08006" } };
    const response = await patch({ nickname: "Ali" });
    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({ event: "home_profile.write_failed", code: "08006" }),
    );
  });

  it("answers 500 when the membership cannot be read", async () => {
    state.context = { status: "unavailable" };
    expect((await patch({ nickname: "Ali" })).status).toBe(500);
  });
});
