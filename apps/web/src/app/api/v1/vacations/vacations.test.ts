// S22: the vacation and absence routes. The database decides rights, dates, rotation and pauses
// (tests/db/rls/home-vacations.test.sql); these tests check what the routes send it and how they
// answer.
import type { Mock } from "vitest";

import { POST as decide } from "../chore-vacation-decisions/route";
import { POST as createAbsence } from "../chore-absences/route";
import { PATCH as changeParticipation } from "../vacation-participants/[participantId]/route";
import { PATCH as changeVacation } from "./[vacationId]/route";
import { GET as days } from "./days/route";
import { GET as listVacations, POST as createVacation } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const VACATION = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0070";
const PARTICIPANT = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0071";
const ABSENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0072";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const MEMBER_A = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";
const MEMBER_B = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0041";

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

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

const newVacation = {
  id: VACATION,
  homeId: HOME,
  name: "  Summer   by the sea ",
  people: [
    { memberId: MEMBER_A, startsOn: "2026-11-02", endsOn: "2026-11-08" },
    { memberId: MEMBER_B, startsOn: "2026-11-04", endsOn: "2026-11-08" },
  ],
  reminderDays: 2,
  dryRun: true,
};

beforeEach(() => {
  state.identity = { userId: "user-a" };
  state.rpc.mockReset();
});

