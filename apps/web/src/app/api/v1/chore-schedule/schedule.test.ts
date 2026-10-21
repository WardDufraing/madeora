// S21: the reminder, schedule and daily summary setting routes. The database decides who may set a
// reminder, what a schedule shows and who is a chore manager
// (tests/db/rls/chore-overview-reminders.test.sql); these tests check what the routes send it and
// how they answer.
import type { Mock } from "vitest";

import {
  DELETE as removeReminder,
  GET as readReminder,
  PUT as setReminder,
} from "../chore-occurrences/[occurrenceId]/reminder/route";
import { GET as readSetting, PUT as saveSetting } from "../chore-summary-settings/route";
import { GET as readSchedule } from "./route";

interface State {
  identity: { userId: string } | null;
  rpc: Mock<(name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }>;
}
const state = vi.hoisted((): State => ({ identity: { userId: "user-a" }, rpc: vi.fn() }));

const HOME = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0001";
const OCCURRENCE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0020";
const CHORE = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0021";
const MEMBER = "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a0040";

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@/tasks/reminder-data", () => ({
  personalTimeZone: () => Promise.resolve("Europe/Brussels"),
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
const occurrence = { params: Promise.resolve({ occurrenceId: OCCURRENCE }) };
const reminderPath = `/chore-occurrences/${OCCURRENCE}/reminder`;

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

const view = {
  occurrenceId: OCCURRENCE,
  dueDate: "2026-10-25",
  timeZone: "Europe/Brussels",
  canSet: true,
  reminder: null,
  revision: 0,
  channels: { inApp: true, email: false },
};

