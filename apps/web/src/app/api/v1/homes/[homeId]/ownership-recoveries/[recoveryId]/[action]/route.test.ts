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
const CASE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";

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

function post(action: string, body: unknown = {}, recoveryId = CASE_ID): Promise<Response> {
  return POST(
    request(`/api/v1/homes/${HOME_ID}/ownership-recoveries/${recoveryId}/${action}`, body),
    { params: Promise.resolve({ homeId: HOME_ID, recoveryId, action }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "member" };
  state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/ownership-recoveries/{recoveryId}/{action}", () => {
  it("withdraws the caller's request", async () => {
    state.rpc.mockReturnValue({ data: "withdrawn", error: null });
    expect((await post("withdraw")).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("withdraw_ownership_recovery", {
      p_home_id: HOME_ID,
      p_recovery_id: CASE_ID,
    });
  });

  it("accepts ownership when the database completes the handover", async () => {
    state.rpc.mockReturnValue({ data: "completed", error: null });
    expect((await post("accept")).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("accept_ownership_recovery", {
      p_home_id: HOME_ID,
      p_recovery_id: CASE_ID,
    });
  });

  it.each([
    ["not_ready", 409, "not-ready"],
    ["owner_returned", 409, "owner-returned"],
    ["no_longer_valid", 409, "no-longer-valid"],
    ["not_found", 404, "not-found"],
  ])("maps accept's %s", async (outcome, status, error) => {
    state.rpc.mockReturnValue({ data: outcome, error: null });
    const response = await post("accept");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("maps withdraw's already_decided", async () => {
    state.rpc.mockReturnValue({ data: "already_decided", error: null });
    expect((await post("withdraw")).status).toBe(409);
  });

  it("answers 404 for an unknown action or a malformed id", async () => {
    expect((await post("approve")).status).toBe(404);
    expect((await post("accept", {}, "not-a-uuid")).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses the Owner before the database", async () => {
    state.context = { status: "ok", role: "owner" };
    expect((await post("accept")).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 outside the Home and refuses a body with fields", async () => {
    expect((await post("accept", { force: true })).status).toBe(400);
    state.context = { status: "not-found" };
    expect((await post("accept")).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
