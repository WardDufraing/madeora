import type { Mock } from "vitest";

import { POST } from "./route";

interface State {
  identity: { userId: string } | null;
  decision: { data: unknown; error: unknown };
  rpc: Mock<(name: string, args: Record<string, unknown>) => void>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "staff-a" },
  decision: { data: "ok", error: null },
  rpc: vi.fn(),
}));

const CASE_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const NOTES = "Video call with ID; the Owner's family confirmed they are unreachable.";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => {
        state.rpc(name, args);
        return Promise.resolve(state.decision);
      },
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };

function post(body: unknown, recoveryId = CASE_ID): Promise<Response> {
  return POST(
    new Request(
      `https://madeora.example/api/v1/staff/ownership-recoveries/${recoveryId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...sameOrigin },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ recoveryId }) },
  );
}

beforeEach(() => {
  state.identity = { userId: "staff-a" };
  state.decision = { data: "ok", error: null };
  state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/staff/ownership-recoveries/{recoveryId}/decision", () => {
  it.each([
    ["start_review", ""],
    ["approve", NOTES],
    ["pause", NOTES],
    ["reject", NOTES],
    ["resume", ""],
  ])("%s asks the database, which notifies the people involved", async (action, notes) => {
    const response = await post({
      action,
      notes,
      formerOwnerOutcome: action === "approve" ? "member" : null,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notified: true });
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith(
      "staff_decide_ownership_recovery",
      expect.objectContaining({ p_recovery_id: CASE_ID, p_action: action }),
    );
  });

  it("sends the former Owner's outcome with an approval", async () => {
    await post({ action: "approve", notes: NOTES, formerOwnerOutcome: "removed" });
    expect(state.rpc).toHaveBeenCalledWith("staff_decide_ownership_recovery", {
      p_recovery_id: CASE_ID,
      p_action: "approve",
      p_notes: NOTES,
      p_former_owner_outcome: "removed",
    });
  });

  it("never reads the case, so no address passes through this request", async () => {
    await post({ action: "start_review", notes: "", formerOwnerOutcome: null });
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual(["staff_decide_ownership_recovery"]);
  });

  it("requires notes for approve, pause and reject, and an outcome for approve", async () => {
    const noNotes = await post({ action: "reject", notes: "", formerOwnerOutcome: null });
    expect(await noNotes.json()).toEqual({ error: "invalid", fields: ["notes"] });
    const noOutcome = await post({ action: "approve", notes: NOTES, formerOwnerOutcome: null });
    expect(await noOutcome.json()).toEqual({ error: "invalid", fields: ["formerOwnerOutcome"] });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["not_allowed", 409, "not-allowed"],
    ["owner_returned", 409, "owner-returned"],
    ["no_longer_valid", 409, "no-longer-valid"],
    ["not_found", 404, "not-found"],
  ])("maps %s", async (outcome, status, error) => {
    state.decision = { data: outcome, error: null };
    const response = await post({ action: "start_review", notes: "", formerOwnerOutcome: null });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("hides itself from non-staff and asks staff to sign in again", async () => {
    state.decision = { data: null, error: { code: "42501", hint: null } };
    expect(
      (await post({ action: "start_review", notes: "", formerOwnerOutcome: null })).status,
    ).toBe(404);
    state.decision = { data: null, error: { code: "42501", hint: "reauthenticate" } };
    const response = await post({ action: "start_review", notes: "", formerOwnerOutcome: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "reauthenticate" });
  });

  it("answers 404 for a malformed id", async () => {
    expect(
      (await post({ action: "start_review", notes: "", formerOwnerOutcome: null }, "x")).status,
    ).toBe(404);
  });
});
