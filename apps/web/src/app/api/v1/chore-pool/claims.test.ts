// S21: the pool, claim, release, policy, settings and reassignment routes. The database decides
// first-come claims, eligibility, expiry and request rules (tests/db/rls/chore-pool.test.sql and
// chore-pool-concurrency.test.ts); these tests check what the routes send it and how they answer.
import type { Mock } from "vitest";

import { GET as claimState, POST as claim } from "../chore-occurrences/[occurrenceId]/claim/route";
import { POST as requestHandover } from "../chore-occurrences/[occurrenceId]/reassignment-requests/route";
import { POST as release } from "../chore-occurrences/[occurrenceId]/release/route";
import { PATCH as answer } from "../chore-reassignment-requests/[requestId]/route";
import { GET as listRequests } from "../chore-reassignment-requests/route";
import { GET as readSettings, PATCH as updateSettings } from "../chore-settings/route";
import { GET as readPolicy, PUT as setPolicy } from "../chores/[choreId]/claim-policy/route";
import { GET as readPool } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const CHORE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0015";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const MEMBER_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const MEMBER_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const REQUEST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0060";

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
const crossSite = { origin: "https://evil.example", host: "madeora.example" };

function request(path: string, method: string, body?: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = <K extends string>(key: K, value: string) => ({
  params: Promise.resolve({ [key]: value } as Record<K, string>),
});
const occurrence = params("occurrenceId", OCCURRENCE);
const chore = params("choreId", CHORE);
const handover = params("requestId", REQUEST);

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("claiming", () => {
  const path = `/chore-occurrences/${OCCURRENCE}/claim`;

  it("claims with the occurrence id only", async () => {
    answers({
      claim_chore_occurrence: [
        { outcome: "claimed", revision: 3, claimed_by_me: true, claimant_member: MEMBER_A },
      ],
    });
    const response = await claim(request(path, "POST", {}), occurrence);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "claimed", revision: 3 });
    expect(state.rpc).toHaveBeenCalledWith("claim_chore_occurrence", {
      p_occurrence_id: OCCURRENCE,
    });
  });

  it("tells the loser of a race who has it", async () => {
    answers({
      claim_chore_occurrence: [
        {
          outcome: "already_claimed",
          revision: 3,
          claimed_by_me: false,
          claimant_member: MEMBER_B,
        },
      ],
    });
    const response = await claim(request(path, "POST", {}), occurrence);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "already-claimed",
      claimedByMe: false,
      claimant: MEMBER_B,
    });
  });

  it("answers every refusal with its own code", async () => {
    const cases: [string, number, string][] = [
      ["assigned", 409, "assigned"],
      ["not_claimable", 409, "not-claimable"],
      ["not_eligible", 403, "not-eligible"],
      ["expired", 409, "expired"],
      ["pending_approval", 409, "pending-approval"],
      ["already_completed", 409, "already-completed"],
      ["already_skipped", 409, "already-skipped"],
      ["not_found", 404, "not-found"],
    ];
    for (const [outcome, status, error] of cases) {
      answers({
        claim_chore_occurrence: [
          { outcome, revision: null, claimed_by_me: false, claimant_member: null },
        ],
      });
      const response = await claim(request(path, "POST", {}), occurrence);
      expect(response.status, outcome).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });

  it("refuses cross-site requests, signed-out people, extra fields and malformed ids", async () => {
    expect((await claim(request(path, "POST", {}, crossSite), occurrence)).status).toBe(403);
    expect((await claim(request(path, "POST", { userId: "x" }), occurrence)).status).toBe(400);
    expect((await claim(request(path, "POST", {}), params("occurrenceId", "nope"))).status).toBe(
      404,
    );
    state.identity = null;
    expect((await claim(request(path, "POST", {}), occurrence)).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("reads the claim state, or answers not found when it is not the viewer's to see", async () => {
    const claimState_ = {
      claimMode: "selected",
      expiryPolicy: "week_end",
      autoReleaseHours: 24,
      claimable: false,
      block: "not_eligible",
      claimedBy: null,
      claimedAt: null,
      canRelease: false,
      releaseAt: null,
      closesOn: "2026-10-26",
      expiredAt: null,
      canRequest: false,
      canRequestForOthers: false,
      confirmationRequired: false,
      requests: [],
    };
    answers({ get_chore_claim_state: claimState_ });
    const response = await claimState(request(path, "GET"), occurrence);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ claim: claimState_ });
    answers({ get_chore_claim_state: null });
    expect((await claimState(request(path, "GET"), occurrence)).status).toBe(404);
    answers({ get_chore_claim_state: { ...claimState_, block: "gossip" } });
    expect((await claimState(request(path, "GET"), occurrence)).status).toBe(500);
  });
});

