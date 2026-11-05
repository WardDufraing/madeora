// S32: the calendar routes. The database decides every right and value (tests/db/rls/calendar.test.sql);
// these tests check what the routes send it and how they answer, above all that an event someone
// may not see answers exactly like one that does not exist.
import type { Mock } from "vitest";

import { EVENT, HOME, MEMBERSHIP, NEW_EVENT, eventDetail } from "@/calendar/testing";

import { GET as readAccess, PUT as setAccess } from "../homes/[homeId]/calendar-access/route";
import { PUT as setPreferences } from "./preferences/route";
import { DELETE as remove, GET as read, PATCH as update } from "./events/[eventId]/route";
import { PUT as setShares } from "./events/[eventId]/shares/route";
import { POST as create } from "./events/route";
import { GET as list } from "./route";

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
vi.mock("@/preferences/server", () => ({
  getEffectiveTimeZone: () => Promise.resolve({ timeZone: "Europe/Brussels", source: "chosen" }),
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
const eventParams = { params: Promise.resolve({ eventId: EVENT }) };
const homeParams = { params: Promise.resolve({ homeId: HOME }) };

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
  title: "Dentist",
  allDay: false,
  startsOn: "2026-11-10",
  endsOn: "2026-11-10",
  startTime: "09:00",
  endTime: "10:00",
  timezone: "Europe/Brussels",
};
const calendar = {
  timezone: "Europe/Brussels",
  today: "2026-11-04",
  level: "edit",
  canCreate: true,
  truncated: false,
  occurrences: [],
  showVacations: true,
  showTasks: false,
  showChores: false,
  vacations: [],
};

describe("checks every request makes", () => {
  it("refuses a cross-site change and a signed-out person before the database", async () => {
    const body = { id: NEW_EVENT, homeId: null, event: fields };
    expect((await create(request("/calendar/events", "POST", body, crossSite))).status).toBe(403);
    state.identity = null;
    expect((await create(request("/calendar/events", "POST", body))).status).toBe(401);
    expect((await read(request(`/calendar/events/${EVENT}`, "GET"), eventParams)).status).toBe(401);
    expect((await list(request("/calendar?from=2026-11-01&to=2026-11-30", "GET"))).status).toBe(
      401,
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("answers a malformed id as not found and invalid input as invalid, without the database", async () => {
    const bad = { params: Promise.resolve({ eventId: "nope" }) };
    expect((await read(request("/calendar/events/nope", "GET"), bad)).status).toBe(404);
    const invalid = await create(
      request("/calendar/events", "POST", { id: NEW_EVENT, homeId: null, event: { title: "" } }),
    );
    expect(invalid.status).toBe(400);
    expect((await list(request("/calendar?from=2026-11-01&to=2027-01-15", "GET"))).status).toBe(
      400,
    );
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("reading", () => {
  it("reads the Personal calendar in the person's own timezone and a Home's by its id", async () => {
    answers({ list_calendar: calendar });
    const personal = await list(request("/calendar?from=2026-11-01&to=2026-11-30", "GET"));
    expect(personal.status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("list_calendar", {
      p_from: "2026-11-01",
      p_to: "2026-11-30",
      p_zone: "Europe/Brussels",
    });
    await list(request(`/calendar?homeId=${HOME}&from=2026-11-01&to=2026-11-30`, "GET"));
    expect(state.rpc).toHaveBeenLastCalledWith("list_calendar", {
      p_from: "2026-11-01",
      p_to: "2026-11-30",
      p_home_id: HOME,
    });
  });

  it("answers an event the person may not see exactly like a missing one", async () => {
    answers({ get_calendar_event: null });
    const hidden = await read(
      request(`/calendar/events/${EVENT}?homeId=${HOME}`, "GET"),
      eventParams,
    );
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: "not-found" });
    state.rpc.mockImplementation(() => ({ data: null, error: { code: "42501", message: "x" } }));
    const refused = await read(request(`/calendar/events/${EVENT}`, "GET"), eventParams);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "not-found" });
  });

  it("reads one occurrence of a recurring event", async () => {
    answers({ get_calendar_event: eventDetail() });
    const found = await read(
      request(`/calendar/events/${EVENT}?homeId=${HOME}&on=2026-11-17`, "GET"),
      eventParams,
    );
    expect(found.status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("get_calendar_event", {
      p_event_id: EVENT,
      p_on: "2026-11-17",
      p_home_id: HOME,
    });
  });

  it("refuses a database answer that does not have the expected shape", async () => {
    answers({ list_calendar: { ...calendar, occurrences: [{ title: 1 }] } });
    expect((await list(request("/calendar?from=2026-11-01&to=2026-11-30", "GET"))).status).toBe(
      500,
    );
  });
});

describe("changing", () => {
  it("creates a personal or a Home event, and maps refusals", async () => {
    answers({ create_calendar_event: { outcome: "created", id: NEW_EVENT, revision: 1 } });
    const created = await create(
      request("/calendar/events", "POST", { id: NEW_EVENT, homeId: null, event: fields }),
    );
    expect(created.status).toBe(201);
    expect(state.rpc).toHaveBeenLastCalledWith("create_calendar_event", {
      p_id: NEW_EVENT,
      p_event: { ...fields, location: undefined, description: undefined },
    });
    for (const [outcome, status, error] of [
      ["not_permitted", 403, "not-permitted"],
      ["nonexistent_time", 400, "nonexistent-time"],
      ["invalid_member", 400, "invalid-member"],
      ["limit_reached", 409, "limit-reached"],
      ["id_taken", 409, "id-taken"],
    ] as const) {
      answers({ create_calendar_event: { outcome } });
      const answer = await create(
        request("/calendar/events", "POST", { id: NEW_EVENT, homeId: HOME, event: fields }),
      );
      expect(answer.status).toBe(status);
      expect(await answer.json()).toEqual({ error });
    }
  });

  it("sends the scope, the occurrence, the preview flag and the new series id", async () => {
    answers({
      update_calendar_event: { outcome: "preview", scope: "following", dates: [], more: false },
    });
    const preview = await update(
      request(`/calendar/events/${EVENT}`, "PATCH", {
        revision: 3,
        scope: "following",
        on: "2026-11-17",
        event: fields,
        dryRun: true,
        newId: NEW_EVENT,
      }),
      eventParams,
    );
    expect(preview.status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith(
      "update_calendar_event",
      expect.objectContaining({
        p_event_id: EVENT,
        p_expected_revision: 3,
        p_scope: "following",
        p_on: "2026-11-17",
        p_dry_run: true,
        p_new_id: NEW_EVENT,
      }),
    );
    answers({ update_calendar_event: { outcome: "stale", revision: 4 } });
    const stale = await update(
      request(`/calendar/events/${EVENT}`, "PATCH", {
        revision: 3,
        scope: null,
        on: null,
        event: fields,
      }),
      eventParams,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stale", revision: 4 });
  });

  it("deletes with a scope, and refuses a member without delete rights", async () => {
    answers({ delete_calendar_event: { outcome: "deleted", revision: 4 } });
    const deleted = await remove(
      request(`/calendar/events/${EVENT}`, "DELETE", {
        revision: 3,
        scope: "only",
        on: "2026-11-17",
      }),
      eventParams,
    );
    expect(deleted.status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("delete_calendar_event", {
      p_event_id: EVENT,
      p_expected_revision: 3,
      p_dry_run: false,
      p_scope: "only",
      p_on: "2026-11-17",
    });
    answers({ delete_calendar_event: { outcome: "not_permitted" } });
    const refused = await remove(
      request(`/calendar/events/${EVENT}`, "DELETE", { revision: 3, scope: null, on: null }),
      eventParams,
    );
    expect(refused.status).toBe(403);
  });

  it("shares, sets a member's level and the person's own vacation choice", async () => {
    answers({ set_calendar_event_shares: { outcome: "saved", revision: 4 } });
    expect(
      (
        await setShares(
          request(`/calendar/events/${EVENT}/shares`, "PUT", { revision: 3, homeIds: [HOME] }),
          eventParams,
        )
      ).status,
    ).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("set_calendar_event_shares", {
      p_event_id: EVENT,
      p_expected_revision: 3,
      p_home_ids: [HOME],
    });
    answers({ set_home_calendar_access: "not_permitted" });
    const level = await setAccess(
      request(`/homes/${HOME}/calendar-access`, "PUT", {
        membershipId: MEMBERSHIP,
        level: "edit_delete",
      }),
      homeParams,
    );
    expect(level.status).toBe(403);
    answers({ set_calendar_preferences: "ok" });
    const preferences = (body: unknown) =>
      setPreferences(request("/calendar/preferences", "PUT", body));
    expect((await preferences({ homeId: HOME, showVacations: false })).status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("set_calendar_preferences", {
      p_home_id: HOME,
      p_show_vacations: false,
    });
    expect((await preferences({ homeId: null, showTasks: true })).status).toBe(200);
    expect(state.rpc).toHaveBeenLastCalledWith("set_calendar_preferences", { p_show_tasks: true });
    // Vacations and chores are a Home's settings; an empty change is refused before the database.
    const calls = state.rpc.mock.calls.length;
    expect((await preferences({ homeId: null, showChores: true })).status).toBe(400);
    expect((await preferences({ homeId: HOME })).status).toBe(400);
    expect(state.rpc.mock.calls.length).toBe(calls);
    answers({
      list_home_calendar_access: {
        canManage: false,
        members: [
          {
            membershipId: MEMBERSHIP,
            isSelf: true,
            role: "member",
            level: "edit",
            canChange: false,
          },
        ],
      },
    });
    expect(
      (await readAccess(request(`/homes/${HOME}/calendar-access`, "GET"), homeParams)).status,
    ).toBe(200);
  });
});
