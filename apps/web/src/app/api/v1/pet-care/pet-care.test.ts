// S31 care part: the pet-care routes. The database decides every right and value
// (tests/db/rls/pet-care.test.sql); these tests check what the routes send it and how they answer.
import type { Mock } from "vitest";

import {
  ACTIVITY,
  HOME,
  MEMBERSHIP,
  OCCURRENCE,
  PET,
  careActivityDetail,
  homeCare,
  petCare,
} from "@/pets/testing";

import { POST as occurrenceAction } from "../pet-care-occurrences/[occurrenceId]/route";
import { GET as readPetCare, POST as createCare } from "../pets/[petId]/care/route";
import { DELETE as deleteCare, GET as readCare, PATCH as updateCare } from "./[activityId]/route";
import { POST as setState } from "./[activityId]/state/route";
import { GET as widget } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

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
const petParams = { params: Promise.resolve({ petId: PET }) };
const activityParams = { params: Promise.resolve({ activityId: ACTIVITY }) };
const occurrenceParams = { params: Promise.resolve({ occurrenceId: OCCURRENCE }) };

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

const activity = { title: " Breakfast ", category: "feeding", reminder: 15 };
const schedule = {
  frequency: "daily",
  startsOn: "2026-11-04",
  time: "07:30",
  members: [MEMBERSHIP],
};

