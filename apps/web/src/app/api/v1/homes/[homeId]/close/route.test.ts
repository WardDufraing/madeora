import type { Mock } from "vitest";

import { POST } from "./route";

type Role = "owner" | "administrator" | "member";
const state = vi.hoisted(
  (): {
    identity: { userId: string } | null;
    role: Role | null;
    rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
  } => ({ identity: { userId: "user-a" }, role: "owner", rpc: vi.fn() }),
);

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/homes/server", () => ({
  getHomeContext: (homeId: string) =>
    Promise.resolve(
      state.role === null
        ? { status: "not-found" }
        : {
            status: "ok",
            context: {
              home: { id: homeId, name: "Thuis", timeZone: "Europe/Brussels" },
              membership: { homeId, role: state.role, grantedCapabilities: new Set() },
            },
          },
    ),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function post(body: unknown, headers: Record<string, string> = sameOrigin): Promise<Response> {
  return POST(
    new Request(`https://madeora.example/api/v1/homes/${HOME_ID}/close`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId: HOME_ID }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.role = "owner";
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: "2026-12-10T09:00:00+00:00", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/close", () => {
  it("closes the Home for its Owner and returns the deadline", async () => {
    const response = await post({ name: "Thuis" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ purgeAfter: "2026-12-10T09:00:00+00:00" });
    expect(state.rpc).toHaveBeenCalledWith("close_home", {
      p_home_id: HOME_ID,
      p_confirm_name: "Thuis",
    });
  });

  it.each<Role | null>(["administrator", "member", null])(
    "answers 404 to anyone but the Owner (%s)",
    async (role) => {
      state.role = role;
      expect((await post({ name: "Thuis" })).status).toBe(404);
      expect(state.rpc).not.toHaveBeenCalled();
    },
  );

  it("refuses cross-site requests, the signed-out and bad bodies before the database", async () => {
    expect((await post({ name: "Thuis" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ name: "" })).status).toBe(400);
    expect((await post({ name: "Thuis", extra: true })).status).toBe(400);
    state.identity = null;
    expect((await post({ name: "Thuis" })).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("asks for a fresh confirmation and reports a wrong name", async () => {
    state.rpc.mockReturnValueOnce({
      data: null,
      error: { code: "42501", hint: "reauthentication_required" },
    });
    expect((await post({ name: "Thuis" })).status).toBe(403);
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "22023", hint: "confirmation" } });
    expect((await post({ name: "Thuis" })).status).toBe(400);
  });
});
