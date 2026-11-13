import { buildOverview } from "./build";
import { calendar, chore, chores, input, occurrence, ME, OTHER, task, tasks } from "./fixtures";

const week = { scope: "week", from: "2026-11-16", to: "2026-11-22" } as const;

describe("overview: arranging a day", () => {
  it("puts timed events in time order and everything else apart", () => {
    const overview = buildOverview(
      input({
        calendar: {
          status: "ok",
          value: calendar([
            occurrence({ title: "Late", startsAt: "2026-11-16T15:00:00.000Z" }),
            occurrence({ title: "Early", startsAt: "2026-11-16T07:00:00.000Z" }),
            occurrence({ title: "Birthday", allDay: true, startsAt: null, endsAt: null }),
          ]),
        },
        tasks: { status: "ok", value: tasks([task({ title: "Pay rent" })]) },
        chores: { status: "ok", value: chores([chore({ title: "Vacuum" })]) },
      }),
    );
    const [day] = overview.days;
    expect(day?.timed.map((item) => item.title)).toEqual(["Early", "Late"]);
    expect(day?.untimed.map((item) => item.title)).toEqual(["Birthday", "Pay rent", "Vacuum"]);
    expect(day?.counts).toEqual({ calendar: 3, tasks: 1, chores: 1 });
    expect(overview.empty).toBeNull();
  });

  it("counts a synced Google copy of the same commitment once", () => {
    const own = occurrence({ title: "Dentist" });
    const copy = occurrence({ title: "dentist ", source: "google", calendar: "Work" });
    const overview = buildOverview(
      input({ calendar: { status: "ok", value: calendar([copy, own]) } }),
    );
    const items = overview.days[0]?.timed ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.origin).toBe("own");
  });

  it("treats completed tasks and chores as done and leaves out skipped, expired and paused chores", () => {
    const overview = buildOverview(
      input({
        tasks: {
          status: "ok",
          value: tasks([
            task({ title: "Done task", completed: true }),
            task({ title: "Late", overdue: true }),
          ]),
        },
        chores: {
          status: "ok",
          value: chores([
            chore({ title: "Done chore", status: "completed" }),
            chore({ title: "Skipped", status: "skipped" }),
            chore({ title: "Expired", status: "expired" }),
            chore({ title: "Paused", status: "paused" }),
            chore({ title: "Review", status: "pending_approval" }),
          ]),
        },
      }),
    );
    const byTitle = Object.fromEntries(
      (overview.days[0]?.untimed ?? []).map((item) => [item.title, item.status]),
    );
    expect(byTitle).toEqual({
      "Done task": "done",
      Late: "overdue",
      "Done chore": "done",
      Review: "pending",
    });
  });

  it("ignores a task's start marker and anything outside the range", () => {
    const overview = buildOverview(
      input({
        tasks: {
          status: "ok",
          value: tasks([
            task({ title: "Starts", role: "start" }),
            task({ title: "Tomorrow", date: "2026-11-17" }),
          ]),
        },
      }),
    );
    expect(overview.days[0]?.counts.tasks).toBe(0);
    expect(overview.empty).toBe("none");
  });

  it("shows a multi-day event on every day it covers, timed only on its first", () => {
    const overview = buildOverview(
      input({
        ...week,
        calendar: {
          status: "ok",
          value: calendar([occurrence({ title: "Trip", from: "2026-11-17", to: "2026-11-19" })]),
        },
      }),
    );
    const days = overview.days.filter((day) => day.counts.calendar > 0);
    expect(days.map((day) => day.date)).toEqual(["2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(days[0]?.timed).toHaveLength(1);
    expect(days[1]?.untimed).toHaveLength(1);
  });
});

describe("overview: filters", () => {
  const sources = {
    calendar: {
      status: "ok",
      value: calendar([
        occurrence({ title: "Mine", participants: [ME] }),
        occurrence({ title: "Theirs", participants: [OTHER] }),
      ]),
    },
    tasks: {
      status: "ok",
      value: tasks([
        task({ title: "My task", assigneeIds: [ME] }),
        task({ title: "Their task", assigneeIds: [OTHER], completed: true }),
      ]),
    },
    chores: { status: "ok", value: chores([chore({ title: "Nobody's", assigneeIds: [null] })]) },
  } as const;

  const titles = (filters: Partial<Parameters<typeof input>[0] extends infer I ? I : never>) =>
    buildOverview(input({ ...sources, ...filters }));
  const all = (overview: ReturnType<typeof buildOverview>) =>
    overview.days
      .flatMap((day) => [...day.timed, ...day.untimed])
      .map((item) => item.title)
      .sort();

  it("limits by module", () => {
    const overview = titles({
      filters: { modules: ["tasks"], assignee: "anyone", completion: "all" },
    });
    expect(all(overview)).toEqual(["My task", "Their task"]);
  });

  it("limits to the viewer or to a chosen member", () => {
    expect(all(titles({ filters: { modules: [], assignee: "me", completion: "all" } }))).toEqual([
      "Mine",
      "My task",
    ]);
    expect(
      all(
        titles({ filters: { modules: [], assignee: "member", member: OTHER, completion: "all" } }),
      ),
    ).toEqual(["Their task", "Theirs"]);
  });

  it("matches nobody for an unknown member and never falls back to everyone", () => {
    const overview = titles({
      filters: {
        modules: [],
        assignee: "member",
        member: "6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00ff",
        completion: "all",
      },
    });
    expect(all(overview)).toEqual([]);
    expect(overview.empty).toBe("filtered");
  });

  it("limits by completion, and calendar entries have no completion", () => {
    expect(
      all(titles({ filters: { modules: [], assignee: "anyone", completion: "done" } })),
    ).toEqual(["Their task"]);
    expect(
      all(titles({ filters: { modules: [], assignee: "anyone", completion: "open" } })),
    ).toEqual(["Mine", "My task", "Nobody's", "Theirs"]);
  });
});

describe("overview: sources that are missing", () => {
  it("leaves a module the person may not use out silently", () => {
    const overview = buildOverview(input({ tasks: { status: "off" }, chores: { status: "off" } }));
    expect(overview.modules).toEqual(["calendar"]);
    expect(overview.notices).toEqual([]);
    expect(overview.incomplete).toBe(false);
  });

  it("discloses a source that failed and never calls the day free", () => {
    const overview = buildOverview(
      input({
        calendar: { status: "unavailable" },
        tasks: { status: "ok", value: tasks([task({ title: "Pay rent" })]) },
      }),
    );
    expect(overview.incomplete).toBe(true);
    expect(overview.notices).toEqual([
      { kind: "unavailable", module: "calendar", source: null, lastSyncedAt: null },
    ]);
    expect(overview.days[0]?.counts.tasks).toBe(1);

    const nothing = buildOverview(
      input({ calendar: { status: "unavailable" }, tasks: { status: "unavailable" } }),
    );
    expect(nothing.empty).toBe("incomplete");
  });

  it("discloses out-of-date Google calendars, naming only the viewer's own", () => {
    const overview = buildOverview(
      input({
        calendar: {
          status: "ok",
          value: calendar([], {
            googleWarnings: [
              {
                calendar: "Work",
                own: true,
                sharedBy: null,
                state: "stale",
                lastSyncedAt: "2026-11-15T08:00:00Z",
              },
              {
                calendar: "Secret",
                own: false,
                sharedBy: OTHER,
                state: "out_of_date",
                lastSyncedAt: null,
              },
            ],
          }),
        },
      }),
    );
    expect(overview.notices).toEqual([
      { kind: "stale", module: "calendar", source: "Work", lastSyncedAt: "2026-11-15T08:00:00Z" },
      { kind: "unverified", module: "calendar", source: null, lastSyncedAt: null },
    ]);
    expect(JSON.stringify(overview)).not.toContain("Secret");
    expect(overview.empty).toBe("incomplete");
  });

  it("treats a truncated read as incomplete", () => {
    const overview = buildOverview(
      input({ tasks: { status: "ok", value: tasks([task()], true) } }),
    );
    expect(overview.truncated).toBe(true);
    expect(overview.incomplete).toBe(true);
  });
});

describe("overview: empty states", () => {
  it("tells apart nothing, nothing matching the filters and incomplete", () => {
    expect(buildOverview(input()).empty).toBe("none");
    expect(
      buildOverview(
        input({ filters: { modules: ["tasks"], assignee: "anyone", completion: "all" } }),
      ).empty,
    ).toBe("filtered");
  });
});

describe("overview: busy days", () => {
  const dense = (count: number, date: string) =>
    Array.from({ length: count }, (_, index) =>
      occurrence({
        title: `E${date}${String(index)}`,
        from: date,
        to: date,
        startsAt: `${date}T0${String(index)}:00:00.000Z`,
        endsAt: `${date}T0${String(index)}:30:00.000Z`,
      }),
    );

  it("points out a day that is clearly busier than the rest", () => {
    const overview = buildOverview(
      input({
        ...week,
        calendar: {
          status: "ok",
          value: calendar([
            ...dense(6, "2026-11-18"),
            ...dense(1, "2026-11-16"),
            ...dense(1, "2026-11-20"),
          ]),
        },
      }),
    );
    expect(overview.days.filter((day) => day.busier).map((day) => day.date)).toEqual([
      "2026-11-18",
    ]);
  });

  it("says nothing for an evenly spread week or a day view", () => {
    const even = buildOverview(
      input({
        ...week,
        calendar: {
          status: "ok",
          value: calendar([
            ...dense(2, "2026-11-16"),
            ...dense(2, "2026-11-17"),
            ...dense(2, "2026-11-18"),
          ]),
        },
      }),
    );
    expect(even.days.some((day) => day.busier)).toBe(false);
    const day = buildOverview(
      input({ calendar: { status: "ok", value: calendar(dense(6, "2026-11-16")) } }),
    );
    expect(day.days.some((entry) => entry.busier)).toBe(false);
  });

  it("makes no comparison on a subset or on incomplete data", () => {
    const calendarValue = calendar([...dense(6, "2026-11-18"), ...dense(1, "2026-11-16")]);
    const filtered = buildOverview(
      input({
        ...week,
        calendar: { status: "ok", value: calendarValue },
        filters: { modules: ["calendar"], assignee: "anyone", completion: "all" },
      }),
    );
    expect(filtered.days.some((day) => day.busier)).toBe(false);
    const partial = buildOverview(
      input({
        ...week,
        calendar: { status: "ok", value: calendarValue },
        tasks: { status: "unavailable" },
      }),
    );
    expect(partial.days.some((day) => day.busier)).toBe(false);
  });
});