describe("checks every request makes", () => {
  it("refuses a cross-site change and a signed-out person before the database", async () => {
    const body = { id: ACTIVITY, activity, schedule };
    expect(
      (await createCare(request(`/pets/${PET}/care`, "POST", body, crossSite), petParams)).status,
    ).toBe(403);
    state.identity = null;
    expect((await createCare(request(`/pets/${PET}/care`, "POST", body), petParams)).status).toBe(
      401,
    );
    expect((await readCare(request(`/pet-care/${ACTIVITY}`, "GET"), activityParams)).status).toBe(
      401,
    );
    expect(
      (await widget(request(`/pet-care?homeId=${HOME}&days=1&who=all&count=5`, "GET"))).status,
    ).toBe(401);
    expect(
      (
        await occurrenceAction(
          request(`/pet-care-occurrences/${OCCURRENCE}`, "POST", {
            action: "complete",
            revision: 1,
          }),
          occurrenceParams,
        )
      ).status,
    ).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a malformed id as not found without asking the database", async () => {
    const bad = { params: Promise.resolve({ activityId: "nope" }) };
    expect((await readCare(request("/pet-care/nope", "GET"), bad)).status).toBe(404);
    expect(
      (await deleteCare(request("/pet-care/nope", "DELETE", { revision: 1 }), bad)).status,
    ).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses invalid schedules and widget queries before the database", async () => {
    const weeklyWithoutDays = { ...schedule, frequency: "weekly" };
    const response = await createCare(
      request(`/pets/${PET}/care`, "POST", { id: ACTIVITY, activity, schedule: weeklyWithoutDays }),
      petParams,
    );
    expect(response.status).toBe(400);
    const endsBefore = { ...schedule, endsOn: "2026-11-01" };
    expect(
      (
        await createCare(
          request(`/pets/${PET}/care`, "POST", { id: ACTIVITY, activity, schedule: endsBefore }),
          petParams,
        )
      ).status,
    ).toBe(400);
    // A schedule change needs the date it applies from, and the other way round.
    expect(
      (
        await updateCare(
          request(`/pet-care/${ACTIVITY}`, "PATCH", { revision: 1, activity, schedule }),
          activityParams,
        )
      ).status,
    ).toBe(400);
    expect(
      (await widget(request(`/pet-care?homeId=${HOME}&days=2&who=all&count=5`, "GET"))).status,
    ).toBe(400);
    expect(
      (await widget(request(`/pet-care?homeId=${HOME}&days=1&who=others&count=5`, "GET"))).status,
    ).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("care activities", () => {
  it("adds one with the title trimmed, and marks medication as medical", async () => {
    answers({ create_pet_care: { outcome: "created", id: ACTIVITY, revision: 1 } });
    const response = await createCare(
      request(`/pets/${PET}/care`, "POST", {
        id: ACTIVITY,
        activity: { ...activity, category: "medication" },
        schedule,
      }),
      petParams,
    );
    expect(response.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("create_pet_care", {
      p_id: ACTIVITY,
      p_pet_id: PET,
      p_activity: {
        title: "Breakfast",
        category: "medication",
        instructions: null,
        medical: true,
        reminder: 15,
      },
      p_schedule: {
        frequency: "daily",
        interval: 1,
        weekdays: null,
        startsOn: "2026-11-04",
        endsOn: null,
        time: "07:30",
        members: [MEMBERSHIP],
      },
    });
  });

  it("reads a pet's care and one activity, and answers an invisible one as not found", async () => {
    answers({ get_pet_care: petCare(), get_pet_care_activity: careActivityDetail() });
    const list = await readPetCare(request(`/pets/${PET}/care`, "GET"), petParams);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ care: { petId: PET, canManage: true } });
    const one = await readCare(request(`/pet-care/${ACTIVITY}`, "GET"), activityParams);
    expect(await one.json()).toMatchObject({ activity: { id: ACTIVITY, homeId: HOME } });

    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect((await readCare(request(`/pet-care/${ACTIVITY}`, "GET"), activityParams)).status).toBe(
      404,
    );
  });

  it("changes only the activity's fields when the schedule stays", async () => {
    answers({ update_pet_care: { outcome: "saved", revision: 2 } });
    const response = await updateCare(
      request(`/pet-care/${ACTIVITY}`, "PATCH", { revision: 1, activity }),
      activityParams,
    );
    expect(response.status).toBe(200);
    const args = state.rpc.mock.calls[0]?.[1];
    expect(args).toMatchObject({ p_activity_id: ACTIVITY, p_expected_revision: 1 });
    expect(args).not.toHaveProperty("p_schedule");
    expect(args).not.toHaveProperty("p_from");
  });

  it("changes the schedule from a date on", async () => {
    answers({ update_pet_care: { outcome: "saved", revision: 2 } });
    await updateCare(
      request(`/pet-care/${ACTIVITY}`, "PATCH", {
        revision: 1,
        activity,
        schedule,
        from: "2026-11-06",
      }),
      activityParams,
    );
    expect(state.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_from: "2026-11-06",
      p_schedule: { frequency: "daily", startsOn: "2026-11-04" },
    });
  });

  it("answers a stale revision and an ended activity with their codes, a refusal as not found", async () => {
    answers({ set_pet_care_state: { outcome: "stale", revision: 4 } });
    const stale = await setState(
      request(`/pet-care/${ACTIVITY}/state`, "POST", { revision: 1, state: "paused" }),
      activityParams,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale", revision: 4 });

    answers({ set_pet_care_state: { outcome: "invalid_state" } });
    expect(
      (
        await setState(
          request(`/pet-care/${ACTIVITY}/state`, "POST", { revision: 1, state: "active" }),
          activityParams,
        )
      ).status,
    ).toBe(409);

    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect(
      (
        await deleteCare(
          request(`/pet-care/${ACTIVITY}`, "DELETE", { revision: 1 }),
          activityParams,
        )
      ).status,
    ).toBe(404);
  });

  it("answers a member who is no longer in the Home as invalid", async () => {
    answers({ create_pet_care: { outcome: "invalid_member" } });
    const response = await createCare(
      request(`/pets/${PET}/care`, "POST", { id: ACTIVITY, activity, schedule }),
      petParams,
    );
    expect(response.status).toBe(400);
  });
});

describe("occurrences", () => {
  const post = (body: unknown) =>
    occurrenceAction(
      request(`/pet-care-occurrences/${OCCURRENCE}`, "POST", body),
      occurrenceParams,
    );

  it("completes now, or at a given moment with a trimmed note", async () => {
    answers({ complete_pet_care_occurrence: { outcome: "completed", revision: 2 } });
    expect((await post({ action: "complete", revision: 1 })).status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("complete_pet_care_occurrence", {
      p_occurrence_id: OCCURRENCE,
      p_expected_revision: 1,
    });
    await post({
      action: "complete",
      revision: 1,
      completedAt: "2026-11-04T06:40:00Z",
      note: " Ate half ",
    });
    expect(state.rpc).toHaveBeenLastCalledWith("complete_pet_care_occurrence", {
      p_occurrence_id: OCCURRENCE,
      p_expected_revision: 1,
      p_completed_at: "2026-11-04T06:40:00Z",
      p_note: "Ate half",
    });
  });

  it("reports care someone else already recorded as closed", async () => {
    answers({ complete_pet_care_occurrence: { outcome: "closed", revision: 2 } });
    const response = await post({ action: "complete", revision: 1 });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "closed" });
  });

  it("skips, reopens, corrects and changes one occurrence with its own function", async () => {
    answers({
      skip_pet_care_occurrence: { outcome: "skipped", revision: 2 },
      reopen_pet_care_occurrence: { outcome: "reopened", revision: 3 },
      correct_pet_care_completion: { outcome: "saved", revision: 4 },
      update_pet_care_occurrence: { outcome: "saved", revision: 5 },
    });
    expect((await post({ action: "skip", revision: 1 })).status).toBe(200);
    expect((await post({ action: "reopen", revision: 2 })).status).toBe(200);
    expect(
      (await post({ action: "correct", revision: 3, completedAt: "2026-11-04T06:40:00Z" })).status,
    ).toBe(200);
    expect(
      (await post({ action: "update", revision: 4, dueOn: "2026-11-05", time: null, members: [] }))
        .status,
    ).toBe(200);
    expect(state.rpc.mock.calls.map(([name]) => name)).toEqual([
      "skip_pet_care_occurrence",
      "reopen_pet_care_occurrence",
      "correct_pet_care_completion",
      "update_pet_care_occurrence",
    ]);
    expect(state.rpc).toHaveBeenLastCalledWith("update_pet_care_occurrence", {
      p_occurrence_id: OCCURRENCE,
      p_expected_revision: 4,
      p_due_on: "2026-11-05",
      p_time: null,
      p_members: [],
    });
  });

  it("refuses a correction without a moment and an unknown action", async () => {
    expect((await post({ action: "correct", revision: 1 })).status).toBe(400);
    expect((await post({ action: "delete", revision: 1 })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("the pet-care widget", () => {
  it("reads a Home's rows with every pet as null, and one pet when chosen", async () => {
    answers({ list_home_pet_care: homeCare() });
    const response = await widget(
      request(`/pet-care?homeId=${HOME}&days=3&who=me&count=10`, "GET"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ care: { rows: [{ petName: "Miso" }] } });
    expect(state.rpc).toHaveBeenLastCalledWith("list_home_pet_care", {
      p_home_id: HOME,
      p_pet_id: null,
      p_days: 3,
      p_who: "me",
      p_limit: 10,
    });
    await widget(request(`/pet-care?homeId=${HOME}&petId=${PET}&days=1&who=all&count=5`, "GET"));
    expect(state.rpc.mock.lastCall?.[1]).toMatchObject({ p_pet_id: PET });
  });

  it("answers a Home the person is not in as not found", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    expect(
      (await widget(request(`/pet-care?homeId=${HOME}&days=1&who=all&count=5`, "GET"))).status,
    ).toBe(404);
  });
});
