// S21: the proposal and volunteer request routes. The database decides who may propose, review,
// ask, answer and correct, the first acceptance and the deadline
// (tests/db/rls/chore-proposals-volunteers.test.sql and chore-volunteers-concurrency.test.ts); these
// tests check what the routes send it and how they answer.
import type { Mock } from "vitest";

import { POST as correct } from "../chore-occurrences/[occurrenceId]/volunteer-correction/route";
import {
  GET as volunteerState,
  POST as askVolunteers,
} from "../chore-occurrences/[occurrenceId]/volunteers/route";
import { PATCH as changeRequest } from "../chore-volunteer-requests/[requestId]/route";
import { GET as listOffers } from "../chore-volunteer-requests/route";
import { PATCH as decide } from "./[proposalId]/route";
import { GET as listProposals, POST as propose } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const PROPOSAL = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0015";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const MEMBER_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const MEMBER_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";
const REQUEST = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0060";
const CATEGORY = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0070";

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
const proposal = params("proposalId", PROPOSAL);
const occurrence = params("occurrenceId", OCCURRENCE);
const volunteerRequest = params("requestId", REQUEST);

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

const fields = {
  title: "Clean the windows",
  instructions: null,
  categoryId: null,
  minutes: null,
  steps: [],
  dueDate: "2026-10-25",
};

