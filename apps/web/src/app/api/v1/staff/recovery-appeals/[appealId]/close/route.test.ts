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

const APPEAL_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const NOTES = "Called the former Owner; the recovery stands. Explained the transfer route.";

function post(body: unknown, appealId = APPEAL_ID): Promise<Response> {
  return POST(request(`/api/v1/staff/recovery-appeals/${appealId}/close`, body), {
    params: Promise.resolve({ appealId }),
  });
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: "closed", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/staff/recovery-appeals/{appealId}/close", () => {
  it("closes the appeal", async () => {
    expect((await post({ notes: NOTES })).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("staff_close_recovery_appeal", {
      p_appeal_id: APPEAL_ID,
      p_notes: NOTES,
    });
  });

  it("hides itself from non-staff", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", hint: null } });
    expect((await post({ notes: NOTES })).status).toBe(404);
  });

  it("asks staff to sign in again after 15 minutes", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", hint: "reauthenticate" } });
    const response = await post({ notes: NOTES });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "reauthenticate" });
  });

  it("answers 404 for a closed or unknown appeal and refuses short notes", async () => {
    state.rpc.mockReturnValue({ data: "not_found", error: null });
    expect((await post({ notes: NOTES })).status).toBe(404);
    expect((await post({ notes: "ok" })).status).toBe(400);
  });
});
