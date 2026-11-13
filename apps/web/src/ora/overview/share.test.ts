import { buildOverview } from "./build";
import { chore, chores, HOME, input, occurrence, calendar, task, tasks } from "./fixtures";
import { audienceMayView, composeShareText, itemsForAudience, type ShareLabels } from "./share";

const labels: ShareLabels = {
  title: ({ from }) => `Overview ${from}`,
  context: (home) => `Home: ${home}`,
  audience: (name) => `For: ${name}`,
  day: (date) => date,
  allDay: "All day",
  noTime: "No set time",
  done: "done",
  module: (module) => module,
  time: (item) => item.startsAt?.slice(11, 16) ?? null,
  empty: "Nothing.",
  incomplete: "Incomplete.",
  leftOut: "Some information may be left out.",
};

const overview = buildOverview(
  input({
    calendar: {
      status: "ok",
      value: calendar([
        occurrence({ title: "Family dinner" }),
        occurrence({ title: "My therapy", kind: "shared", sharedBy: "x" }),
        occurrence({ title: "My own personal thing", kind: "personal" }),
        occurrence({ title: "Work meeting", source: "google", calendar: "Work" }),
      ]),
    },
    tasks: {
      status: "ok",
      value: tasks([
        task({ title: "Pay rent", assigneeIds: ["6f2c1f0e-1d7a-4b8e-9c55-2b2f6b0a00a1"] }),
      ]),
    },
    chores: { status: "ok", value: chores([chore({ title: "Vacuum" })]) },
  }),
);

describe("sharing: who may see what", () => {
  it("keeps only the Home's own events, tasks and chores", () => {
    const titles = itemsForAudience(overview, { id: "a", role: "member" }).map(
      (item) => item.title,
    );
    expect(titles.sort()).toEqual(["Family dinner", "Pay rent", "Vacuum"]);
  });

  it("shares nothing from the Personal space", () => {
    const personal = buildOverview(input({ homeId: null }));
    expect(itemsForAudience(personal, { id: "a", role: "member" })).toEqual([]);
  });

  it("asks the permission engine about the audience's own role", () => {
    for (const role of ["owner", "administrator", "member"] as const) {
      for (const source of ["calendar", "tasks", "chores"] as const) {
        expect(audienceMayView(HOME, { id: "a", role }, source)).toBe(true);
      }
    }
  });
});

describe("sharing: the proposed text", () => {
  const text = composeShareText(
    overview,
    { id: "a", role: "member", name: "Sam" },
    "Thuis",
    labels,
  );

  it("names the audience and Home, lists what is allowed, and warns it may be incomplete", () => {
    expect(text).toContain("Home: Thuis");
    expect(text).toContain("For: Sam");
    expect(text).toContain("Family dinner (calendar)");
    expect(text).toContain("No set time: Pay rent (tasks)");
    expect(text).toContain("Some information may be left out.");
  });

  it("never contains what was left out, nor assignees or private markers", () => {
    for (const hidden of ["therapy", "personal thing", "Work meeting", "6f2c1f0e", "Work"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("flags incomplete sources and handles an empty result", () => {
    const partial = buildOverview(input({ calendar: { status: "unavailable" } }));
    const body = composeShareText(
      partial,
      { id: "a", role: "member", name: "Sam" },
      "Thuis",
      labels,
    );
    expect(body).toContain("Incomplete.");
    expect(body).toContain("Nothing.");
  });
});
