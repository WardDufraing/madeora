import type * as ManageServer from "@/members/manage-server";

import { POST } from "./route";

/**
 * The Home's display settings (UX8a): same-origin JSON from a signed-in manager, one of the offered
 * timings only, and the database's answer mapped to HTTP.
 */

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const state = vi.hoisted(() => ({ identity: true, allowed: true }));
const rpc = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity ? { userId: "user" } : null),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () => Promise.resolve({ rpc }),
}));
vi.mock("@/members/manage-server", async (importOriginal) => {
  const original = await importOriginal<typeof ManageServer>();
  return {
    ...original,
    requireHomeAction: (homeId: string, action: string) =>
      Promise.resolve(
        state.allowed && action === "home.updateSettings"
          ? { ok: true, context: { home: { id: homeId } } }
          : { ok: false, response: original.failure(403, "not-permitted") },
      ),
  };
});
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = {
  origin: "https://madeora.example",
  host: "madeora.example",
  "content-type": "application/json",
};

const COUNTS = { ambientShowChores: true, ambientShowShopping: false };

function save(body: unknown, headers: Record<string, string> = sameOrigin) {
  return POST(
    new Request(`https://madeora.example/api/v1/homes/${HOME}/displays/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId: HOME }) },
  );
}

beforeEach(() => {
  state.identity = true;
  state.allowed = true;
  rpc.mockReset().mockResolvedValue({ data: "saved", error: null });
});

describe("POST /api/v1/homes/{homeId}/displays/settings", () => {
  it("saves one of the offered timings and the ambient counts for the Home", async () => {
    expect((await save({ ...COUNTS, ambientAfterSeconds: 600 })).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("save_home_display_ambient", {
      p_home_id: HOME,
      p_ambient_after_seconds: 600,
      p_show_chores: true,
      p_show_shopping: false,
    });
  });

  it("refuses any other timing or field", async () => {
    expect((await save({ ...COUNTS, ambientAfterSeconds: 45 })).status).toBe(400);
    expect((await save({ ...COUNTS, ambientAfterSeconds: 300, homeId: HOME })).status).toBe(400);
    expect((await save({ ambientAfterSeconds: 300 })).status).toBe(400);
    expect(
      (await save({ ambientAfterSeconds: 300, ambientShowChores: 1, ambientShowShopping: false }))
        .status,
    ).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a visitor, a non-manager and a cross-site request", async () => {
    state.identity = false;
    expect((await save({ ...COUNTS, ambientAfterSeconds: 300 })).status).toBe(401);
    state.identity = true;
    state.allowed = false;
    expect((await save({ ...COUNTS, ambientAfterSeconds: 300 })).status).toBe(403);
    state.allowed = true;
    expect(
      (
        await save(
          { ...COUNTS, ambientAfterSeconds: 300 },
          { ...sameOrigin, origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps the database's refusals", async () => {
    rpc.mockResolvedValueOnce({ data: "not_permitted", error: null });
    expect((await save({ ...COUNTS, ambientAfterSeconds: 300 })).status).toBe(403);
    rpc.mockResolvedValueOnce({ data: "not_found", error: null });
    expect((await save({ ...COUNTS, ambientAfterSeconds: 300 })).status).toBe(404);
  });
});
