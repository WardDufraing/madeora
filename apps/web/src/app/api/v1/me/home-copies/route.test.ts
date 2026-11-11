import type { Mock } from "vitest";

import { POST as decide } from "../../home-copies/[requestId]/decision/route";
import { POST as cancel } from "./[requestId]/cancel/route";
import { POST as cancelPending } from "./cancel-pending/route";
import { POST as request } from "./route";

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

const ITEM = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f01";
const HOME_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f02";
const HOME_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0f03";
const REQUEST = "5d2a7c41-8b3e-4f9a-a1c2-3e4f5a6b7c8d";

function req(path: string, body: unknown, origin = "https://madeora.example"): Request {
  return new Request(`https://madeora.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: "madeora.example" },
    body: JSON.stringify(body),
  });
}

function ctx(requestId: string) {
  return { params: Promise.resolve({ requestId }) };
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/me/home-copies", () => {
  const body = { itemType: "recipe", itemId: ITEM, homeIds: [HOME_A, HOME_B] };

  it("asks for copies and answers per Home", async () => {
    const homes = [
      { homeId: HOME_A, outcome: "completed", code: null },
      { homeId: HOME_B, outcome: "pending", code: null },
    ];
    state.rpc.mockReturnValueOnce({ data: { homes }, error: null });
    const response = await request(req("/api/v1/me/home-copies", body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ homes });
    expect(state.rpc).toHaveBeenCalledWith("request_home_copies", {
      p_item_type: "recipe",
      p_item_id: ITEM,
      p_home_ids: [HOME_A, HOME_B],
    });
  });

  it("refuses bad input, cross-site and signed out before the database", async () => {
    const path = "/api/v1/me/home-copies";
    expect((await request(req(path, { ...body, itemType: "task" }))).status).toBe(400);
    expect((await request(req(path, { ...body, homeIds: [] }))).status).toBe(400);
    expect((await request(req(path, { ...body, homeIds: [HOME_A, HOME_A] }))).status).toBe(400);
    expect((await request(req(path, { ...body, ownerId: "x" }))).status).toBe(400);
    expect((await request(req(path, body, "https://evil.example"))).status).toBe(403);
    state.identity = null;
    expect((await request(req(path, body))).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for someone else's item and 429 over the limit", async () => {
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "P0002" } });
    expect((await request(req("/api/v1/me/home-copies", body))).status).toBe(404);
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "54000" } });
    expect((await request(req("/api/v1/me/home-copies", body))).status).toBe(429);
  });
});

describe("cancelling copy requests", () => {
  it("cancels one own pending request; a forged id is not found", async () => {
    state.rpc.mockReturnValueOnce({ data: true, error: null });
    const response = await cancel(
      req(`/api/v1/me/home-copies/${REQUEST}/cancel`, {}),
      ctx(REQUEST),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
    expect(state.rpc).toHaveBeenCalledWith("cancel_home_copy", { p_request_id: REQUEST });
    expect((await cancel(req("/api/v1/me/home-copies/x/cancel", {}), ctx("x"))).status).toBe(404);
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it("cancels every pending request before account deletion", async () => {
    state.rpc.mockReturnValueOnce({ data: 2, error: null });
    const response = await cancelPending(req("/api/v1/me/home-copies/cancel-pending", {}));
    expect(await response.json()).toEqual({ cancelled: 2 });
    expect(state.rpc).toHaveBeenCalledWith("cancel_my_pending_home_copies", undefined);
    expect(
      (await cancelPending(req("/api/v1/me/home-copies/cancel-pending", { all: true }))).status,
    ).toBe(400);
  });
});

describe("POST /api/v1/home-copies/[requestId]/decision", () => {
  it("approves or rejects and answers the outcome", async () => {
    state.rpc.mockReturnValueOnce({ data: "completed", error: null });
    const path = `/api/v1/home-copies/${REQUEST}/decision`;
    const response = await decide(req(path, { approve: true }), ctx(REQUEST));
    expect(await response.json()).toEqual({ outcome: "completed" });
    expect(state.rpc).toHaveBeenCalledWith("decide_home_copy", {
      p_request_id: REQUEST,
      p_approve: true,
    });
  });

  it("answers 404 for a non-approver or a forged id, 400 for a bad body", async () => {
    const path = `/api/v1/home-copies/${REQUEST}/decision`;
    state.rpc.mockReturnValueOnce({ data: null, error: { code: "P0002" } });
    expect((await decide(req(path, { approve: false }), ctx(REQUEST))).status).toBe(404);
    expect((await decide(req(path, { approve: "yes" }), ctx(REQUEST))).status).toBe(400);
    expect((await decide(req(path, { approve: true }), ctx("nope"))).status).toBe(404);
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
});