describe("a chore reminder", () => {
  it("reads the caller's own reminder", async () => {
    answers({ get_chore_reminder: view });
    const response = await readReminder(request(reminderPath, "GET"), occurrence);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view);
    expect(state.rpc).toHaveBeenCalledWith("get_chore_reminder", { p_occurrence_id: OCCURRENCE });
  });

  it("answers not found for an occurrence the caller cannot see, or a malformed id", async () => {
    answers({ get_chore_reminder: null });
    expect((await readReminder(request(reminderPath, "GET"), occurrence)).status).toBe(404);
    const malformed = { params: Promise.resolve({ occurrenceId: "nope" }) };
    expect((await readReminder(request(reminderPath, "GET"), malformed)).status).toBe(404);
  });

  it("refuses a signed-out reader", async () => {
    state.identity = null;
    expect((await readReminder(request(reminderPath, "GET"), occurrence)).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("previews a relative reminder with the days and time", async () => {
    answers({
      set_chore_reminder: [
        { outcome: "preview", fire_at: "2026-10-24T16:00:00Z", dst: null, revision: 0 },
      ],
    });
    const response = await setReminder(
      request(reminderPath, "PUT", {
        mode: "relative",
        daysBefore: 1,
        time: "18:00",
        expectedRevision: 0,
        dryRun: true,
      }),
      occurrence,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "preview",
      fireAt: "2026-10-24T16:00:00Z",
      dst: null,
      revision: 0,
    });
    expect(state.rpc).toHaveBeenCalledWith("set_chore_reminder", {
      p_occurrence_id: OCCURRENCE,
      p_mode: "relative",
      p_expected_revision: 0,
      p_dry_run: true,
      p_days_before: 1,
      p_time: "18:00",
    });
  });

  it("saves an absolute reminder as a local date and time with seconds", async () => {
    answers({
      set_chore_reminder: [
        { outcome: "saved", fire_at: "2026-03-29T01:30:00Z", dst: "gap", revision: 1 },
      ],
    });
    const response = await setReminder(
      request(reminderPath, "PUT", {
        mode: "absolute",
        localAt: "2026-03-29T02:30",
        expectedRevision: 0,
        dryRun: false,
      }),
      occurrence,
    );
    expect(response.status).toBe(200);
    expect(state.rpc.mock.calls.at(-1)?.[1]).toMatchObject({
      p_mode: "absolute",
      p_local_at: "2026-03-29T02:30:00",
    });
  });

  it.each([
    ["in_past", 409, "in-past"],
    ["not_assignee", 409, "not-assignee"],
    ["occurrence_closed", 409, "occurrence-closed"],
    ["conflict", 409, "conflict"],
    ["not_found", 404, "not-found"],
  ])("answers %s as %i %s", async (outcome, status, code) => {
    answers({ set_chore_reminder: [{ outcome, fire_at: null, dst: null, revision: 2 }] });
    const response = await setReminder(
      request(reminderPath, "PUT", {
        mode: "relative",
        daysBefore: 0,
        time: "08:00",
        expectedRevision: 1,
        dryRun: false,
      }),
      occurrence,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: code });
  });

  it.each([
    { mode: "relative", daysBefore: 31, time: "08:00", expectedRevision: 0, dryRun: false },
    { mode: "relative", daysBefore: 1, time: "25:00", expectedRevision: 0, dryRun: false },
    { mode: "absolute", localAt: "tomorrow", expectedRevision: 0, dryRun: false },
    { mode: "absolute", localAt: "2026-10-24T08:00", dryRun: false },
    {
      mode: "absolute",
      localAt: "2026-10-24T08:00",
      expectedRevision: 0,
      dryRun: false,
      userId: MEMBER,
    },
  ])("refuses an invalid reminder %#", async (body) => {
    const response = await setReminder(request(reminderPath, "PUT", body), occurrence);
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("refuses a cross-site change", async () => {
    const response = await setReminder(
      request(
        reminderPath,
        "PUT",
        { mode: "relative", daysBefore: 1, time: "08:00", expectedRevision: 0, dryRun: false },
        crossSite,
      ),
      occurrence,
    );
    expect(response.status).toBe(403);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("removes the reminder at the revision seen", async () => {
    answers({ remove_chore_reminder: [{ outcome: "removed", revision: 3 }] });
    const response = await removeReminder(
      request(reminderPath, "DELETE", { expectedRevision: 2 }),
      occurrence,
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("remove_chore_reminder", {
      p_occurrence_id: OCCURRENCE,
      p_expected_revision: 2,
    });
    answers({ remove_chore_reminder: [{ outcome: "conflict", revision: 4 }] });
    const stale = await removeReminder(
      request(reminderPath, "DELETE", { expectedRevision: 2 }),
      occurrence,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "conflict", revision: 4 });
  });
});

const item = {
  id: OCCURRENCE,
  choreId: CHORE,
  title: "Dishes",
  date: "2026-10-21",
  category: null,
  status: "open",
  overdue: false,
  inRework: false,
  needsReassignment: false,
  awaitingVolunteer: false,
  assigneeIds: [MEMBER],
  minutes: 10,
  revision: 1,
  recurring: true,
  projected: false,
};

describe("the chore schedule", () => {
  it("reads a range of at most 42 days", async () => {
    answers({
      list_chore_schedule: {
        today: "2026-10-21",
        canManage: false,
        truncated: false,
        items: [item],
      },
    });
    const response = await readSchedule(
      request(`/chore-schedule?homeId=${HOME}&from=2026-10-19&to=2026-10-25`, "GET"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: OCCURRENCE, title: "Dishes" }] });
    expect(state.rpc).toHaveBeenCalledWith("list_chore_schedule", {
      p_home_id: HOME,
      p_from: "2026-10-19",
      p_to: "2026-10-25",
    });
  });

  it.each([
    `homeId=${HOME}&from=2026-10-01&to=2026-11-12`,
    `homeId=${HOME}&from=2026-10-25&to=2026-10-19`,
    `homeId=nope&from=2026-10-19&to=2026-10-25`,
    `homeId=${HOME}&from=2026-10-19`,
  ])("refuses an invalid range %s", async (search) => {
    const response = await readSchedule(request(`/chore-schedule?${search}`, "GET"));
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers not found for a Home the caller is not in, and fails on an unexpected shape", async () => {
    state.rpc.mockReturnValue({ data: null, error: { code: "42501", message: "not permitted" } });
    const path = `/chore-schedule?homeId=${HOME}&from=2026-10-19&to=2026-10-25`;
    expect((await readSchedule(request(path, "GET"))).status).toBe(404);
    answers({ list_chore_schedule: { items: "nope" } });
    expect((await readSchedule(request(path, "GET"))).status).toBe(500);
  });
});

describe("the daily summary setting", () => {
  it("reads the caller's setting for a Home", async () => {
    const setting = {
      canManage: true,
      enabled: false,
      hour: 8,
      timeZone: null,
      revision: 0,
    };
    answers({ get_chore_summary_setting: setting });
    const response = await readSetting(request(`/chore-summary-settings?homeId=${HOME}`, "GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(setting);
  });

  it("saves in the caller's own timezone, never one sent by the browser", async () => {
    answers({ set_chore_summary_setting: [{ outcome: "saved", revision: 1 }] });
    const response = await saveSetting(
      request("/chore-summary-settings", "PUT", {
        homeId: HOME,
        enabled: true,
        hour: 7,
        expectedRevision: 0,
      }),
    );
    expect(response.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("set_chore_summary_setting", {
      p_home_id: HOME,
      p_enabled: true,
      p_hour: 7,
      p_time_zone: "Europe/Brussels",
      p_expected_revision: 0,
    });
  });

  it("refuses a timezone in the request, a bad hour, and a non-manager", async () => {
    for (const body of [
      { homeId: HOME, enabled: true, hour: 7, expectedRevision: 0, timeZone: "UTC" },
      { homeId: HOME, enabled: true, hour: 24, expectedRevision: 0 },
    ]) {
      expect((await saveSetting(request("/chore-summary-settings", "PUT", body))).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
    answers({ set_chore_summary_setting: [{ outcome: "not_permitted", revision: null }] });
    const response = await saveSetting(
      request("/chore-summary-settings", "PUT", {
        homeId: HOME,
        enabled: true,
        hour: 7,
        expectedRevision: 0,
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "not-permitted" });
  });
});
