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

const REASON = "I spoke with the Owner yesterday; they still use the Home.";

function post(body: unknown): Promise<Response> {
  return POST(request(`/api/v1/homes/${HOME_ID}/ownership-recoveries/objections`, body), {
    params: Promise.resolve({ homeId: HOME_ID }),
  });
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "member" };
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: "objected", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/ownership-recoveries/objections", () => {
  it.each<Role>(["owner", "administrator", "member"])("lets a %s object", async (role) => {
    state.context = { status: "ok", role };
    expect((await post({ reason: REASON })).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("object_to_ownership_recovery", {
      p_home_id: HOME_ID,
      p_reason: REASON,
    });
  });

  it("answers 409 when nothing is open", async () => {
    state.rpc.mockReturnValue({ data: "nothing_open", error: null });
    const response = await post({ reason: REASON });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "nothing-open" });
  });

  it("refuses a too short reason", async () => {
    const response = await post({ reason: "No." });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid", fields: ["reason"] });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 outside the Home", async () => {
    state.context = { status: "not-found" };
    expect((await post({ reason: REASON })).status).toBe(404);
  });
});
