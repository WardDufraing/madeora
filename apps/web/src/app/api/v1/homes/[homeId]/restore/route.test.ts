import type { Mock } from "vitest";

import { POST } from "./route";

const state = vi.hoisted(
  (): {
    identity: { userId: string } | null;
    rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
  } => ({ identity: { userId: "user-a" }, rpc: vi.fn() }),
);

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
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

function post(homeId = HOME_ID, origin = "https://madeora.example"): Promise<Response> {
  return POST(
    new Request(`https://madeora.example/api/v1/homes/${homeId}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: "madeora.example" },
      body: "{}",
    }),
    { params: Promise.resolve({ homeId }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: null, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/restore", () => {
  it("restores the Home", async () => {
    expect((await post()).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("restore_home", { p_home_id: HOME_ID });
  });

  it("answers 404 for a malformed id or a Home the caller does not own", async () => {
    expect((await post("not-a-uuid")).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "42501" } });
    expect((await post()).status).toBe(404);
  });

  it("answers 410 after the deadline and 403 without a fresh confirmation", async () => {
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "P0001", hint: "expired" } });
    expect((await post()).status).toBe(410);
    state.rpc.mockReturnValueOnce({
      data: null,
      error: { code: "42501", hint: "reauthentication_required" },
    });
    expect((await post()).status).toBe(403);
  });

  it("refuses cross-site requests", async () => {
    expect((await post(HOME_ID, "https://evil.example")).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
