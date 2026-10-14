import type { Mock } from "vitest";

import { PATCH } from "./route";

type Role = "owner" | "administrator" | "member";
interface State {
  identity: { userId: string } | null;
  context: { status: "ok"; role: Role } | { status: "not-found" } | { status: "unavailable" };
  update: Mock<(...args: unknown[]) => void>;
  result: { data: unknown; error: unknown };
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok", role: "owner" },
  update: vi.fn(),
  result: { data: null, error: null },
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";

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
      from: (table: string) => ({
        update: (changes: unknown) => ({
          eq: (column: string, value: unknown) => {
            state.update(table, changes, column, value);
            return { select: () => ({ maybeSingle: () => Promise.resolve(state.result) }) };
          },
        }),
      }),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function patch(body: unknown, homeId = HOME_ID, headers: Record<string, string> = {}) {
  return PATCH(
    new Request(`https://madeora.example/api/v1/homes/${homeId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "owner" };
  state.update.mockReset();
  state.result = { data: { id: HOME_ID, name: "Kot", timezone: "Europe/Paris" }, error: null };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("PATCH /api/v1/homes/{homeId}", () => {
  it("lets the Owner change the name and timezone, written for exactly this Home", async () => {
    const response = await patch({ name: " Kot ", timeZone: "europe/paris" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      home: { id: HOME_ID, name: "Kot", timeZone: "Europe/Paris" },
    });
    expect(state.update).toHaveBeenCalledWith(
      "homes",
      { name: "Kot", timezone: "Europe/Paris" },
      "id",
      HOME_ID,
    );
  });

  it("writes only the fields in the change", async () => {
    await patch({ timeZone: "UTC" });
    expect(state.update).toHaveBeenCalledWith("homes", { timezone: "UTC" }, "id", HOME_ID);
  });

  it.each<Role>(["administrator", "member"])(
    "refuses a %s without the capability, without writing",
    async (role) => {
      state.context = { status: "ok", role };
      const response = await patch({ name: "Kot" });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "not-permitted" });
      expect(state.update).not.toHaveBeenCalled();
    },
  );

  it("answers 404 for a Home the person does not belong to, as for one that does not exist", async () => {
    state.context = { status: "not-found" };
    const response = await patch({ name: "Kot" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not-found" });
    expect(state.update).not.toHaveBeenCalled();
  });

  it("answers 500 when the membership cannot be read", async () => {
    state.context = { status: "unavailable" };
    expect((await patch({ name: "Kot" })).status).toBe(500);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("answers 403 when RLS refuses the row after the check (role changed in between)", async () => {
    state.result = { data: null, error: null };
    expect((await patch({ name: "Kot" })).status).toBe(403);
  });

  it("refuses a cross-site request (CSRF)", async () => {
    const response = await patch({ name: "Kot" }, HOME_ID, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request", async () => {
    state.identity = null;
    expect((await patch({ name: "Kot" })).status).toBe(401);
    expect(state.update).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty change", {}],
    ["a role change", { role: "owner" }],
    ["a different Home id in the body", { name: "Kot", id: "x" }],
    ["an invisible name", { name: "Thu\u{200E}is" }],
    ["not JSON", "{"],
  ])("refuses %s", async (_, body) => {
    expect((await patch(body)).status).toBe(400);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("treats a value the database refuses as invalid input", async () => {
    state.result = { data: null, error: { code: "23514", message: "check" } };
    expect((await patch({ name: "Kot" })).status).toBe(400);
  });
});
