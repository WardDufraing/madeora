import type { Mock } from "vitest";

import { POST } from "./route";

type Role = "owner" | "administrator" | "member";
type Capability = "manageHomeSettings" | "manageInvitations" | "removeMembers";
interface State {
  identity: { userId: string } | null;
  context:
    | { status: "ok"; role: Role; granted: Capability[] }
    | { status: "not-found" }
    | { status: "unavailable" };
  directory:
    | { status: "ok"; members: { membershipId: string; role: Role; isSelf: boolean }[] }
    | { status: "not-found" }
    | { status: "unavailable" };
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "user-a" },
  context: { status: "ok", role: "owner", granted: [] },
  directory: { status: "ok", members: [] },
  rpc: vi.fn(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const SELF = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const ADMIN = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0012";
const OWNER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0013";

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
        membership: {
          homeId,
          role: state.context.role,
          grantedCapabilities: new Set(state.context.granted),
        },
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

/** The caller (`SELF`) with `role`, and one member of each other role. */
function setCaller(role: Role, granted: Capability[] = []): void {
  state.context = { status: "ok", role, granted };
  state.directory = {
    status: "ok",
    members: [
      { membershipId: SELF, role, isSelf: true },
      ...(role === "owner" ? [] : [{ membershipId: OWNER, role: "owner" as const, isSelf: false }]),
      { membershipId: MEMBER, role: "member", isSelf: false },
      { membershipId: ADMIN, role: "administrator", isSelf: false },
    ],
  };
}

const TRANSFER_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";

function post(action: string, transferId = TRANSFER_ID, body: unknown = {}): Promise<Response> {
  return POST(
    new Request(
      `https://madeora.example/api/v1/homes/${HOME_ID}/ownership-transfers/${transferId}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...sameOrigin },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ homeId: HOME_ID, transferId, action }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  setCaller("member");
  state.rpc.mockReset();
  state.rpc.mockImplementation((name, args) => ({
    data:
      name === "cancel_ownership_transfer"
        ? "cancelled"
        : args.p_decision === "accept"
          ? "accepted"
          : "declined",
    error: null,
  }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/homes/{homeId}/ownership-transfers/{id}/{action}", () => {
  it.each([
    ["accept", "accepted"],
    ["decline", "declined"],
  ])("lets a member %s (the database checks they are the recipient)", async (action, outcome) => {
    const response = await post(action);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome });
    expect(state.rpc).toHaveBeenCalledWith("respond_to_ownership_transfer", {
      p_home_id: HOME_ID,
      p_transfer_id: TRANSFER_ID,
      p_decision: action,
    });
  });

  it("lets only the Owner cancel", async () => {
    expect((await post("cancel")).status).toBe(403);
    setCaller("owner");
    const response = await post("cancel");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "cancelled" });
    expect(state.rpc).toHaveBeenCalledWith("cancel_ownership_transfer", {
      p_home_id: HOME_ID,
      p_transfer_id: TRANSFER_ID,
    });
  });

  it.each([
    ["not_found", 404, "not-found"],
    ["already_decided", 409, "already-decided"],
    ["expired", 409, "expired"],
    ["no_longer_valid", 409, "no-longer-valid"],
  ])("maps the outcome %s", async (outcome, status, error) => {
    state.rpc.mockReturnValue({ data: outcome, error: null });
    const response = await post("accept");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("answers 404 for an unknown action or a malformed id", async () => {
    expect((await post("approve")).status).toBe(404);
    expect((await post("accept", "not-a-uuid")).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 outside the Home", async () => {
    state.context = { status: "not-found" };
    expect((await post("accept")).status).toBe(404);
  });

  it("refuses a body with fields", async () => {
    expect((await post("accept", TRANSFER_ID, { decision: "accept" })).status).toBe(400);
  });
});
