import type { Mock } from "vitest";

import { DELETE } from "./route";
import { POST as dismiss } from "../suggestions/dismiss/route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const WIDGET_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0200";

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

function request(path: string, method: string, body: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1/dashboard/${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("DELETE /api/v1/dashboard/home-view", () => {
  it("ends only the caller's own view of the named Home", async () => {
    state.rpc.mockReturnValue({ data: "reset", error: null });
    const response = await DELETE(request("home-view", "DELETE", { homeId: HOME_ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reset: true });
    expect(state.rpc).toHaveBeenCalledWith("reset_dashboard_override", { p_home_id: HOME_ID });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("says when there was no view to end", async () => {
    state.rpc.mockReturnValue({ data: "nothing_to_reset", error: null });
    const response = await DELETE(request("home-view", "DELETE", { homeId: HOME_ID }));
    expect(await response.json()).toEqual({ reset: false });
  });

  it("answers 404 for a Home the person does not belong to", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    const response = await DELETE(request("home-view", "DELETE", { homeId: HOME_ID }));
    expect(response.status).toBe(404);
  });

  it("refuses a request from another origin before touching the database", async () => {
    const response = await DELETE(
      request(
        "home-view",
        "DELETE",
        { homeId: HOME_ID },
        {
          origin: "https://evil.example",
          host: "madeora.example",
        },
      ),
    );
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a malformed or extended body", async () => {
    for (const body of [{ homeId: "nope" }, { homeId: HOME_ID, userId: "someone-else" }, {}]) {
      const response = await DELETE(request("home-view", "DELETE", body));
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 401 when signed out", async () => {
    state.identity = null;
    const response = await DELETE(request("home-view", "DELETE", { homeId: HOME_ID }));
    expect(response.status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/dashboard/suggestions/dismiss", () => {
  it("remembers the dismissed widgets on the caller's own view", async () => {
    state.rpc.mockReturnValue({ data: "dismissed", error: null });
    const response = await dismiss(
      request("suggestions/dismiss", "POST", { homeId: HOME_ID, widgetIds: [WIDGET_ID] }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dismissed: true });
    expect(state.rpc).toHaveBeenCalledWith("dismiss_dashboard_suggestions", {
      p_home_id: HOME_ID,
      p_widget_ids: [WIDGET_ID],
    });
  });

  it("says when the person has no view of their own to remember it on", async () => {
    state.rpc.mockReturnValue({ data: "no_override", error: null });
    const response = await dismiss(
      request("suggestions/dismiss", "POST", { homeId: HOME_ID, widgetIds: [WIDGET_ID] }),
    );
    expect(await response.json()).toEqual({ dismissed: false });
  });

  it("answers 404 for a foreign Home and refuses empty, malformed or oversized lists", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    const foreign = await dismiss(
      request("suggestions/dismiss", "POST", { homeId: HOME_ID, widgetIds: [WIDGET_ID] }),
    );
    expect(foreign.status).toBe(404);
    state.rpc.mockReset();
    for (const widgetIds of [[], ["nope"], Array.from({ length: 41 }, () => WIDGET_ID)]) {
      const response = await dismiss(
        request("suggestions/dismiss", "POST", { homeId: HOME_ID, widgetIds }),
      );
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a request from another origin", async () => {
    const response = await dismiss(
      request(
        "suggestions/dismiss",
        "POST",
        { homeId: HOME_ID, widgetIds: [WIDGET_ID] },
        { origin: "https://evil.example", host: "madeora.example" },
      ),
    );
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
