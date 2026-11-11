import type { Mock } from "vitest";

import { POST } from "./route";

const state = vi.hoisted(
  (): {
    identity: { userId: string } | null;
    rpc: Mock<(name: string, args?: Record<string, unknown>) => { data: unknown; error: unknown }>;
  } => ({ identity: { userId: "user-a" }, rpc: vi.fn() }),
);

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const REQUEST = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";

function post(body: unknown, origin = "https://madeora.example"): Promise<Response> {
  return POST(
    new Request("https://madeora.example/api/v1/me/personal-data/delete", {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: "madeora.example" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  state.rpc.mockReturnValue({
    data: { status: "completed", results: { recipes: { outcome: "deleted", count: 2 } } },
    error: null,
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/me/personal-data/delete", () => {
  it.each(["DELETE", "VERWIJDER"])(
    "deletes the chosen categories with %s",
    async (confirmation) => {
      const response = await post({ requestId: REQUEST, categories: ["recipes"], confirmation });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: "completed",
        results: { recipes: { outcome: "deleted", count: 2 } },
      });
      expect(state.rpc).toHaveBeenCalledWith("delete_personal_data", {
        p_request_id: REQUEST,
        p_categories: ["recipes"],
      });
    },
  );

  it("refuses a wrong word, no or unknown categories, cross-site, or signed out", async () => {
    const valid = { requestId: REQUEST, categories: ["recipes"], confirmation: "DELETE" };
    expect((await post({ ...valid, confirmation: "delete" })).status).toBe(400);
    expect((await post({ ...valid, categories: [] })).status).toBe(400);
    expect((await post({ ...valid, categories: ["account"] })).status).toBe(400);
    expect((await post({ ...valid, categories: ["recipes", "recipes"] })).status).toBe(400);
    expect((await post({ ...valid, requestId: "nope" })).status).toBe(400);
    expect((await post({ ...valid, userId: "user-b" })).status).toBe(400);
    expect((await post(valid, "https://evil.example")).status).toBe(403);
    state.identity = null;
    expect((await post(valid)).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("asks to confirm it's you again, and maps a busy request", async () => {
    const valid = { requestId: REQUEST, categories: ["media"], confirmation: "DELETE" };
    state.rpc.mockReturnValueOnce({
      data: null,
      error: { code: "42501", hint: "reauthentication_required" },
    });
    const reauth = await post(valid);
    expect(reauth.status).toBe(403);
    expect(await reauth.json()).toEqual({ error: "reauthentication-required" });
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "XX000" } });
    expect((await post(valid)).status).toBe(500);
  });
});
