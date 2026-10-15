import type { Mock } from "vitest";

import { PATCH } from "./route";

type Role = "owner" | "administrator" | "member";
interface State {
  identity: { userId: string } | null;
  context: { status: "ok"; role: Role } | { status: "not-found" } | { status: "unavailable" };
  directory:
    | { status: "ok"; members: { membershipId: string; role: Role; isSelf: boolean }[] }
    | { status: "not-found" }
    | { status: "unavailable" };
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok", role: "owner" },
  directory: { status: "ok", members: [] },
  rpc: vi.fn(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const SELF = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const ADMIN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0012";

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
vi.mock("@/members/directory", () => ({
  getHomeDirectory: () => Promise.resolve(state.directory),
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

function patch(
  body: unknown,
  headers: Record<string, string> = {},
  membershipId = MEMBER,
): Promise<Response> {
  return PATCH(
    new Request(`https://madeora.example/api/v1/homes/${HOME_ID}/members/${membershipId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...sameOrigin, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ homeId: HOME_ID, membershipId }) },
  );
}

const promote = { role: "administrator", expectedRole: "member" };

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.context = { status: "ok", role: "owner" };
  state.directory = {
    status: "ok",
    members: [
      { membershipId: SELF, role: "owner", isSelf: true },
      { membershipId: MEMBER, role: "member", isSelf: false },
      { membershipId: ADMIN, role: "administrator", isSelf: false },
    ],
  };
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: "ok", error: null });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("PATCH /api/v1/homes/{homeId}/members/{membershipId}", () => {
  it("lets the Owner promote a Member, passing the role they saw", async () => {
    const response = await patch(promote);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ role: "administrator" });
    expect(state.rpc).toHaveBeenCalledWith("change_home_member_role", {
      p_home_id: HOME_ID,
      p_membership_id: MEMBER,
      p_role: "administrator",
      p_expected_role: "member",
    });
  });

  it("treats an unchanged role as success", async () => {
    state.rpc.mockReturnValue({ data: "unchanged", error: null });
    expect((await patch(promote)).status).toBe(200);
  });

  it.each<[unknown, string]>([
    [{ role: "owner", expectedRole: "member" }, "owner is never assignable"],
    [{ role: "administrator" }, "the expected role is required"],
    [{ ...promote, extra: true }, "unknown fields are refused"],
    [{ role: "admin", expectedRole: "member" }, "unknown roles are refused"],
  ])("refuses %j (%s)", async (body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request before reading anything", async () => {
    const response = await patch(promote, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });

  it("refuses a body that is not JSON", async () => {
    expect((await patch(promote, { "content-type": "text/plain" })).status).toBe(415);
  });

  it("refuses a signed-out caller", async () => {
    state.identity = null;
    expect((await patch(promote)).status).toBe(401);
  });

  it("answers 404 for a Home the caller does not belong to", async () => {
    state.context = { status: "not-found" };
    expect((await patch(promote)).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for a membership that is not in this Home", async () => {
    const response = await patch(promote, {}, "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0099");
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each<Role>(["administrator", "member"])("refuses a %s (Owner-only power)", async (role) => {
    state.context = { status: "ok", role };
    expect((await patch(promote)).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses the Owner changing their own role", async () => {
    const response = await patch({ role: "member", expectedRole: "member" }, {}, SELF);
    expect(response.status).toBe(403);
  });

  it.each([
    ["stale", 409, "stale"],
    ["not_found", 404, "not-found"],
    ["not_permitted", 403, "not-permitted"],
  ])("maps the database outcome %s", async (outcome, status, error) => {
    state.rpc.mockReturnValue({ data: outcome, error: null });
    const response = await patch(promote);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("logs a database failure by its code only", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "XX000" } });
    const response = await patch(promote);
    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({ event: "members.role_change_failed", code: "XX000" }),
    );
  });

  it("answers 500 when the members cannot be read", async () => {
    state.directory = { status: "unavailable" };
    expect((await patch(promote)).status).toBe(500);
  });
});