describe("recording a vacation", () => {
  it("sends the people, the normalized name and the reminder, and answers the preview", async () => {
    const impact = { passes: 2, review: 1 };
    answers({ create_home_vacation: [{ outcome: "preview", impact, revision: null }] });
    const response = await createVacation(request("/vacations", "POST", newVacation));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ outcome: "preview", impact, revision: null });
    expect(state.rpc).toHaveBeenCalledWith("create_home_vacation", {
      p_id: VACATION,
      p_home_id: HOME,
      p_people: newVacation.people,
      p_dry_run: true,
      p_name: "Summer by the sea",
      p_reminder_days: 2,
    });
  });

  it("sends an empty name for no name and answers 201 when created", async () => {
    answers({ create_home_vacation: [{ outcome: "created", impact: null, revision: 1 }] });
    const response = await createVacation(
      request("/vacations", "POST", { ...newVacation, name: "   ", reminderDays: null }),
    );
    expect(response.status).toBe(201);
    const args = state.rpc.mock.calls[0]?.[1];
    expect(args?.p_name).toBe("");
    expect(args).not.toHaveProperty("p_reminder_days");
  });

  it("refuses a person twice, a stay ending before it starts and too many people", async () => {
    const twice = {
      ...newVacation,
      people: [newVacation.people[0], { ...newVacation.people[0], startsOn: "2026-11-03" }],
    };
    const backwards = {
      ...newVacation,
      people: [{ memberId: MEMBER_A, startsOn: "2026-11-08", endsOn: "2026-11-02" }],
    };
    for (const body of [twice, backwards, { ...newVacation, people: [] }]) {
      const response = await createVacation(request("/vacations", "POST", body));
      expect(response.status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request and a signed-out caller", async () => {
    expect(
      (await createVacation(request("/vacations", "POST", newVacation, crossSite))).status,
    ).toBe(403);
    state.identity = null;
    expect((await createVacation(request("/vacations", "POST", newVacation))).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a Home the caller is not in as not found", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    const response = await createVacation(request("/vacations", "POST", newVacation));
    expect(response.status).toBe(404);
  });

  it("answers dates the database refuses as invalid dates", async () => {
    answers({ create_home_vacation: [{ outcome: "invalid_dates", impact: null, revision: null }] });
    const response = await createVacation(request("/vacations", "POST", newVacation));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid", fields: ["dates"] });
  });
});

describe("listing vacations", () => {
  it("needs a Home id", async () => {
    const response = await listVacations(request("/vacations?homeId=nope", "GET"));
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("changing a vacation", () => {
  const vacation = params("vacationId", VACATION);

  it("sends a shortened end and the revision", async () => {
    answers({ update_home_vacation: [{ outcome: "saved", impact: null, revision: 4 }] });
    const response = await changeVacation(
      request(`/vacations/${VACATION}`, "PATCH", {
        action: "shorten",
        expectedRevision: 3,
        dryRun: false,
        endsOn: "2026-11-05",
      }),
      vacation,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("update_home_vacation", {
      p_vacation_id: VACATION,
      p_expected_revision: 3,
      p_action: "shorten",
      p_dry_run: false,
      p_ends_on: "2026-11-05",
    });
  });

  it("turns a reminder off by leaving the days out", async () => {
    answers({ update_home_vacation: [{ outcome: "saved", impact: null, revision: 2 }] });
    await changeVacation(
      request(`/vacations/${VACATION}`, "PATCH", {
        action: "reminder",
        expectedRevision: 1,
        dryRun: false,
        reminderDays: null,
      }),
      vacation,
    );
    expect(state.rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_reminder_days");
  });

  it("answers an ended or cancelled vacation and a stale revision with their own codes", async () => {
    const pause = { action: "pause", expectedRevision: 2, dryRun: false };
    for (const [outcome, status, error] of [
      ["ended", 409, "vacation-ended"],
      ["cancelled", 409, "vacation-cancelled"],
      ["conflict", 409, "conflict"],
      ["not_whole_home", 409, "not-whole-home"],
      ["not_permitted", 403, "not-permitted"],
    ] as const) {
      answers({ update_home_vacation: [{ outcome, impact: null, revision: 5 }] });
      const response = await changeVacation(
        request(`/vacations/${VACATION}`, "PATCH", pause),
        vacation,
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
    }
  });

  it("answers a malformed id as not found without asking the database", async () => {
    const response = await changeVacation(
      request("/vacations/nope", "PATCH", { action: "cancel", expectedRevision: 1, dryRun: true }),
      params("vacationId", "nope"),
    );
    expect(response.status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("changing a participation", () => {
  const participant = params("participantId", PARTICIPANT);

  it("sends proposed dates", async () => {
    answers({ change_vacation_participation: [{ outcome: "saved", impact: null, revision: 2 }] });
    await changeParticipation(
      request(`/vacation-participants/${PARTICIPANT}`, "PATCH", {
        action: "propose_dates",
        expectedRevision: 1,
        dryRun: false,
        startsOn: "2026-11-03",
        endsOn: "2026-11-06",
      }),
      participant,
    );
    expect(state.rpc).toHaveBeenCalledWith("change_vacation_participation", {
      p_participant_id: PARTICIPANT,
      p_expected_revision: 1,
      p_action: "propose_dates",
      p_dry_run: false,
      p_starts_on: "2026-11-03",
      p_ends_on: "2026-11-06",
    });
  });

  it("refuses dates on an acceptance and answers an expired invitation", async () => {
    const bad = await changeParticipation(
      request(`/vacation-participants/${PARTICIPANT}`, "PATCH", {
        action: "accept",
        expectedRevision: 1,
        dryRun: false,
        startsOn: "2026-11-03",
      }),
      participant,
    );
    expect(bad.status).toBe(400);
    answers({ change_vacation_participation: [{ outcome: "expired", impact: null, revision: 1 }] });
    const expired = await changeParticipation(
      request(`/vacation-participants/${PARTICIPANT}`, "PATCH", {
        action: "accept",
        expectedRevision: 1,
        dryRun: false,
      }),
      participant,
    );
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({ error: "expired" });
  });
});

describe("deciding an affected occurrence", () => {
  const decision = {
    sourceKind: "vacation",
    sourceId: VACATION,
    occurrenceId: OCCURRENCE,
    expectedRevision: 2,
    decision: "reassign",
    memberId: MEMBER_B,
  };

  it("passes the member away back with its days, then sends the confirmation", async () => {
    const away = { member: MEMBER_B, days: ["2026-11-04"] };
    answers({
      decide_chore_vacation_item: [{ outcome: "member_away", impact: away, revision: 2 }],
    });
    const warned = await decide(request("/chore-vacation-decisions", "POST", decision));
    expect(warned.status).toBe(409);
    expect(await warned.json()).toMatchObject({ error: "member-away", impact: away });
    expect(state.rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_confirm_away");

    answers({ decide_chore_vacation_item: [{ outcome: "decided", impact: null, revision: 3 }] });
    const decided = await decide(
      request("/chore-vacation-decisions", "POST", { ...decision, confirmAway: true }),
    );
    expect(decided.status).toBe(200);
    expect(state.rpc.mock.calls[1]?.[1]).toMatchObject({
      p_member: MEMBER_B,
      p_confirm_away: true,
    });
  });

  it("refuses a reassignment without a member and a rescheduled absence", async () => {
    const { memberId: _memberId, ...noMember } = decision;
    const rescheduled = {
      ...decision,
      sourceKind: "absence",
      decision: "reschedule",
      memberId: undefined,
      dueDate: "2026-11-10",
    };
    for (const body of [noMember, rescheduled]) {
      expect((await decide(request("/chore-vacation-decisions", "POST", body))).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a second decision and protected work with their own codes", async () => {
    for (const [outcome, error] of [
      ["already_decided", "already-decided"],
      ["protected", "protected"],
    ] as const) {
      answers({ decide_chore_vacation_item: [{ outcome, impact: null, revision: 3 }] });
      const response = await decide(
        request("/chore-vacation-decisions", "POST", {
          ...decision,
          decision: "keep",
          memberId: undefined,
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error });
    }
  });
});

describe("registering an absence", () => {
  it("sends the private reason only when there is one", async () => {
    answers({ save_chore_absence: [{ outcome: "created", impact: null, revision: 1 }] });
    const absence = {
      id: ABSENCE,
      homeId: HOME,
      memberId: MEMBER_A,
      startsOn: "2026-11-02",
      endsOn: "2026-11-03",
      reason: "  ",
    };
    const response = await createAbsence(request("/chore-absences", "POST", absence));
    expect(response.status).toBe(201);
    expect(state.rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_reason");
    await createAbsence(request("/chore-absences", "POST", { ...absence, reason: "Exams" }));
    expect(state.rpc.mock.calls[1]?.[1]).toMatchObject({ p_reason: "Exams", p_member: MEMBER_A });
  });
});

describe("the calendar's vacation days", () => {
  it("refuses a backwards range and one over the limit", async () => {
    for (const query of [
      `homeId=${HOME}&from=2026-11-10&to=2026-11-01`,
      `homeId=${HOME}&from=2026-11-01&to=2026-12-31`,
      `homeId=nope&from=2026-11-01&to=2026-11-02`,
    ]) {
      expect((await days(request(`/vacations/days?${query}`, "GET"))).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a malformed database answer as a failure", async () => {
    answers({ list_home_vacation_days: { unexpected: true } });
    const response = await days(
      request(`/vacations/days?homeId=${HOME}&from=2026-11-01&to=2026-11-30`, "GET"),
    );
    expect(response.status).toBe(500);
  });
});