describe("releasing", () => {
  const path = `/chore-occurrences/${OCCURRENCE}/release`;

  it("sends whether it is the Undo, and answers the status afterwards", async () => {
    answers({
      release_chore_occurrence: [{ outcome: "released", status: "expired", revision: 4 }],
    });
    const response = await release(request(path, "POST", { undo: true }), occurrence);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "released", status: "expired", revision: 4 });
    expect(state.rpc).toHaveBeenCalledWith("release_chore_occurrence", {
      p_occurrence_id: OCCURRENCE,
      p_undo: true,
    });
    await release(request(path, "POST", {}), occurrence);
    expect(state.rpc.mock.calls[1]?.[1]).toEqual({ p_occurrence_id: OCCURRENCE, p_undo: false });
  });

  it("answers a retry, a submitted chore and someone else's claim", async () => {
    const cases: [string, number, string][] = [
      ["not_claimed", 409, "not-claimed"],
      ["pending_approval", 409, "pending-approval"],
      ["occurrence_closed", 409, "occurrence-closed"],
      ["not_permitted", 403, "not-permitted"],
    ];
    for (const [outcome, status, error] of cases) {
      answers({ release_chore_occurrence: [{ outcome, status: null, revision: null }] });
      const response = await release(request(path, "POST", {}), occurrence);
      expect(response.status, outcome).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
  });
});

describe("the pool", () => {
  it("reads the week holding a date, or today's", async () => {
    answers({ list_chore_pool: [] });
    const response = await readPool(request(`/chore-pool?homeId=${HOME}&date=2026-10-26`, "GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pool: { rows: [], weekStart: null, today: null, truncated: false },
    });
    expect(state.rpc).toHaveBeenCalledWith("list_chore_pool", {
      p_home_id: HOME,
      p_date: "2026-10-26",
    });
    await readPool(request(`/chore-pool?homeId=${HOME}`, "GET"));
    expect(state.rpc.mock.calls[1]?.[1]).toEqual({ p_home_id: HOME });
  });

  it("refuses a bad query and answers not found for a Home the person is not in", async () => {
    expect((await readPool(request(`/chore-pool?homeId=x`, "GET"))).status).toBe(400);
    expect(
      (await readPool(request(`/chore-pool?homeId=${HOME}&date=2026-13-01`, "GET"))).status,
    ).toBe(400);
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await readPool(request(`/chore-pool?homeId=${HOME}`, "GET"))).status).toBe(404);
    state.identity = null;
    expect((await readPool(request(`/chore-pool?homeId=${HOME}`, "GET"))).status).toBe(401);
  });
});

