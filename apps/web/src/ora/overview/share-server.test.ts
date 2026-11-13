import { HOME, ME, OTHER } from "./fixtures";
import { prepareShare } from "./share-server";
import type { Overview, OverviewItem } from "./types";

interface State {
  members: Record<string, unknown>[];
  overview: unknown;
  homeStatus: "ok" | "not-found" | "unavailable";
  loads: number;
}
const state = vi.hoisted((): State => ({
  members: [],
  overview: null,
  homeStatus: "ok",
  loads: 0,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/homes/server", () => ({
  getHomeContext: () =>
    Promise.resolve(
      state.homeStatus === "ok"
        ? { status: "ok", context: { home: { id: HOME, name: "Thuis", timeZone: "UTC" } } }
        : { status: state.homeStatus },
    ),
}));
vi.mock("@/members/directory", () => ({
  getHomeDirectory: () => Promise.resolve({ status: "ok", members: state.members }),
}));
vi.mock("./server", () => ({
  loadOverview: () => {
    state.loads += 1;
    return Promise.resolve({ status: "ok", overview: state.overview });
  },
}));
vi.mock("@/preferences/server", () => ({
  getRegionalFormats: () =>
    Promise.resolve({ effective: { dateFormat: "dmy-slash", timeFormat: "24h" } }),
}));
vi.mock("next-intl/server", () => ({
  getLocale: () => Promise.resolve("en"),
  getTranslations: () => Promise.resolve((key: string) => key),
}));

const item = (
  title: string,
  module: "calendar" | "tasks",
  origin: "own" | "personal",
): OverviewItem => ({
  key: title,
  module,
  title,
  day: "2026-11-16",
  allDay: false,
  startsAt: module === "calendar" ? "2026-11-16T09:00:00.000Z" : null,
  endsAt: null,
  timeZone: "UTC",
  status: "open",
  href: "/x",
  origin,
  assigneeIds: [],
  canComplete: false,
});

const member = { homeId: HOME, role: "member" as const, grantedCapabilities: new Set<never>() };
const context = { home: { id: HOME, membership: member } };
const request = {
  request: {
    target: "today" as const,
    filters: { modules: [], assignee: "anyone" as const, completion: "all" as const },
  },
  audience: OTHER,
};
const person = (id: string, extra: Record<string, unknown> = {}) => ({
  membershipId: id,
  role: "member",
  isSelf: false,
  isInactive: false,
  name: "Sam",
  ...extra,
});

beforeEach(() => {
  state.loads = 0;
  state.homeStatus = "ok";
  state.members = [person(ME, { isSelf: true, name: "Alex" }), person(OTHER)];
  state.overview = {
    homeId: HOME,
    scope: "day",
    from: "2026-11-16",
    to: "2026-11-16",
    today: "2026-11-16",
    timeZone: "UTC",
    incomplete: false,
    days: [
      {
        date: "2026-11-16",
        counts: { calendar: 2, tasks: 1, chores: 0 },
        busier: false,
        timed: [
          item("Family dinner", "calendar", "own"),
          item("Private therapy", "calendar", "personal"),
        ],
        untimed: [item("Pay rent", "tasks", "own")],
      },
    ],
  } satisfies Partial<Overview>;
});

describe("preparing a shared text", () => {
  it("includes only what the audience may see and leaves out personal events", async () => {
    const result = await prepareShare(context, request);
    if (result.status !== "ok") throw new Error("not ok");
    expect(result.share.text).toContain("Family dinner");
    expect(result.share.text).toContain("Pay rent");
    expect(result.share.text).not.toContain("Private therapy");
    expect(result.share.audience).toEqual({ id: OTHER, name: "Sam" });
  });

  it.each([
    ["the requester themselves", [person(ME, { isSelf: true })], ME],
    ["a deactivated member", [person(OTHER, { isInactive: true })], OTHER],
    ["a child", [person(OTHER, { isChild: true })], OTHER],
    ["someone who is not a member of this Home", [person(ME, { isSelf: true })], OTHER],
  ])(
    "refuses %s as an audience, without reading the overview",
    async (_name, members, audience) => {
      state.members = members;
      const result = await prepareShare(context, { ...request, audience });
      expect(result).toEqual({ status: "invalid" });
      expect(state.loads).toBe(0);
    },
  );

  it("refuses Personal space and a Home the person is no longer in", async () => {
    expect(await prepareShare({ home: null }, request)).toEqual({ status: "invalid" });
    state.homeStatus = "not-found";
    expect(await prepareShare(context, request)).toEqual({ status: "invalid" });
  });

  it("reads everything again on every call, so a change shows up in the next text", async () => {
    await prepareShare(context, request);
    state.members = [person(ME, { isSelf: true })];
    expect(await prepareShare(context, request)).toEqual({ status: "invalid" });
    expect(state.loads).toBe(1);
  });
});
