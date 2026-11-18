// S41-L4: adding a child asks the permission engine first (any adult member for themselves; the
// Owner or someone who may manage invitations for another adult). The database decides again.
import type { Mock } from "vitest";

import { DEFAULT_ACCENT } from "@/accent/accent";

import { POST } from "./route";

type Role = "owner" | "administrator" | "member";
interface Member {
  membershipId: string;
  role: Role;
  isSelf: boolean;
  isChild?: boolean;
  isInactive?: boolean;
}
interface State {
  role: Role;
  granted: string[];
  members: Member[];
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ role: "member", granted: [], members: [], rpc: vi.fn() }));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const SELF = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0010";
const OTHER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0011";
const CHILD = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0012";
const REQUEST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve({ userId: "user-a" }),
}));
vi.mock("@/homes/server", () => ({
  getHomeContext: (homeId: string) =>
    Promise.resolve({
      status: "ok",
      context: {
        home: { id: homeId, name: "Thuis", timeZone: "Europe/Brussels" },
        membership: { homeId, role: state.role, grantedCapabilities: new Set(state.granted) },
      },
    }),
}));
vi.mock("@/members/directory", () => ({
  getHomeDirectory: () => Promise.resolve({ status: "ok", members: state.members }),
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

function setCaller(role: Role, granted: string[] = [], self: Partial<Member> = {}): void {
  state.role = role;
  state.granted = granted;
  state.members = [
    { membershipId: SELF, role, isSelf: true, ...self },
    { membershipId: OTHER, role: "member", isSelf: false },
    { membershipId: CHILD, role: "member", isSelf: false, isChild: true },
  ];
}

function post(guardian: string, accentColor: string | null = "#3366cc"): Promise<Response> {
  return POST(
    new Request(`https://madeora.example/api/v1/homes/${HOME_ID}/children`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://madeora.example",
        host: "madeora.example",
      },
      body: JSON.stringify({
        name: "Mila",
        primaryGuardianMembershipId: guardian,
        ageBand: null,
        ...(accentColor === null ? {} : { accentColor }),
        requestId: REQUEST,
      }),
    }),
    { params: Promise.resolve({ homeId: HOME_ID }) },
  );
}

beforeEach(() => {
  setCaller("member");
  state.rpc.mockReset();
  state.rpc.mockReturnValue({ data: [{ outcome: "created", membership_id: CHILD }], error: null });
});

describe("POST /api/v1/homes/{homeId}/children", () => {
  it("lets a member add a child they guard themselves", async () => {
    const response = await post(SELF);
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith(
      "create_child",
      expect.objectContaining({ p_home_id: HOME_ID, p_primary_guardian_membership_id: SELF }),
    );
  });

  it("needs only a name and a guardian: the accent colour falls back to the default (S41-L2)", async () => {
    expect((await post(SELF, null)).status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith(
      "create_child",
      expect.objectContaining({ p_accent_color: DEFAULT_ACCENT }),
    );
    state.rpc.mockClear();
    expect((await post(SELF)).status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith(
      "create_child",
      expect.objectContaining({ p_accent_color: "#3366cc" }),
    );
  });

  it("refuses a member or an Administrator without invitation rights naming another adult", async () => {
    expect((await post(OTHER)).status).toBe(403);
    setCaller("administrator");
    expect((await post(OTHER)).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("lets the Owner and an Administrator who may manage invitations name another adult", async () => {
    setCaller("owner");
    expect((await post(OTHER)).status).toBe(201);
    setCaller("administrator", ["manageInvitations"]);
    expect((await post(OTHER)).status).toBe(201);
  });

  it("refuses a child or a deactivated account before the database is asked", async () => {
    setCaller("owner", [], { isChild: true });
    expect((await post(SELF)).status).toBe(403);
    setCaller("owner", [], { isInactive: true });
    expect((await post(SELF)).status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