describe("claim policies", () => {
  const path = `/chores/${CHORE}/claim-policy`;
  const policy = {
    expectedRevision: 2,
    mode: "selected",
    memberIds: [MEMBER_A, MEMBER_B],
    expiry: "week_end",
    autoReleaseHours: null,
    dryRun: false,
  };

  it("sends the policy, leaving out an automatic release that is off", async () => {
    answers({ set_chore_claim_policy: [{ outcome: "saved", impact: null, revision: 3 }] });
    const response = await setPolicy(request(path, "PUT", policy), chore);
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("set_chore_claim_policy", {
      p_chore_id: CHORE,
      p_expected_revision: 2,
      p_mode: "selected",
      p_member_ids: [MEMBER_A, MEMBER_B],
      p_expiry: "week_end",
      p_dry_run: false,
      p_confirm: false,
    });
    await setPolicy(
      request(path, "PUT", { ...policy, mode: "all", memberIds: [], autoReleaseHours: 48 }),
      chore,
    );
    expect(state.rpc.mock.calls[1]?.[1]).toMatchObject({ p_auto_release_hours: 48 });
  });

  it("asks to confirm immediate effects with the impact, and maps a conflict", async () => {
    const impact = { expireNow: 2, releaseNow: 1, claimedIneligible: 0 };
    answers({ set_chore_claim_policy: [{ outcome: "needs_confirmation", impact, revision: 2 }] });
    const confirm = await setPolicy(request(path, "PUT", policy), chore);
    expect(confirm.status).toBe(409);
    expect(await confirm.json()).toEqual({ error: "needs-confirmation", impact });
    answers({ set_chore_claim_policy: [{ outcome: "conflict", impact: null, revision: 5 }] });
    const conflict = await setPolicy(request(path, "PUT", policy), chore);
    expect(await conflict.json()).toEqual({ error: "conflict", revision: 5 });
    answers({
      set_chore_claim_policy: [{ outcome: "invalid_member", impact: null, revision: null }],
    });
    const invalid = await setPolicy(request(path, "PUT", policy), chore);
    expect(await invalid.json()).toEqual({ error: "invalid", fields: ["memberIds"] });
  });

  it("refuses selected members without any, members for everyone, and a release over 30 days", async () => {
    for (const body of [
      { ...policy, memberIds: [] },
      { ...policy, mode: "all" },
      { ...policy, autoReleaseHours: 721 },
      { ...policy, mode: "anyone" },
    ]) {
      expect((await setPolicy(request(path, "PUT", body), chore)).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("reads the policy", async () => {
    const stored = {
      claimMode: "all",
      members: null,
      expiryPolicy: "overdue",
      autoReleaseHours: null,
      revision: 1,
    };
    answers({ get_chore_claim_policy: stored });
    const response = await readPolicy(request(path, "GET"), chore);
    expect(await response.json()).toEqual({ policy: stored });
  });
});

describe("Home chore settings", () => {
  const change = {
    homeId: HOME,
    expectedRevision: 0,
    weekStart: "sunday",
    reassignmentConfirmation: true,
  };

  it("saves the week start and the confirmation rule", async () => {
    answers({ update_chore_settings: [{ outcome: "saved", revision: 1 }] });
    const response = await updateSettings(request("/chore-settings", "PATCH", change));
    expect(await response.json()).toEqual({ outcome: "saved", revision: 1 });
    expect(state.rpc).toHaveBeenCalledWith("update_chore_settings", {
      p_home_id: HOME,
      p_expected_revision: 0,
      p_week_start: "sunday",
      p_reassignment_confirmation: true,
    });
    expect(
      (
        await updateSettings(
          request("/chore-settings", "PATCH", { ...change, weekStart: "friday" }),
        )
      ).status,
    ).toBe(400);
  });

  it("reads them for every member", async () => {
    answers({
      get_chore_settings: [
        { week_start: "monday", reassignment_confirmation: false, revision: 0, can_manage: false },
      ],
    });
    const response = await readSettings(request(`/chore-settings?homeId=${HOME}`, "GET"));
    expect(await response.json()).toEqual({
      settings: {
        weekStart: "monday",
        reassignmentConfirmation: false,
        revision: 0,
        canManage: false,
      },
    });
  });
});

describe("reassignment requests", () => {
  const path = `/chore-occurrences/${OCCURRENCE}/reassignment-requests`;

  it("asks with the client's id and a normalized note", async () => {
    answers({ request_chore_reassignment: [{ outcome: "requested", status: "pending" }] });
    const response = await requestHandover(
      request(path, "POST", { id: REQUEST, toMember: MEMBER_B, note: "  Away   tonight " }),
      occurrence,
    );
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("request_chore_reassignment", {
      p_id: REQUEST,
      p_occurrence_id: OCCURRENCE,
      p_to_member: MEMBER_B,
      p_note: "Away tonight",
    });
  });

  it("passes the assignee a chore manager hands over from", async () => {
    answers({ request_chore_reassignment: [{ outcome: "requested", status: "pending" }] });
    const response = await requestHandover(
      request(path, "POST", { id: REQUEST, toMember: MEMBER_B, note: null, fromMember: MEMBER_A }),
      occurrence,
    );
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("request_chore_reassignment", {
      p_id: REQUEST,
      p_occurrence_id: OCCURRENCE,
      p_to_member: MEMBER_B,
      p_from_member: MEMBER_A,
    });
  });

  it("answers the database's refusals", async () => {
    const cases: [string, number, unknown][] = [
      ["exists", 200, { outcome: "exists", status: "pending" }],
      ["not_assignee", 409, { error: "not-assignee" }],
      ["invalid_recipient", 400, { error: "invalid", fields: ["toMember"] }],
      ["request_open", 409, { error: "request-open" }],
      ["id_taken", 409, { error: "id-taken" }],
      ["occurrence_closed", 409, { error: "occurrence-closed" }],
    ];
    for (const [outcome, status, body] of cases) {
      answers({ request_chore_reassignment: [{ outcome, status: "pending" }] });
      const response = await requestHandover(
        request(path, "POST", { id: REQUEST, toMember: MEMBER_B, note: null }),
        occurrence,
      );
      expect(response.status, outcome).toBe(status);
      expect(await response.json()).toEqual(body);
    }
  });

  it("refuses a note over 200 characters", async () => {
    const response = await requestHandover(
      request(path, "POST", { id: REQUEST, toMember: MEMBER_B, note: "x".repeat(201) }),
      occurrence,
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a request, and says when it was already answered or no longer applies", async () => {
    answers({
      answer_chore_reassignment: [{ outcome: "awaiting_manager", status: "awaiting_manager" }],
    });
    const response = await answer(
      request(`/chore-reassignment-requests/${REQUEST}`, "PATCH", { action: "accept" }),
      handover,
    );
    expect(await response.json()).toEqual({
      outcome: "awaiting_manager",
      status: "awaiting_manager",
    });
    expect(state.rpc).toHaveBeenCalledWith("answer_chore_reassignment", {
      p_request_id: REQUEST,
      p_action: "accept",
    });
    answers({ answer_chore_reassignment: [{ outcome: "not_open", status: "cancelled" }] });
    const late = await answer(
      request(`/chore-reassignment-requests/${REQUEST}`, "PATCH", { action: "decline" }),
      handover,
    );
    expect(await late.json()).toEqual({ error: "not-open", status: "cancelled" });
    answers({ answer_chore_reassignment: [{ outcome: "invalidated", status: "invalidated" }] });
    const stale = await answer(
      request(`/chore-reassignment-requests/${REQUEST}`, "PATCH", { action: "confirm" }),
      handover,
    );
    expect(await stale.json()).toEqual({ error: "invalidated" });
    expect(
      (
        await answer(
          request(`/chore-reassignment-requests/${REQUEST}`, "PATCH", { action: "approve" }),
          handover,
        )
      ).status,
    ).toBe(400);
  });

  it("lists the caller's open requests", async () => {
    answers({
      list_chore_reassignment_requests: [
        {
          id: REQUEST,
          occurrence_id: OCCURRENCE,
          title: "Bins",
          due_date: "2026-10-22",
          status: "pending",
          box: "incoming",
          from_me: false,
          from_member: MEMBER_A,
          to_me: true,
          to_member: MEMBER_B,
          note: null,
          created_at: "2026-10-21T10:00:00Z",
        },
      ],
    });
    const response = await listRequests(
      request(`/chore-reassignment-requests?homeId=${HOME}`, "GET"),
    );
    expect(await response.json()).toEqual({
      requests: [
        {
          id: REQUEST,
          occurrenceId: OCCURRENCE,
          title: "Bins",
          dueDate: "2026-10-22",
          status: "pending",
          box: "incoming",
          from: { me: false, member: MEMBER_A },
          to: { me: true, member: MEMBER_B },
          note: null,
          createdAt: "2026-10-21T10:00:00Z",
        },
      ],
    });
  });
});
