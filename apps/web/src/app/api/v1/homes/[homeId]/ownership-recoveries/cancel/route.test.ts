import type { Mock } from "vitest";

import { POST } from "./route";

type Role = "owner" | "administrator" | "member";
interface State {
  identity: { userId: string } | null;
  context: { status: "ok"; role: Role } | { status: "not-found" } | { status: "unavailable" };
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok", role: "member" },
  rpc: vi.fn(),
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
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function request(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://madeora.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...sameOrigin, ...headers },
    body: JSON.stringify(body),
  });
}

function post(body: unknown = {}, headers: Record<string, string> = {}): Promise<Response> {
  return POST(request(`/api/v1/homes/${HOME_ID}/ownership-recoveries/cancel`, body, headers), {
    params: Promise.resolve({ homeId: HOME_ID }),
  });
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "owner" };
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: [{ outcome: "cancelled", cancelled: 2 }], error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/ownership-recoveries/cancel", () => {
  it("lets the Owner end every open request", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: 2 });
    expect(state.rpc).toHaveBeenCalledWith("cancel_ownership_recoveries", { p_home_id: HOME_ID });
  });

  it.each<Role>(["administrator", "member"])("refuses a %s", async (role) => {
    state.context = { status: "ok", role };
    expect((await post()).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("maps the database's own refusal", async () => {
    state.rpc.mockReturnValue({ data: [{ outcome: "not_permitted", cancelled: 0 }], error: null });
    expect((await post()).status).toBe(403);
  });

  it("refuses a cross-site request and a signed-out caller", async () => {
    expect((await post({}, { origin: "https://evil.example" })).status).toBe(403);
    state.identity = null;
    expect((await post()).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
