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

const REASON = "I never lost access; I was travelling and did not see the emails in time.";

function post(body: unknown, recoveryId = CASE_ID): Promise<Response> {
  return POST(request(`/api/v1/me/ownership-recoveries/${recoveryId}/appeal`, body), {
    params: Promise.resolve({ recoveryId }),
  });
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: "appealed", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/me/ownership-recoveries/{recoveryId}/appeal", () => {
  it("records the appeal", async () => {
    expect((await post({ reason: REASON })).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("appeal_ownership_recovery", {
      p_recovery_id: CASE_ID,
      p_reason: REASON,
    });
  });

  it.each([
    ["already_open", 409, "already-open"],
    ["not_found", 404, "not-found"],
  ])("maps %s", async (outcome, status, error) => {
    state.rpc.mockReturnValue({ data: outcome, error: null });
    const response = await post({ reason: REASON });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("answers 404 for a malformed id and 400 for a short reason", async () => {
    expect((await post({ reason: REASON }, "x")).status).toBe(404);
    expect((await post({ reason: "short" })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 401 when signed out", async () => {
    state.identity = null;
    expect((await post({ reason: REASON })).status).toBe(401);
  });
});
