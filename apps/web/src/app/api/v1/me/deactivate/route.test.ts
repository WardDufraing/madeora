import type { Mock } from "vitest";

import { POST } from "./route";

const state = vi.hoisted(
  (): {
    identity: { userId: string } | null;
    rpc: Mock<(name: string, args?: Record<string, unknown>) => { data: unknown; error: unknown }>;
    deleted: string[];
  } => ({ identity: { userId: "user-a" }, rpc: vi.fn(), deleted: [] }),
);

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
  getAuthState: () => Promise.resolve({ kind: state.identity ? "signed-in" : "signed-out" }),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      getAll: () => [
        { name: "sb-proj-auth-token" },
        { name: "sb-proj-auth-token.0" },
        { name: "theme" },
      ],
      delete: (name: string) => {
        state.deleted.push(name);
      },
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

function post(body: unknown, origin = "https://madeora.example"): Promise<Response> {
  return POST(
    new Request("https://madeora.example/api/v1/me/deactivate", {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: "madeora.example" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.deleted = [];
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: null, error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/me/deactivate", () => {
  it("deactivates the account and drops only this browser's session cookies", async () => {
    const response = await post({});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.rpc).toHaveBeenCalledWith("deactivate_my_account", undefined);
    expect(state.deleted).toEqual(["sb-proj-auth-token", "sb-proj-auth-token.0"]);
  });

  it("refuses a cross-site request, a signed-out caller and extra fields before the database", async () => {
    expect((await post({}, "https://evil.example")).status).toBe(403);
    expect((await post({ userId: "user-b" })).status).toBe(400);
    state.identity = null;
    expect((await post({})).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.deleted).toEqual([]);
  });

  it("answers 403 without fresh re-authentication and 409 for a sole Owner, keeping the session", async () => {
    state.rpc.mockReturnValueOnce({
      data: null,
      error: { code: "42501", hint: "reauthentication_required" },
    });
    const reauth = await post({});
    expect(reauth.status).toBe(403);
    expect(await reauth.json()).toEqual({ error: "reauthentication-required" });
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "P0001", hint: "sole_owner" } });
    const owner = await post({});
    expect(owner.status).toBe(409);
    expect(await owner.json()).toEqual({ error: "sole-owner" });
    expect(state.deleted).toEqual([]);
  });

  it("answers 500 for an unknown database error and logs only its code", async () => {
    state.rpc.mockReturnValueOnce({
      data: null,
      error: { code: "XX000", message: "secret detail" },
    });
    expect((await post({})).status).toBe(500);
    const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(logged).toEqual([JSON.stringify({ event: "account.deactivate_failed", code: "XX000" })]);
    expect(state.deleted).toEqual([]);
  });
});
