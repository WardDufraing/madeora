import type { Mock } from "vitest";

import { POST } from "./route";

interface State {
  identity: { userId: string } | null;
  decision: { data: unknown; error: unknown };
  caseRow: Record<string, unknown> | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => void>;
  send: Mock<(to: string, props: Record<string, unknown>, key: string) => string>;
}
const state = vi.hoisted((): State => ({
  identity: { userId: "staff-a" },
  decision: { data: "ok", error: null },
  caseRow: null,
  rpc: vi.fn(),
  send: vi.fn(),
}));

const HOME_ID = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
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
        if (name === "staff_ownership_recovery") {
          return Promise.resolve({ data: state.caseRow ? [state.caseRow] : [], error: null });
        }
        return Promise.resolve(state.decision);
      },
    }),
}));
vi.mock("@/email/send", () => ({
  sendOwnershipRecoveryEmail: (to: string, props: Record<string, unknown>, key: string) =>
    Promise.resolve(state.send(to, props, key)),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

function caseRow(state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CASE_ID,
    home_id: HOME_ID,
    home_name: "De Boomgaard",
    home_time_zone: "Europe/Brussels",
    state,
    created_at: "2026-10-01T10:00:00Z",
    statement: "x".repeat(60),
    staff_notes: null,
    former_owner_outcome: null,
    review_started_at: null,
    approved_at: null,
    objection_ends_at: state === "approved" ? "2026-10-29T16:00:00Z" : null,
    decided_at: null,
    owner_email: "owner@madeora.test",
    owner_locale: "nl",
    owner_last_sign_in_at: null,
    owner_seen_at: null,
    owner_is_owner: true,
    claimant_email: "claimant@madeora.test",
    claimant_name: "Dave",
    claimant_role: "member",
    claimant_member_since: "2026-08-01T10:00:00Z",
    member_count: 3,
    objections: [],
    appeals: [],
    ...overrides,
  };
}

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
  state.caseRow = null;
  state.rpc.mockReset();
  state.send.mockReset();
  state.send.mockReturnValue("sent");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/v1/staff/ownership-recoveries/{recoveryId}/decision", () => {
  it("starts the review and emails the Owner in their language", async () => {
    state.caseRow = caseRow("in_review");
    const response = await post({ action: "start_review", notes: "", formerOwnerOutcome: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ownerEmail: "sent" });
    expect(state.rpc).toHaveBeenCalledWith("staff_decide_ownership_recovery", {
      p_recovery_id: CASE_ID,
      p_action: "start_review",
      p_notes: "",
    });
    expect(state.send).toHaveBeenCalledWith(
      "owner@madeora.test",
      {
        kind: "review_started",
        locale: "nl",
        homeName: "De Boomgaard",
        url: `https://madeora.example/homes/${HOME_ID}`,
        objectionEndsAt: null,
        timeZone: "Europe/Brussels",
      },
      `ownership-recovery-${CASE_ID}-review`,
    );
  });

  it("approves with the former Owner's outcome and emails the end of the period", async () => {
    state.caseRow = caseRow("approved");
    const response = await post({ action: "approve", notes: NOTES, formerOwnerOutcome: "member" });
    expect(await response.json()).toEqual({ ownerEmail: "sent" });
    expect(state.rpc).toHaveBeenCalledWith("staff_decide_ownership_recovery", {
      p_recovery_id: CASE_ID,
      p_action: "approve",
      p_notes: NOTES,
      p_former_owner_outcome: "member",
    });
    const [, props, key] = state.send.mock.calls[0] ?? [];
    expect(props).toMatchObject({
      kind: "approved",
      objectionEndsAt: new Date("2026-10-29T16:00:00Z"),
    });
    expect(key).toBe(`ownership-recovery-${CASE_ID}-approved-2026-10-29T16:00:00Z`);
  });

  it("emails again when a paused approval resumes with a fresh period", async () => {
    state.caseRow = caseRow("approved");
    await post({ action: "resume", notes: "", formerOwnerOutcome: null });
    expect(state.send).toHaveBeenCalledOnce();
  });

  it("sends nothing for a pause, a reject or a resume back to review", async () => {
    state.caseRow = caseRow("in_review");
    for (const action of ["pause", "reject", "resume"]) {
      const response = await post({ action, notes: NOTES, formerOwnerOutcome: null });
      expect(await response.json()).toEqual({ ownerEmail: null });
    }
    expect(state.send).not.toHaveBeenCalled();
  });

  it("reports a failed email when the Owner's address is gone", async () => {
    state.caseRow = caseRow("in_review", { owner_email: null });
    const response = await post({ action: "start_review", notes: "", formerOwnerOutcome: null });
    expect(await response.json()).toEqual({ ownerEmail: "failed" });
    expect(state.send).not.toHaveBeenCalled();
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
  ])("maps %s and sends nothing", async (outcome, status, error) => {
    state.decision = { data: outcome, error: null };
    const response = await post({ action: "start_review", notes: "", formerOwnerOutcome: null });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(state.send).not.toHaveBeenCalled();
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
