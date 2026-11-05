// S34: the routes that change Google events from Madeora. The database decides what is whose and every
// outcome (tests/db/rls/google-calendar-outbound.test.sql); these tests check that each route validates its
// input, refuses cross-site and signed-out requests before the database, passes the right arguments, and
// maps the database's answers to HTTP.
import { PUT as saveTarget } from "@/app/api/v1/integrations/google-calendar/target/route";
import { POST as changeAction } from "@/app/api/v1/integrations/google-calendar/changes/[changeId]/route";
import { DELETE as restoreHidden } from "@/app/api/v1/integrations/google-calendar/hidden/[exclusionId]/route";

import { DELETE as deleteEvent, PATCH as updateEvent } from "./[eventId]/route";
import { POST as createEvent } from "./route";

const USER = "0c0b0000-0000-4000-8000-000000000001";
const CALENDAR = "0c0b0000-0000-4000-8000-000000000002";
const EVENT = "0c0b0000-0000-4000-8000-000000000003";
const CHANGE = "0c0b0000-0000-4000-8000-000000000004";
const REQUEST = "0c0b0000-0000-4000-8000-000000000005";

const state = vi.hoisted(() => ({
  identity: null as { userId: string } | null,
  rpc: vi.fn<(name: string, args?: Record<string, unknown>) => { data: unknown; error: unknown }>(),
}));

vi.mock("@/auth/identity", () => ({
  getVerifiedIdentity: () => Promise.resolve(state.identity),
}));
vi.mock("@/auth/supabase-server", () => ({
  createSupabaseServerClient: () =>
    Promise.resolve({
      rpc: (name: string, args?: Record<string, unknown>) => Promise.resolve(state.rpc(name, args)),
    }),
}));
vi.mock("@madeora/config/env/public", () => ({
  getPublicEnv: () => ({ NEXT_PUBLIC_APP_URL: "https://madeora.example" }),
}));

const sameOrigin = { origin: "https://madeora.example", host: "madeora.example" };
const crossSite = { origin: "https://evil.example", host: "madeora.example" };

