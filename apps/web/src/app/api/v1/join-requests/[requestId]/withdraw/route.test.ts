import type { Mock } from "vitest";

import { POST } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const REQUEST_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0004";

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

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function post(body: unknown = {}, headers: Record<string, string> = {}, requestId = REQUEST_ID) {
  return POST(
    new Request(`https://madeora.example/api/v1/join-requests/${requestId}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ requestId }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  state.rpc.mockImplementation(() => ({ data: "withdrawn", error: null }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/join-requests/{id}/withdraw", () => {
  it("withdraws the person's own request", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("withdraw_join_request", { p_request_id: REQUEST_ID });
  });

  it.each([
    ["not_pending", 409, "not-pending"],
    ["not_found", 404, "not-found"],
  ])("maps the outcome %s", async (outcome, status, error) => {
    state.rpc.mockImplementation(() => ({ data: outcome, error: null }));
    const response = await post();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("answers 404 for a malformed id", async () => {
    expect((await post({}, {}, "x")).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a body with fields", async () => {
    expect((await post({ applicantId: "x" })).status).toBe(400);
  });

  it("refuses a cross-site request (CSRF)", async () => {
    expect((await post({}, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("refuses a signed-out request", async () => {
    state.identity = null;
    expect((await post()).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