describe("proposing", () => {
  it("sends only the fields that are set and answers 201", async () => {
    answers({ propose_chore: [{ outcome: "proposed", revision: 1 }] });
    const response = await propose(
      request("/chore-proposals", "POST", {
        id: PROPOSAL,
        homeId: HOME,
        ...fields,
        categoryId: CATEGORY,
        minutes: 20,
        steps: [{ label: "Inside", mandatory: true }],
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ outcome: "proposed", revision: 1 });
    const [name, args] = state.rpc.mock.calls[0] ?? [];
    expect(name).toBe("propose_chore");
    expect(args).toMatchObject({
      p_id: PROPOSAL,
      p_home_id: HOME,
      p_title: "Clean the windows",
      p_due_date: "2026-10-25",
      p_category_id: CATEGORY,
      p_minutes: 20,
    });
    expect(args).not.toHaveProperty("p_instructions");
  });

  it("answers a retry, a duplicate title and a past date", async () => {
    const body = { id: PROPOSAL, homeId: HOME, ...fields };
    answers({ propose_chore: [{ outcome: "exists", revision: 1 }] });
    expect((await propose(request("/chore-proposals", "POST", body))).status).toBe(200);
    answers({ propose_chore: [{ outcome: "duplicate", revision: null }] });
    const duplicate = await propose(request("/chore-proposals", "POST", body));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "duplicate" });
    answers({ propose_chore: [{ outcome: "invalid_date", revision: null }] });
    const late = await propose(request("/chore-proposals", "POST", body));
    expect(late.status).toBe(400);
    expect(await late.json()).toEqual({ error: "invalid", fields: ["dueDate"] });
  });

  it("refuses cross-site requests, signed-out people, extra fields and bad titles", async () => {
    const body = { id: PROPOSAL, homeId: HOME, ...fields };
    expect((await propose(request("/chore-proposals", "POST", body, crossSite))).status).toBe(403);
    expect(
      (await propose(request("/chore-proposals", "POST", { ...body, status: "approved" }))).status,
    ).toBe(400);
    expect(
      (await propose(request("/chore-proposals", "POST", { ...body, title: "" }))).status,
    ).toBe(400);
    state.identity = null;
    expect((await propose(request("/chore-proposals", "POST", body))).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("lists a Home's proposals and needs a valid Home id", async () => {
    answers({ list_chore_proposals: { canReview: false, proposals: [], pendingCount: null } });
    const response = await listProposals(request(`/chore-proposals?homeId=${HOME}`, "GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ canReview: false, proposals: [], pendingCount: null });
    expect((await listProposals(request("/chore-proposals?homeId=nope", "GET"))).status).toBe(400);
  });
});

describe("deciding on a proposal", () => {
  const path = `/chore-proposals/${PROPOSAL}`;

  it("withdraws with the revision seen", async () => {
    answers({
      withdraw_chore_proposal: [{ outcome: "withdrawn", status: "withdrawn", revision: 2 }],
    });
    const response = await decide(
      request(path, "PATCH", { action: "withdraw", expectedRevision: 1 }),
      proposal,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("withdraw_chore_proposal", {
      p_id: PROPOSAL,
      p_expected_revision: 1,
    });
  });

  it("needs a reason to reject and sends it", async () => {
    expect(
      (await decide(request(path, "PATCH", { action: "reject", expectedRevision: 1 }), proposal))
        .status,
    ).toBe(400);
    expect(
      (
        await decide(
          request(path, "PATCH", { action: "reject", expectedRevision: 1, reason: "   " }),
          proposal,
        )
      ).status,
    ).toBe(400);
    answers({
      review_chore_proposal: [
        { outcome: "rejected", status: "rejected", occurrence_id: null, revision: 2 },
      ],
    });
    const response = await decide(
      request(path, "PATCH", { action: "reject", expectedRevision: 1, reason: "We have one" }),
      proposal,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("review_chore_proposal", {
      p_id: PROPOSAL,
      p_expected_revision: 1,
      p_decision: "reject",
      p_reason: "We have one",
    });
  });

  it("approves the final fields and returns the published occurrence", async () => {
    answers({
      review_chore_proposal: [
        { outcome: "approved", status: "approved", occurrence_id: OCCURRENCE, revision: 2 },
      ],
    });
    const response = await decide(
      request(path, "PATCH", { action: "approve", expectedRevision: 1, ...fields, minutes: 15 }),
      proposal,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "approved", occurrenceId: OCCURRENCE });
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_decision: "approve",
      p_title: "Clean the windows",
      p_minutes: 15,
    });
  });

  it("answers a decision made already and a stale revision", async () => {
    answers({
      review_chore_proposal: [
        { outcome: "not_open", status: "approved", occurrence_id: null, revision: 2 },
      ],
    });
    const decided = await decide(
      request(path, "PATCH", { action: "approve", expectedRevision: 1, ...fields }),
      proposal,
    );
    expect(decided.status).toBe(409);
    expect(await decided.json()).toEqual({ error: "not-open", status: "approved" });
    answers({
      review_chore_proposal: [
        { outcome: "conflict", status: "pending", occurrence_id: null, revision: 3 },
      ],
    });
    const stale = await decide(
      request(path, "PATCH", { action: "approve", expectedRevision: 1, ...fields }),
      proposal,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "conflict", revision: 3 });
  });
});

describe("volunteer requests", () => {
  const path = `/chore-occurrences/${OCCURRENCE}/volunteers`;
  const body = { id: REQUEST, expectedRevision: 4, memberIds: [MEMBER_A, MEMBER_B], dryRun: true };

  it("previews and sends with the chosen members", async () => {
    answers({
      create_chore_volunteer_request: [
        { outcome: "preview", deadline: "2026-10-25T22:00:00+00:00", revision: 4 },
      ],
    });
    const preview = await askVolunteers(request(path, "POST", body), occurrence);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({
      outcome: "preview",
      deadline: "2026-10-25T22:00:00+00:00",
    });
    expect(state.rpc).toHaveBeenCalledWith("create_chore_volunteer_request", {
      p_id: REQUEST,
      p_occurrence_id: OCCURRENCE,
      p_expected_revision: 4,
      p_member_ids: [MEMBER_A, MEMBER_B],
      p_dry_run: true,
    });
    answers({
      create_chore_volunteer_request: [
        { outcome: "sent", deadline: "2026-10-25T22:00:00+00:00", revision: 4 },
      ],
    });
    expect(
      (await askVolunteers(request(path, "POST", { ...body, dryRun: false }), occurrence)).status,
    ).toBe(201);
  });

  it("refuses no recipients, too many, the same member twice and refused cases", async () => {
    expect(
      (await askVolunteers(request(path, "POST", { ...body, memberIds: [] }), occurrence)).status,
    ).toBe(400);
    expect(
      (
        await askVolunteers(
          request(path, "POST", { ...body, memberIds: [MEMBER_A, MEMBER_A] }),
          occurrence,
        )
      ).status,
    ).toBe(400);
    const many = Array.from(
      { length: 21 },
      (_, index) => `6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a${String(1000 + index)}`,
    );
    expect(
      (await askVolunteers(request(path, "POST", { ...body, memberIds: many }), occurrence)).status,
    ).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
    const cases: [string, number, string][] = [
      ["not_in_review", 409, "not-in-review"],
      ["deadline_passed", 409, "deadline-passed"],
      ["request_open", 409, "request-open"],
      ["not_permitted", 403, "not-permitted"],
      ["not_found", 404, "not-found"],
    ];
    for (const [outcome, status, error] of cases) {
      answers({ create_chore_volunteer_request: [{ outcome, deadline: null, revision: null }] });
      const response = await askVolunteers(request(path, "POST", body), occurrence);
      expect(response.status, outcome).toBe(status);
      expect(((await response.json()) as { error: string }).error).toBe(error);
    }
    answers({
      create_chore_volunteer_request: [
        { outcome: "invalid_recipient", deadline: null, revision: null },
      ],
    });
    const invalid = await askVolunteers(request(path, "POST", body), occurrence);
    expect(await invalid.json()).toEqual({ error: "invalid", fields: ["memberIds"] });
  });

  it("reads the volunteer state and the viewer's offers", async () => {
    const volunteers = {
      inReview: true,
      awaitingVolunteer: false,
      deadline: "2026-10-25T22:00:00+00:00",
      canRequest: true,
      canCorrect: false,
      volunteer: null,
      requests: [],
    };
    answers({ get_chore_volunteer_state: volunteers });
    const response = await volunteerState(request(path, "GET"), occurrence);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ volunteers });
    answers({ list_chore_volunteer_offers: [] });
    const offers = await listOffers(request(`/chore-volunteer-requests?homeId=${HOME}`, "GET"));
    expect(await offers.json()).toEqual({ offers: [] });
  });

  it("answers an invitation and maps the late and the not invited", async () => {
    const path2 = `/chore-volunteer-requests/${REQUEST}`;
    answers({ answer_chore_volunteer_invitation: [{ outcome: "accepted", status: "accepted" }] });
    expect(
      (await changeRequest(request(path2, "PATCH", { action: "accept" }), volunteerRequest)).status,
    ).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("answer_chore_volunteer_invitation", {
      p_request_id: REQUEST,
      p_action: "accept",
    });
    answers({ answer_chore_volunteer_invitation: [{ outcome: "not_invited", status: null }] });
    expect(
      (await changeRequest(request(path2, "PATCH", { action: "decline" }), volunteerRequest))
        .status,
    ).toBe(404);
    answers({ answer_chore_volunteer_invitation: [{ outcome: "not_open", status: "accepted" }] });
    const late = await changeRequest(
      request(path2, "PATCH", { action: "accept" }),
      volunteerRequest,
    );
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "not-open", status: "accepted" });
  });

  it("withdraws, adds and cancels for managers", async () => {
    const path2 = `/chore-volunteer-requests/${REQUEST}`;
    answers({
      change_chore_volunteer_request: [
        { outcome: "withdrawn", status: "closed", closed: true, skipped: [] },
      ],
    });
    const withdrawn = await changeRequest(
      request(path2, "PATCH", { action: "withdraw", memberIds: [MEMBER_A] }),
      volunteerRequest,
    );
    expect(await withdrawn.json()).toEqual({ outcome: "withdrawn", closed: true, skipped: [] });
    expect(state.rpc).toHaveBeenCalledWith("change_chore_volunteer_request", {
      p_request_id: REQUEST,
      p_action: "withdraw",
      p_member_ids: [MEMBER_A],
    });
    expect(
      (await changeRequest(request(path2, "PATCH", { action: "add" }), volunteerRequest)).status,
    ).toBe(400);
    expect(
      (
        await changeRequest(
          request(path2, "PATCH", { action: "cancel", memberIds: [MEMBER_A] }),
          volunteerRequest,
        )
      ).status,
    ).toBe(400);
  });
});