function request(path: string, method: string, body: unknown, headers = sameOrigin): Request {
  return new Request(`https://madeora.example${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function answers(outcomes: Record<string, unknown>) {
  state.rpc.mockImplementation((name) =>
    name in outcomes
      ? { data: outcomes[name], error: null }
      : { data: null, error: { code: "XX000", message: "unexpected" } },
  );
}

const fields = {
  title: "Dentist",
  location: "",
  description: "",
  allDay: false,
  startsOn: "2026-11-20",
  endsOn: "2026-11-20",
  startTime: "09:00",
  endTime: "10:00",
  timezone: "Europe/Brussels",
};
/** The fields as the schema passes them on (empty text becomes null). */
const sent = { ...fields, location: null, description: null };
const eventParams = { params: Promise.resolve({ eventId: EVENT }) };
const changeParams = { params: Promise.resolve({ changeId: CHANGE }) };

beforeEach(() => {
  state.identity = { userId: USER };
  state.rpc.mockReset();
});

describe("creating a Google event", () => {
  const body = { requestId: REQUEST, calendarId: CALENDAR, event: fields };

  it("creates it once: 201 the first time, 200 for the same request again", async () => {
    answers({ create_google_calendar_event: { outcome: "created", eventId: EVENT } });
    const created = await createEvent(request("/api/v1/calendar/google-events", "POST", body));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ outcome: "created", eventId: EVENT });
    expect(state.rpc).toHaveBeenCalledWith("create_google_calendar_event", {
      p_request_id: REQUEST,
      p_calendar_id: CALENDAR,
      p_event: sent,
    });
    answers({ create_google_calendar_event: { outcome: "exists", eventId: EVENT } });
    expect(
      (await createEvent(request("/api/v1/calendar/google-events", "POST", body))).status,
    ).toBe(200);
  });

  it.each([
    ["not_found", 404, "not-found"],
    ["read_only", 409, "read-only"],
    ["authorization_expired", 409, "authorization-expired"],
    ["limit_reached", 409, "limit-reached"],
    ["invalid_dates", 400, "invalid-dates"],
    ["nonexistent_time", 400, "nonexistent-time"],
  ])("answers %s with %i", async (outcome, status, code) => {
    answers({ create_google_calendar_event: { outcome } });
    const response = await createEvent(request("/api/v1/calendar/google-events", "POST", body));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  it("refuses a reminder, shares or participants, cross-site and signed-out requests", async () => {
    for (const extra of [{ reminder: 10 }, { shares: [] }, { participants: [] }]) {
      const response = await createEvent(
        request("/api/v1/calendar/google-events", "POST", {
          ...body,
          event: { ...fields, ...extra },
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(
      (await createEvent(request("/api/v1/calendar/google-events", "POST", body, crossSite)))
        .status,
    ).toBe(403);
    state.identity = null;
    expect(
      (await createEvent(request("/api/v1/calendar/google-events", "POST", body))).status,
    ).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("changing a Google event", () => {
  const path = `/api/v1/calendar/google-events/${EVENT}`;
  const body = { scope: "following", revision: 3, event: fields, dryRun: true };

  it("passes the scope, revision and dry run, and answers the preview", async () => {
    const preview = {
      outcome: "preview",
      count: 2,
      dates: ["2026-11-20", "2026-11-27"],
      beyondWindow: true,
    };
    answers({ update_google_calendar_event: preview });
    const response = await updateEvent(request(path, "PATCH", body), eventParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(preview);
    expect(state.rpc).toHaveBeenCalledWith("update_google_calendar_event", {
      p_event_id: EVENT,
      p_scope: "following",
      p_revision: 3,
      p_event: sent,
      p_dry_run: true,
    });
  });

  it.each([
    ["stale", 409, "stale"],
    ["busy", 409, "busy"],
    ["conflict_open", 409, "conflict-open"],
    ["series_limit", 409, "series-limit"],
    ["invalid_scope", 400, "invalid-scope"],
    ["not_found", 404, "not-found"],
  ])("answers %s with %i", async (outcome, status, code) => {
    answers({ update_google_calendar_event: { outcome } });
    const response = await updateEvent(request(path, "PATCH", body), eventParams);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  it("refuses a repeat rule, an unknown scope and a malformed id", async () => {
    const repeat = { frequency: "daily", interval: 1, weekdays: null, endsOn: null, count: null };
    expect(
      (
        await updateEvent(
          request(path, "PATCH", { ...body, event: { ...fields, repeat } }),
          eventParams,
        )
      ).status,
    ).toBe(400);
    expect(
      (await updateEvent(request(path, "PATCH", { ...body, scope: "only" }), eventParams)).status,
    ).toBe(400);
    const bad = { params: Promise.resolve({ eventId: "nope" }) };
    expect((await updateEvent(request(path, "PATCH", body), bad)).status).toBe(404);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("deleting a Google event", () => {
  const path = `/api/v1/calendar/google-events/${EVENT}`;

  it("passes where it goes and answers removed or deleting", async () => {
    answers({ delete_google_calendar_event: { outcome: "removed" } });
    const body = { scope: "all", destination: "madeora", revision: 2 };
    const response = await deleteEvent(request(path, "DELETE", body), eventParams);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "removed" });
    expect(state.rpc).toHaveBeenCalledWith("delete_google_calendar_event", {
      p_event_id: EVENT,
      p_scope: "all",
      p_destination: "madeora",
      p_revision: 2,
      p_dry_run: false,
    });
    answers({ delete_google_calendar_event: { outcome: "deleting" } });
    expect(
      (
        await deleteEvent(
          request(path, "DELETE", { ...body, destination: "everywhere" }),
          eventParams,
        )
      ).status,
    ).toBe(200);
    answers({ delete_google_calendar_event: { outcome: "read_only" } });
    expect(
      (
        await deleteEvent(
          request(path, "DELETE", { ...body, destination: "everywhere" }),
          eventParams,
        )
      ).status,
    ).toBe(409);
  });

  it("refuses a delete without a destination", async () => {
    const response = await deleteEvent(
      request(path, "DELETE", { scope: "event", revision: 2 }),
      eventParams,
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("the person's answers to a change", () => {
  const path = `/api/v1/integrations/google-calendar/changes/${CHANGE}`;

  it("sends a conflict choice, try again and discard to their own functions", async () => {
    answers({ resolve_google_calendar_conflict: "resolved" });
    const resolved = await changeAction(
      request(path, "POST", { action: "resolve", choice: "google" }),
      changeParams,
    );
    expect(resolved.status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("resolve_google_calendar_conflict", {
      p_change_id: CHANGE,
      p_choice: "google",
    });
    answers({ retry_google_calendar_change: "queued" });
    expect(
      (await changeAction(request(path, "POST", { action: "retry" }), changeParams)).status,
    ).toBe(200);
    answers({ discard_google_calendar_change: "in_conflict" });
    const refused = await changeAction(request(path, "POST", { action: "discard" }), changeParams);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "in-conflict" });
  });

  it("refuses an unknown choice", async () => {
    const response = await changeAction(
      request(path, "POST", { action: "resolve", choice: "newest" }),
      changeParams,
    );
    expect(response.status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("target calendar and restoring hidden events", () => {
  it("saves the target, or Madeora only", async () => {
    answers({ set_google_calendar_write_target: "saved" });
    const path = "/api/v1/integrations/google-calendar/target";
    expect((await saveTarget(request(path, "PUT", { calendarId: CALENDAR }))).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("set_google_calendar_write_target", {
      p_calendar_id: CALENDAR,
    });
    expect((await saveTarget(request(path, "PUT", { calendarId: null }))).status).toBe(200);
    answers({ set_google_calendar_write_target: "read_only" });
    expect((await saveTarget(request(path, "PUT", { calendarId: CALENDAR }))).status).toBe(409);
  });

  it("restores a hidden event, and answers not found for someone else's", async () => {
    const path = `/api/v1/integrations/google-calendar/hidden/${CHANGE}`;
    const params = { params: Promise.resolve({ exclusionId: CHANGE }) };
    answers({ restore_google_calendar_event: "restored" });
    expect((await restoreHidden(request(path, "DELETE", {}), params)).status).toBe(200);
    answers({ restore_google_calendar_event: "not_found" });
    expect((await restoreHidden(request(path, "DELETE", {}), params)).status).toBe(404);
  });
});
