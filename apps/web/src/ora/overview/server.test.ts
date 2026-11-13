import { calendar, chores, HOME, ME, OTHER, task, tasks } from "./fixtures";
import { loadOverview } from "./server";

const calls = vi.hoisted(() => ({
  calendar: [] as unknown[][],
  tasks: [] as unknown[][],
  chores: [] as unknown[][],
  failing: new Set<string>(),
  denied: new Set<string>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/calendar/data", () => ({
  readCalendar: (...args: unknown[]) => {
    calls.calendar.push(args);
    if (calls.denied.has("calendar")) return Promise.resolve({ status: "not-found" });
    if (calls.failing.has("calendar")) return Promise.resolve({ status: "unavailable" });
    return Promise.resolve({ status: "ok", value: calendarValue() });
  },
}));
vi.mock("@/tasks/data", () => ({
  listTaskCalendar: (...args: unknown[]) => {
    calls.tasks.push(args);
    if (calls.failing.has("tasks")) return Promise.resolve({ status: "unavailable" });
    return Promise.resolve({ status: "ok", value: tasks([task({ title: "Pay rent" })]) });
  },
}));
vi.mock("@/chores/data", () => ({
  listChoreSchedule: (...args: unknown[]) => {
    calls.chores.push(args);
    return Promise.resolve({ status: "ok", value: chores([]) });
  },
}));
vi.mock("@/homes/server", () => ({
  getHomeContext: () =>
    Promise.resolve({
      status: "ok",
      context: { home: { id: HOME, name: "Thuis", timeZone: "Europe/Brussels" } },
    }),
}));
vi.mock("@/members/directory", () => ({
  getHomeDirectory: () =>
    Promise.resolve({
      status: "ok",
      members: [
        { membershipId: ME, role: "member", isSelf: true, name: "Alex", isInactive: false },
        { membershipId: OTHER, role: "member", isSelf: false, name: "Sam", isInactive: false },
        {
          membershipId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a3",
          role: "member",
          isSelf: false,
          name: "Kid",
          isInactive: false,
          isChild: true,
        },
        {
          membershipId: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a4",
          role: "member",
          isSelf: false,
          name: "Gone",
          isInactive: true,
        },
      ],
    }),
}));
vi.mock("@/preferences/server", () => ({
  getEffectiveTimeZone: () => Promise.resolve({ timeZone: "Europe/Brussels" }),
  getRegionalFormats: () =>
    Promise.resolve({
      effective: { weekStart: "monday", dateFormat: "dmy-slash", timeFormat: "24h" },
    }),
}));

const calendarValue = () => calendar([]);

const member = { homeId: HOME, role: "member" as const, grantedCapabilities: new Set<never>() };
const inHome = { home: { id: HOME, membership: member } };
const request = {
  target: "today" as const,
  filters: { modules: [], assignee: "anyone" as const, completion: "all" as const },
};

beforeEach(() => {
  calls.calendar = [];
  calls.tasks = [];
  calls.chores = [];
  calls.failing.clear();
  calls.denied.clear();
});

describe("loading an overview", () => {
  it("reads every module in a Home with the person's own session and lists who can be an audience", async () => {
    const result = await loadOverview(inHome, request);
    if (result.status !== "ok") throw new Error("not ok");
    expect(calls.calendar).toHaveLength(1);
    expect(calls.tasks).toHaveLength(1);
    expect(calls.chores).toHaveLength(1);
    expect(result.overview.modules).toEqual(["calendar", "tasks", "chores"]);
    // A child is a member but never a shareable audience; a deactivated member is not listed.
    expect(result.overview.members).toEqual([
      { id: ME, name: "Alex", isSelf: true, shareable: false },
      { id: OTHER, name: "Sam", isSelf: false, shareable: true },
      {
        id: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a3",
        name: "Kid",
        isSelf: false,
        shareable: false,
      },
    ]);
  });

  it("has no chores and no assignee filters in Personal space", async () => {
    const result = await loadOverview(
      { home: null },
      {
        target: "today",
        filters: { modules: [], assignee: "me", completion: "all" },
      },
    );
    if (result.status !== "ok") throw new Error("not ok");
    expect(calls.chores).toHaveLength(0);
    expect(result.overview.modules).toEqual(["calendar", "tasks"]);
    expect(result.overview.filters.assignee).toBe("anyone");
    expect(result.overview.members).toEqual([]);
  });

  it("leaves out a module the database says is not theirs, without a notice", async () => {
    calls.denied.add("calendar");
    const result = await loadOverview(inHome, request);
    if (result.status !== "ok") throw new Error("not ok");
    expect(result.overview.modules).toEqual(["tasks", "chores"]);
    expect(result.overview.notices).toEqual([]);
  });

  it("discloses a module that failed and keeps the others", async () => {
    calls.failing.add("tasks");
    const result = await loadOverview(inHome, request);
    if (result.status !== "ok") throw new Error("not ok");
    expect(result.overview.incomplete).toBe(true);
    expect(result.overview.notices.map((notice) => notice.module)).toEqual(["tasks"]);
  });

  it("covers the picked week with seven calendar dates for the reads", async () => {
    await loadOverview(inHome, { ...request, target: "week", date: "2026-12-30" });
    expect(calls.calendar[0]).toEqual([HOME, "2026-12-28", "2027-01-03"]);
    expect(calls.chores[0]).toEqual([HOME, "2026-12-28", "2027-01-03"]);
  });
});