describe("correcting a volunteer assignment", () => {
  const path = `/chore-occurrences/${OCCURRENCE}/volunteer-correction`;

  it("needs a reason and sends the new member only when given", async () => {
    expect(
      (
        await correct(
          request(path, "POST", { expectedRevision: 5, reason: "", memberId: null, dryRun: true }),
          occurrence,
        )
      ).status,
    ).toBe(400);
    answers({
      correct_chore_volunteer_assignment: [
        { outcome: "preview", volunteer_member: MEMBER_A, overdue: true, revision: 5 },
      ],
    });
    const preview = await correct(
      request(path, "POST", { expectedRevision: 5, reason: "Away", memberId: null, dryRun: true }),
      occurrence,
    );
    expect(await preview.json()).toEqual({
      outcome: "preview",
      volunteer: MEMBER_A,
      overdue: true,
      revision: 5,
    });
    expect(state.rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_member_id");
    answers({
      correct_chore_volunteer_assignment: [
        { outcome: "not_volunteered", volunteer_member: null, overdue: false, revision: 5 },
      ],
    });
    const refused = await correct(
      request(path, "POST", {
        expectedRevision: 5,
        reason: "Away",
        memberId: MEMBER_B,
        dryRun: false,
      }),
      occurrence,
    );
    expect(refused.status).toBe(409);
    expect(state.rpc.mock.calls.at(-1)?.[1]).toMatchObject({ p_member_id: MEMBER_B });
  });
});
